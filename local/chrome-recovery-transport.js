import {projectObservation} from "./chat-observation.js";
import {RECOVERY_WORKER_BUILD} from "../extension/disconnect-page.js";

// Durable one-attempt writer commands. Requests, authorization, ACK and later
// read-only completion evidence are deliberately separate boundaries.
export class ChromeRecoveryTransport{
  constructor(store,{observation,eligible,now=()=>Date.now()}={}){
    Object.assign(this,{store,observation,eligible,now});this.db=store.db;this.waiters=new Map();this.workers=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS chrome_recovery_commands(
      operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,workstream_id TEXT NOT NULL REFERENCES workstreams(id),
      kind TEXT NOT NULL CHECK(kind IN ('stop','report')),extension_id TEXT NOT NULL,session_key TEXT NOT NULL,
      linked_at INTEGER NOT NULL,task_revision INTEGER NOT NULL,binding_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','claimed','acked','unknown')),
      issued_at INTEGER NOT NULL,deadline_at INTEGER NOT NULL,authorized_at INTEGER,acked_at INTEGER,receipt TEXT) STRICT;`);
    this.db.prepare("UPDATE chrome_recovery_commands SET state='unknown' WHERE state IN ('queued','claimed')").run();
  }
  row(id){return this.db.prepare("SELECT * FROM chrome_recovery_commands WHERE operation_id=?").get(id)||null;}
  heartbeat(extensionId,build){
    if(build===RECOVERY_WORKER_BUILD)this.workers.set(extensionId,this.now());else this.workers.delete(extensionId);
  }
  supported(id){
    try{const scope=this.observation.current(id),seen=this.workers.get(scope.extension_id);
      return Number.isSafeInteger(seen)&&this.now()-seen<=150_000;
    }catch{return false;}
  }
  current(row){
    if(!row||this.now()>=row.deadline_at||!this.supported(row.workstream_id))throw Error("RECOVERY_COMMAND_SCOPE_CHANGED");
    const scope=this.observation.current(row.workstream_id);
    if(scope.extension_id!==row.extension_id||scope.session_key!==row.session_key||scope.linked_at!==row.linked_at||
      scope.task_revision!==row.task_revision||this.eligible(row)!==true)throw Error("RECOVERY_COMMAND_SCOPE_CHANGED");
    return scope;
  }
  perform(intent,kind){
    const id=intent.workstreamId,scope=this.observation.current(id);
    if(!this.supported(id)||this.row(intent.operationId))return Promise.resolve(null);
    const operation=this.db.prepare("SELECT * FROM operations WHERE id=?").get(intent.operationId);
    if(operation?.workstream_id!==id||operation.kind!=="disconnect-"+kind||operation.status!=="reserved")return Promise.resolve(null);
    this.db.prepare("INSERT INTO chrome_recovery_commands VALUES(?,?,?,?,?,?,?,?,'queued',?,?,NULL,NULL,NULL)")
      .run(intent.operationId,id,kind,scope.extension_id,scope.session_key,scope.linked_at,scope.task_revision,
        intent.bindingFingerprint,this.now(),this.now()+300_000);
    return new Promise(resolve=>{
      const finish=value=>{intent.signal?.removeEventListener("abort",abort);this.waiters.delete(intent.operationId);resolve(value);};
      const abort=()=>this.unknown(intent.operationId,"RECOVERY_EFFECT_ABORTED");
      this.waiters.set(intent.operationId,finish);
      intent.signal?.addEventListener("abort",abort,{once:true});if(intent.signal?.aborted)abort();
    });
  }
  unknown(id,reason){
    const row=this.row(id);if(!row||!["queued","claimed"].includes(row.state))return;
    this.db.prepare("UPDATE chrome_recovery_commands SET state='unknown' WHERE operation_id=?").run(id);
    this.store.event(row.workstream_id,this.now(),"recovery_command_unknown",null,null,reason,id);
    this.waiters.get(id)?.(null);
  }
  claim(extensionId,protocol){
    if(protocol!==RECOVERY_WORKER_BUILD)return null;
    for(const row of this.db.prepare("SELECT * FROM chrome_recovery_commands WHERE extension_id=? AND state='queued' ORDER BY issued_at,operation_id").all(extensionId)){
      try{this.current(row);}catch{this.unknown(row.operation_id,"RECOVERY_CLAIM_SCOPE_CHANGED");continue;}
      this.db.prepare("UPDATE chrome_recovery_commands SET state='claimed' WHERE operation_id=? AND state='queued'").run(row.operation_id);
      this.store.event(row.workstream_id,this.now(),"recovery_command_claimed",null,null,"ONE_ATTEMPT_NO_RECLAIM",row.operation_id);
      return {operationId:row.operation_id,workstreamId:row.workstream_id,sessionKey:row.session_key,
        bindingFingerprint:row.binding_fingerprint,kind:row.kind};
    }
    return null;
  }
  authorize(extensionId,id,page){
    const row=this.row(id);
    if(row?.state!=="claimed"||row.extension_id!==extensionId||row.authorized_at!==null)return {authorized:false};
    try{
      this.current(row);const sample=projectObservation(page,this.now());
      if(sample.verified!==true||sample.bindingFingerprint!==row.binding_fingerprint||sample.composerHasDraft!==false||
        ["uiAmbiguous","providerRestriction","lengthWarning","otherWarning","humanActionCue"].some(key=>sample[key]!==false))throw Error();
      if(row.kind==="stop"?sample.assistantBusy!==true||!sample.stopControlVerified||!sample.connectionWarning||sample.ciWaitCue:
        sample.assistantBusy!==false||sample.stopControlVerified||sample.connectionWarning)throw Error();
      this.db.prepare("UPDATE chrome_recovery_commands SET authorized_at=? WHERE operation_id=? AND authorized_at IS NULL")
        .run(this.now(),id);
      return {authorized:true};
    }catch{this.unknown(id,"RECOVERY_PRE_EFFECT_REFUSED");return {authorized:false};}
  }
  acknowledge(extensionId,receipt){
    const row=this.row(receipt?.operationId);
    if(row?.state!=="claimed"||row.extension_id!==extensionId)throw Error("RECOVERY_ACK_NOT_CURRENT");
    try{
      this.current(row);
      if(row.authorized_at===null||this.now()-row.authorized_at>30_000||
        receipt.bindingFingerprint!==row.binding_fingerprint||receipt.outcome!==(row.kind==="stop"?"clicked":"submitted")||
        row.kind==="report"&&!/^[a-f0-9]{64}$/.test(receipt.userFingerprint||""))throw Error();
      const safe={operationId:row.operation_id,bindingFingerprint:row.binding_fingerprint,outcome:receipt.outcome,
        ...(row.kind==="report"?{userFingerprint:receipt.userFingerprint}:{})};
      this.db.prepare("UPDATE chrome_recovery_commands SET state='acked',acked_at=?,receipt=? WHERE operation_id=?")
        .run(this.now(),JSON.stringify(safe),row.operation_id);
      this.waiters.get(row.operation_id)?.(safe);return {accepted:true};
    }catch{this.unknown(row.operation_id,"RECOVERY_ACK_UNKNOWN_NO_REPLAY");return {accepted:false};}
  }
  verify({operationId,bindingFingerprint,replyFingerprint},kind){
    const row=this.row(operationId);if(row?.state!=="acked"||row.kind!==kind)return {verified:false};
    try{
      this.observation.current(row.workstream_id);
      const sample=this.observation.latest(row.workstream_id),receipt=this.observation.diagnostics(row.workstream_id).lastReceipt;
      if(!receipt?.currentBinding||receipt.outcome!=="RECEIVED"||sample?.verified!==true||sample.observedAt<=row.acked_at||
        sample.observedAt>this.now()||this.now()-sample.observedAt>180_000||sample.bindingFingerprint!==bindingFingerprint||
        bindingFingerprint!==row.binding_fingerprint||sample.assistantBusy!==false||sample.composerHasDraft!==false||
        sample.stopControlVerified||sample.connectionWarning||sample.uiAmbiguous||sample.providerRestriction||sample.otherWarning)
        return {verified:false};
      if(kind==="report"&&(sample.replyFingerprint!==replyFingerprint||sample.recoveryReportProof?.operationId!==operationId||
        sample.recoveryReportProof?.userFingerprint!==JSON.parse(row.receipt).userFingerprint))return {verified:false};
      return {verified:true,operationId,bindingFingerprint,observedAt:sample.observedAt,...(kind==="report"?{replyFingerprint}:{})};
    }catch{return {verified:false};}
  }
  close(){for(const id of [...this.waiters.keys()])this.unknown(id,"RECOVERY_TRANSPORT_CLOSED_NO_REPLAY");}
}
