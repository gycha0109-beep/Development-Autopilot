// SMS-01: durable *notification intents only*. No recipient, provider or sender.
// Producers call record() in the SAME SQLite transaction as their source event.
// SMS-02 will add a separate delivery-attempt ledger; this table never claims
// an external message was accepted or delivered.
import {createHash} from "node:crypto";

const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const kinds=new Set(["blocker","approval","pause"]);
const severities=new Set(["normal","critical"]);
const reasons=/^[A-Z][A-Z0-9_]{1,99}$/;

export class NotificationIntents {
  constructor(store,{now=()=>Date.now()}={}){
    this.store=store;
    this.db=store.db;
    this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS notification_intents(
      intent_id TEXT PRIMARY KEY CHECK(length(intent_id)=64),
      workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('blocker','approval','pause')),
      source_key TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK(source_revision>=1),
      severity TEXT NOT NULL CHECK(severity IN ('normal','critical')),
      reason_code TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','coalesced')),
      coalesced_into TEXT REFERENCES notification_intents(intent_id),
      created_at INTEGER NOT NULL,
      UNIQUE(source_kind,source_key,source_revision),
      CHECK((state='pending' AND coalesced_into IS NULL) OR
            (state='coalesced' AND coalesced_into IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS notification_intents_workstream_idx
      ON notification_intents(workstream_id,created_at); `);
  }
  nextRevision(sourceKind,sourceKey){
    if(!kinds.has(sourceKind)||typeof sourceKey!=="string"||!sourceKey)
      throw Error("INVALID_NOTIFICATION_SOURCE");
    return this.db.prepare(`SELECT COALESCE(MAX(source_revision),0)+1 AS value
      FROM notification_intents WHERE source_kind=? AND source_key=?`)
      .get(sourceKind,sourceKey).value;
  }
  record({workstreamId,sourceKind,sourceKey,sourceRevision=1,
    reasonCode,severity="normal",coalescedInto=null}={}){
    if(!this.db.isTransaction)throw Error("NOTIFICATION_SOURCE_TRANSACTION_REQUIRED");
    this.store.mustGet(workstreamId);
    if(!kinds.has(sourceKind)||typeof sourceKey!=="string"||
      !/^[a-f0-9-]{32,128}$/i.test(sourceKey)||
      !Number.isSafeInteger(sourceRevision)||sourceRevision<1||
      !reasons.test(reasonCode||"")||!severities.has(severity)||
      (coalescedInto!==null&&!/^[a-f0-9]{64}$/.test(coalescedInto)))
      throw Error("INVALID_NOTIFICATION_INTENT");
    const now=this.now();
    if(!Number.isSafeInteger(now)||now<0)throw Error("INVALID_NOTIFICATION_TIME");
    const intentId=digest([sourceKind,sourceKey,sourceRevision]);
    if(coalescedInto===intentId)throw Error("NOTIFICATION_SELF_COALESCENCE");
    const state=coalescedInto?"coalesced":"pending";
    const write=this.db.prepare(`INSERT INTO notification_intents(
      intent_id,workstream_id,source_kind,source_key,source_revision,
      severity,reason_code,state,coalesced_into,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_kind,source_key,source_revision) DO NOTHING`)
      .run(intentId,workstreamId,sourceKind,sourceKey,sourceRevision,
        severity,reasonCode,state,coalescedInto,now);
    if(write.changes){
      this.store.event(workstreamId,now,"notification_intent_recorded",null,null,
        sourceKind.toUpperCase(),intentId);
    }
    return {intentId,created:write.changes===1,state};
  }
  list(limit=200){
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error("INVALID_NOTIFICATION_LIMIT");
    return this.db.prepare(`SELECT intent_id AS intentId,workstream_id AS workstreamId,
      source_kind AS sourceKind,source_key AS sourceKey,
      source_revision AS sourceRevision,severity,reason_code AS reasonCode,
      state,coalesced_into AS coalescedInto,created_at AS createdAt
      FROM notification_intents ORDER BY created_at DESC,intent_id DESC LIMIT ?`).all(limit);
  }
}
