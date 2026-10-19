import { randomUUID } from "node:crypto";
import { BRIDGE_TTL_MS, EXTENSION_ORIGIN } from "./chrome-bridge.js";

const hash=/^[a-f0-9]{64}$/;
const routes=new Set(["new","project-new","existing"]);
const ident=/^[a-z0-9-]{36}$/i;
const nonblank=(v,n)=>typeof v==="string"&&v.length>0&&v.length<=n;
const elapsed=(at,now)=>Number.isSafeInteger(at)&&at<=now+5000&&
  now-at>=-5000&&now-at<=BRIDGE_TTL_MS;

// Local-only candidate inventory and one-use registration intents.
// They do not themselves grant permission to send prompts.
export class ChromeEnrollment {
  constructor(store,{bridge}){
    this.store=store;this.db=store.db;this.bridge=bridge;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS chrome_discovery_candidates (",
      "extension_id TEXT NOT NULL REFERENCES chrome_clients(extension_id) ON DELETE CASCADE,",
      "tab_id INTEGER NOT NULL,group_id INTEGER NOT NULL,window_id INTEGER NOT NULL,",
      "url_hash TEXT NOT NULL,group_label TEXT NOT NULL,title TEXT NOT NULL,",
      "route TEXT NOT NULL,reported_at INTEGER NOT NULL,",
      "PRIMARY KEY(extension_id,tab_id)) STRICT;",
      "CREATE TABLE IF NOT EXISTS chrome_enrollment_intents (",
      "id TEXT PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,",
      "extension_id TEXT NOT NULL REFERENCES chrome_clients(extension_id) ON DELETE CASCADE,",
      "tab_id INTEGER NOT NULL,group_id INTEGER NOT NULL,window_id INTEGER NOT NULL,",
      "url_hash TEXT NOT NULL,route TEXT NOT NULL,",
      "created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,",
      "status TEXT NOT NULL,reason TEXT NOT NULL) STRICT;"
    ].join(" "));
  }
  ingest(extensionId,payload,now=Date.now()){
    if(payload.candidates===undefined)return;
    const items=payload.candidates;
    if(!Array.isArray(items)||items.length>80)throw Error("CHROME_DISCOVERY_INVALID");
    const seen=new Set();
    const normalized=items.map(x=>{
      if(!x||!Number.isSafeInteger(x.tabId)||x.tabId<0||
         !Number.isSafeInteger(x.groupId)||x.groupId<0||
         !Number.isSafeInteger(x.windowId)||x.windowId<0||
         !hash.test(x.urlHash||"")||!routes.has(x.route)||
         seen.has(x.tabId)||typeof x.groupLabel!=="string"||
         x.groupLabel.length>120||typeof x.title!=="string"||
         x.title.length>200)
        throw Error("CHROME_DISCOVERY_INVALID");
      seen.add(x.tabId);
      return x;
    });
    this.store.transaction(()=>{
      this.db.prepare("DELETE FROM chrome_discovery_candidates WHERE extension_id=?")
        .run(extensionId);
      const add=this.db.prepare(
        "INSERT INTO chrome_discovery_candidates(extension_id,tab_id,group_id,"+
        "window_id,url_hash,group_label,title,route,reported_at) VALUES(?,?,?,?,?,?,?,?,?)"
      );
      for(const x of normalized)add.run(extensionId,x.tabId,x.groupId,x.windowId,
        x.urlHash,x.groupLabel,x.title,x.route,now);
    });
  }
  begin(workstreamId,extensionId,tabId,expectedHash,now=Date.now()){
    this.store.mustGet(workstreamId);
    if(!EXTENSION_ORIGIN.test("chrome-extension://"+extensionId)||
       !Number.isSafeInteger(tabId)||!hash.test(expectedHash||""))
      throw Error("CHROME_ENROLLMENT_INVALID_SELECTION");
    const links=this.bridge.getSnapshot(now).links;
    if(links.some(l=>l.workstreamId===workstreamId))
      throw Error("CHROME_ENROLLMENT_WORKSTREAM_ALREADY_LINKED");
    const client=this.bridge.getSnapshot(now).clients.find(c=>
      c.extensionId===extensionId&&c.status==="online");
    if(!client)throw Error("CHROME_ENROLLMENT_EXTENSION_OFFLINE");
    const candidate=this.db.prepare(
      "SELECT * FROM chrome_discovery_candidates WHERE extension_id=? AND tab_id=?"
    ).get(extensionId,tabId);
    if(!candidate||candidate.url_hash!==expectedHash||
       !elapsed(candidate.reported_at,now))
      throw Error("CHROME_ENROLLMENT_STALE_OR_CHANGED_TAB");
    const prior=this.db.prepare(
      "SELECT id FROM chrome_enrollment_intents WHERE workstream_id=? "+
      "AND status='pending' AND expires_at>=?"
    ).get(workstreamId,now);
    if(prior)throw Error("CHROME_ENROLLMENT_ALREADY_PENDING");
    const id=randomUUID(),expiresAt=now+5*60_000;
    this.db.prepare(
      "INSERT INTO chrome_enrollment_intents(id,workstream_id,extension_id,"+
      "tab_id,group_id,window_id,url_hash,route,created_at,expires_at,status,reason) "+
      "VALUES(?,?,?,?,?,?,?,?,?,?,'pending','')"
    ).run(id,workstreamId,extensionId,tabId,candidate.group_id,
      candidate.window_id,candidate.url_hash,candidate.route,now,expiresAt);
    this.store.event(workstreamId,now,"chrome_enrollment_requested",null,null,
      "operator_selected_discovered_tab");
    return {id,workstreamId,status:"pending",expiresAt};
  }
  pending(extensionId,now=Date.now()){
    return this.db.prepare(
      "SELECT id,tab_id AS tabId,group_id AS groupId,window_id AS windowId,"+
      "url_hash AS urlHash,route FROM chrome_enrollment_intents "+
      "WHERE extension_id=? AND status='pending' AND expires_at>=? "+
      "ORDER BY created_at LIMIT 8"
    ).all(extensionId,now);
  }
  acknowledge(extensionId,payload,now=Date.now()){
    if(!payload||!ident.test(payload.id||"")||
       !["applied","refused"].includes(payload.status))
      throw Error("CHROME_ENROLLMENT_ACK_INVALID");
    const row=this.db.prepare(
      "SELECT * FROM chrome_enrollment_intents WHERE id=? AND extension_id=?"
    ).get(payload.id,extensionId);
    if(!row)throw Error("CHROME_ENROLLMENT_INTENT_NOT_FOUND");
    if(row.status==="done")return {status:"done",alreadyConfirmed:true};
    if(row.status!=="pending"||now>row.expires_at)
      throw Error("CHROME_ENROLLMENT_INTENT_EXPIRED_OR_CLOSED");
    if(payload.status==="refused"){
      const reason=typeof payload.reason==="string"&&
        /^ENROLLMENT_[A-Z_]{1,65}$/.test(payload.reason)?
        payload.reason:"ENROLLMENT_FAILED_UNVERIFIED";
      this.db.prepare(
        "UPDATE chrome_enrollment_intents SET status='failed',reason=? WHERE id=?"
      ).run(reason,row.id);
      this.store.event(row.workstream_id,now,"chrome_enrollment_failed",null,null,reason);
      return {status:"failed",reason};
    }
    if(payload.sessionKey!==row.id)throw Error("CHROME_ENROLLMENT_SESSION_PROOF_MISMATCH");
    // The extension must first publish the *fresh* new registered session on
    // the authenticated bridge; a mere ACK cannot fabricate an enrollment.
    const snapshot=this.bridge.getSnapshot(now);
    const session=snapshot.sessions.find(s=>s.extensionId===extensionId&&
      s.sessionKey===row.id&&s.status==="connected");
    if(!session)throw Error("CHROME_ENROLLMENT_REGISTERED_SESSION_NOT_CONFIRMED");
    const old=snapshot.links.find(l=>l.workstreamId===row.workstream_id);
    if(old && (old.extensionId!==extensionId||old.sessionKey!==row.id))
      throw Error("CHROME_ENROLLMENT_WORKSTREAM_LINK_CHANGED");
    if(!old)this.bridge.link(row.workstream_id,extensionId,row.id,now);
    this.db.prepare(
      "UPDATE chrome_enrollment_intents SET status='done',reason='' WHERE id=?"
    ).run(row.id);
    this.store.event(row.workstream_id,now,"chrome_enrollment_confirmed",null,null,
      "same_tab_registered_and_linked");
    return {status:"done",workstreamId:row.workstream_id,sessionKey:row.id};
  }
  getSnapshot(now=Date.now()){
    const activeExtensions=new Set(this.bridge.getSnapshot(now).clients
      .filter(c=>c.status==="online").map(c=>c.extensionId));
    const candidates=this.db.prepare(
      "SELECT extension_id AS extensionId,tab_id AS tabId,group_id AS groupId,"+
      "group_label AS groupLabel,title,route,url_hash AS urlHash,reported_at AS reportedAt "+
      "FROM chrome_discovery_candidates ORDER BY group_label,title"
    ).all().filter(x=>activeExtensions.has(x.extensionId)&&elapsed(x.reportedAt,now));
    const registrations=this.db.prepare(
      "SELECT id,workstream_id AS workstreamId,extension_id AS extensionId,"+
      "tab_id AS tabId,created_at AS createdAt,expires_at AS expiresAt,"+
      "status,reason FROM chrome_enrollment_intents ORDER BY created_at DESC LIMIT 40"
    ).all().map(x=>({...x,status:x.status==="pending"&&now>x.expiresAt?
      "expired":x.status}));
    return {candidates,registrations};
  }
}
