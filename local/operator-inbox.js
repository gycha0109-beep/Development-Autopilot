import {randomUUID,randomBytes,timingSafeEqual} from "node:crypto";
import {hashAction} from "./autopilot-decision.js";
const hex=value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const time=value=>Number.isSafeInteger(value)&&value>=0;
const categories=["cost","local_test","login","approval","recovery","ci","design"];

// Canonical local requests. Remote transport cannot execute the requested action.
export class OperatorInbox {
  constructor(store,{allowedSenders=[],currentTarget=null,queue=null,now=()=>Date.now()}={}){
    this.store=store;this.db=store.db;this.now=now;this.allowedSenders=new Set(allowedSenders);
    this.currentTarget=currentTarget;
    this.queue=queue;
    this.db.exec(`CREATE TABLE IF NOT EXISTS operator_requests(
      id TEXT PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id),task_revision INTEGER NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('cost','local_test','login','approval','recovery','ci','design')),
      reason TEXT NOT NULL,action_fingerprint TEXT NOT NULL,head_sha TEXT,
      evidence_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','held','approved','rejected','expired','closed','consumed')),
      acknowledged_at INTEGER,delivery_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','recorded','sent','unknown')),
      delivery_id TEXT,nonce_hash TEXT,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,dedupe_key TEXT NOT NULL UNIQUE) STRICT;
      CREATE TABLE IF NOT EXISTS operator_command_receipts(
      command_id TEXT PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id),
      request_id TEXT NOT NULL,sender_hash TEXT NOT NULL,command TEXT NOT NULL,at INTEGER NOT NULL) STRICT;`);
  }
  row(id){return this.db.prepare("SELECT * FROM operator_requests WHERE id=?").get(id)||null;}
  visible(row){
    if(!row)return null;
    return {requestId:row.id,workstreamId:row.workstream_id,taskRevision:row.task_revision,reasonCategory:row.category,
      reasonCode:row.reason,actionFingerprint:row.action_fingerprint,headSha:row.head_sha,evidenceTimestamp:row.evidence_at,
      expiresAt:row.expires_at,state:!["closed","consumed"].includes(row.state)&&this.now()>=row.expires_at?"expired":row.state,
      acknowledgedAt:row.acknowledged_at,deliveryAttempts:row.delivery_attempts,deliveryState:row.delivery_state};
  }
  list(){return this.db.prepare("SELECT * FROM operator_requests ORDER BY created_at,id").all().map(row=>this.visible(row));}
  open(id,{reasonCategory,reasonCode,actionFingerprint,headSha=null,evidenceTimestamp,expiresAt}={}){
    const stream=this.store.mustGet(id),now=this.now();
    if(!categories.includes(reasonCategory)||!/^[A-Z0-9_]{1,100}$/.test(reasonCode||"")||!hex(actionFingerprint)||
      (headSha!==null&&!/^[a-f0-9]{40}$/.test(headSha))||!time(evidenceTimestamp)||evidenceTimestamp>now||
      now-evidenceTimestamp>300_000||!time(expiresAt)||expiresAt<=now||expiresAt-now>86_400_000)
      throw Error("INVALID_OPERATOR_REQUEST");
    return this.store.transaction(()=>{
      const dedupe=hashAction([id,stream.task_revision,reasonCategory,actionFingerprint,headSha]);
      const existing=this.db.prepare("SELECT * FROM operator_requests WHERE dedupe_key=?").get(dedupe);
      if(existing)return this.visible(existing);
      const requestId=randomUUID();
      this.db.prepare(`INSERT INTO operator_requests(id,workstream_id,task_revision,category,reason,action_fingerprint,
        head_sha,evidence_at,expires_at,state,created_at,updated_at,dedupe_key) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)`)
        .run(requestId,id,stream.task_revision,reasonCategory,reasonCode,actionFingerprint,headSha,evidenceTimestamp,expiresAt,now,now,dedupe);
      // Same canonical workstream pause; never stop or modify sibling workstreams.
      this.db.prepare("UPDATE workstreams SET paused=1,updated_at=? WHERE id=?").run(now,id);
      this.store.event(id,now,"operator_request",null,null,reasonCode,requestId);
      return this.visible(this.row(requestId));
    });
  }
  acknowledge(id){
    const row=this.row(id);if(!row)throw Error("OPERATOR_REQUEST_NOT_FOUND");
    this.db.prepare("UPDATE operator_requests SET acknowledged_at=COALESCE(acknowledged_at,?),updated_at=? WHERE id=?").run(this.now(),this.now(),id);
    return this.visible(this.row(id));
  }
  async deliver(id,transport){
    if(transport?.kind!=="fake")throw Error("REAL_MESSENGER_NOT_IMPLEMENTED_OR_APPROVED");
    const row=this.row(id);
    if(!row||row.state!=="pending"||this.now()>=row.expires_at||row.delivery_state!=="pending"||row.delivery_attempts>=3)
      return {sent:false,reasonCode:"DELIVERY_NOT_ELIGIBLE"};
    if(this.queue){const receipt=await this.queue.run({kind:"notify",resourceKey:id,workstreamId:row.workstream_id},()=>this.deliverOnce(id,transport));
      return receipt.outcome==="completed"?receipt.value:{sent:false,reasonCode:receipt.reasonCode};}
    return this.deliverOnce(id,transport);
  }
  async deliverOnce(id,transport){
    const intent=this.store.transaction(()=>{
      const row=this.row(id);
      if(!row||row.state!=="pending"||this.now()>=row.expires_at||
        row.delivery_state!=="pending"||row.delivery_attempts>=3)return null;
      const nonce=randomBytes(32).toString("hex"),deliveryId=randomUUID();
      this.db.prepare("UPDATE operator_requests SET nonce_hash=?,delivery_id=?,delivery_state='recorded',delivery_attempts=delivery_attempts+1,updated_at=? WHERE id=?")
        .run(hashAction(nonce),deliveryId,this.now(),id);
      this.store.event(row.workstream_id,this.now(),"operator_delivery_intent",null,null,"RECORDED_BEFORE_DELIVERY",deliveryId);
      return {...this.visible(this.row(id)),nonce,deliveryId};
    });
    if(!intent)return {sent:false,reasonCode:"DELIVERY_NOT_ELIGIBLE"};
    let receipt;try{receipt=await transport.deliver(intent);}catch{}
    return this.store.transaction(()=>{
      const row=this.row(id);
      if(row.delivery_id!==intent.deliveryId||row.delivery_state!=="recorded")return {sent:false,reasonCode:"DELIVERY_ALREADY_RECONCILED"};
      const valid=receipt?.deliveryId===intent.deliveryId;
      const state=valid&&receipt.status==="sent"?"sent":valid&&receipt.status==="not_sent"?"pending":"unknown";
      this.db.prepare("UPDATE operator_requests SET delivery_state=?,updated_at=? WHERE id=?").run(state,this.now(),id);
      this.store.event(row.workstream_id,this.now(),"operator_delivery_receipt",null,null,state.toUpperCase(),intent.deliveryId);
      return {sent:state==="sent",reasonCode:"DELIVERY_"+state.toUpperCase()};
    });
  }
  async receive(envelope,transport){
    let auth;try{auth=await transport.authenticate(envelope);}catch{}
    if(!auth||!this.allowedSenders.has(auth.senderId))return {accepted:false,reasonCode:"SENDER_NOT_AUTHENTICATED"};
    const body=auth.body;
    return this.store.transaction(()=>{
      const deny=reasonCode=>({accepted:false,reasonCode});
      if(!body||typeof body.commandId!=="string"||!/^[A-Za-z0-9._:-]{1,100}$/.test(body.commandId)||
        typeof body.requestId!=="string"||body.requestId.length>100||
        !["status","hold","resume","approve","reject"].includes(body.command))return deny("INVALID_REMOTE_COMMAND");
      const row=this.row(body.requestId);if(!row)return deny("REQUEST_NOT_FOUND");
      if(body.command==="status")return {accepted:true,request:this.visible(row)};
      if(this.db.prepare("SELECT 1 FROM operator_command_receipts WHERE command_id=?").get(body.commandId))return deny("COMMAND_ALREADY_USED");
      if(this.now()>=row.expires_at)return deny("REQUEST_EXPIRED");
      if(!["pending","held"].includes(row.state))return deny("REQUEST_ALREADY_REVIEWED");
      const current=this.store.mustGet(row.workstream_id);
      if(body.actionFingerprint!==row.action_fingerprint||body.headSha!==row.head_sha||
        body.taskRevision!==row.task_revision||current.task_revision!==row.task_revision||
        !/^[a-f0-9]{64}$/.test(body.nonce||"")||!hex(row.nonce_hash)||
        !timingSafeEqual(Buffer.from(hashAction(body.nonce),"hex"),Buffer.from(row.nonce_hash,"hex")))
        return deny("ACTION_OR_NONCE_MISMATCH");
      const state={hold:"held",resume:"pending",approve:"approved",reject:"rejected"}[body.command];
      this.db.prepare("UPDATE operator_requests SET state=?,nonce_hash=?,acknowledged_at=?,updated_at=? WHERE id=?")
        .run(state,["approve","reject"].includes(body.command)?null:row.nonce_hash,this.now(),this.now(),row.id);
      this.db.prepare("INSERT INTO operator_command_receipts(command_id,workstream_id,request_id,sender_hash,command,at) VALUES(?,?,?,?,?,?)")
        .run(body.commandId,row.workstream_id,row.id,hashAction(auth.senderId),body.command,this.now());
      this.store.event(row.workstream_id,this.now(),"operator_remote_command",null,null,body.command.toUpperCase(),row.id);
      // resume clears only the Inbox hold; it never grants/consumes approval,
      // clears global STOP, unpauses an axis or executes costs/merge/deployment.
      return {accepted:true,request:this.visible(this.row(row.id))};
    });
  }
  async consumeApproval(id,{actionFingerprint,headSha=null,taskRevision}={}){
    const requested=this.row(id);if(!requested||typeof this.currentTarget!=="function")return null;
    let target;try{target=await this.currentTarget(this.visible(requested));}catch{return null;}
    if(target?.verified!==true||!time(target.checkedAt)||target.checkedAt>this.now()||this.now()-target.checkedAt>30_000||
      target.actionFingerprint!==actionFingerprint||target.headSha!==headSha||target.taskRevision!==taskRevision)return null;
    return this.store.transaction(()=>{
      const row=this.row(id);
      if(this.store.isStopped()||!row||row.state!=="approved"||this.now()>=row.expires_at||row.action_fingerprint!==actionFingerprint||
        row.head_sha!==headSha||row.task_revision!==taskRevision||this.store.mustGet(row.workstream_id).task_revision!==taskRevision)
        return null;
      this.db.prepare("UPDATE operator_requests SET state='consumed',updated_at=? WHERE id=?").run(this.now(),id);
      this.store.event(row.workstream_id,this.now(),"operator_approval_consumed",null,null,"EXACT_ACTION_RECEIPT_NO_EXECUTION",id);
      return {requestId:id,workstreamId:row.workstream_id,actionFingerprint,headSha,taskRevision};
    });
  }
  close(id,actionFingerprint){
    return this.store.transaction(()=>{
      const row=this.row(id);if(!row||row.action_fingerprint!==actionFingerprint||row.state==="consumed")throw Error("OPERATOR_CLOSE_MISMATCH");
      this.db.prepare("UPDATE operator_requests SET state='closed',nonce_hash=NULL,updated_at=? WHERE id=?").run(this.now(),id);
      this.store.event(row.workstream_id,this.now(),"operator_request_closed",null,null,"LOCAL_OPERATOR_CLOSED_NO_APPROVAL",id);
      return this.visible(this.row(id));
    });
  }
  reconcile(){return this.store.transaction(()=>{
    const rows=this.db.prepare("SELECT * FROM operator_requests WHERE delivery_state='recorded'").all();
    for(const row of rows){
      this.db.prepare("UPDATE operator_requests SET delivery_state='unknown',updated_at=? WHERE id=?").run(this.now(),row.id);
      this.store.event(row.workstream_id,this.now(),"operator_delivery_unknown",null,null,"RESTART_NO_REPLAY",row.delivery_id);
    }
    return rows.length;
  });}
}
