import {randomUUID} from "node:crypto";
import {classifyObservation} from "./chat-observation.js";
import {decideNextAction,hashAction,scopeProblem} from "./autopilot-decision.js";

// No browser selectors or default writers. Real Stop/report provenance must be
// supplied by separately authorized adapters; fixtures cannot certify it.
export class DisconnectRecovery {
  constructor(store,{state,context,stop,verifyStopped,requestReport,verifyReport,queue=null,now=()=>Date.now()}={}){
    if(!state||[context,stop,verifyStopped,requestReport,verifyReport].some(fn=>typeof fn!=="function"))
      throw Error("RECOVERY_VERIFIED_ADAPTERS_REQUIRED");
    Object.assign(this,{store,db:store.db,state,context,stop,verifyStopped,requestReport,verifyReport,queue,now});
    this.running=new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS autopilot_recoveries(
      workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),episode_id TEXT NOT NULL,task_revision INTEGER NOT NULL,
      binding_fingerprint TEXT NOT NULL,approval_fingerprint TEXT NOT NULL,report_message_hash TEXT NOT NULL,
      stage TEXT NOT NULL,reason TEXT NOT NULL,attempts INTEGER NOT NULL,next_recovery_at INTEGER NOT NULL,
      stop_operation_id TEXT,report_operation_id TEXT,baseline_reply TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;`);
  }
  get(id){return this.db.prepare("SELECT * FROM autopilot_recoveries WHERE workstream_id=?").get(id)||null;}
  approval(scope,policy){return hashAction([scope.taskRevision,scope.bindingFingerprint,scope.expiresAt,scope.reportMessageHash,
    scope.messageHash,scope.recoveryPermitted,policy]);}
  inputs(id,row=null){
    const context=this.context(id),latest=this.state.latest(id),prior=this.state.latest(id,1);
    const workstream=this.store.mustGet(id);
    return {...context,workstream,globalStopped:this.store.isStopped(),now:this.now(),
      operation:this.state.pending(id,{recoveryId:row?.episode_id||""}),
      observation:latest?.task_revision===workstream.task_revision?latest.observation:null,
      previous:prior?.task_revision===workstream.task_revision?prior.observation:null};
  }
  begin(id){
    return this.store.transaction(()=>{
      const input=this.inputs(id),old=this.get(id),decision=decideNextAction(input);
      if(decision.nextAction!=="RECOVER_DISCONNECT")return null;
      const {policy,scope}=input;
      if(!/^[a-f0-9]{64}$/.test(scope.reportMessageHash||"") ||
        !Number.isSafeInteger(policy.maxRecoveryAttempts)||policy.maxRecoveryAttempts<1||policy.maxRecoveryAttempts>5||
        !Number.isSafeInteger(policy.recoveryCooldownMs)||policy.recoveryCooldownMs<1000||
        !Number.isSafeInteger(policy.recoveryStepTimeoutMs)||policy.recoveryStepTimeoutMs<1000)
        throw Error("RECOVERY_EXPLICIT_POLICY_REQUIRED");
      if(this.queue&&this.queue.policy("recovery").leaseMs<=policy.recoveryStepTimeoutMs)
        throw Error("RECOVERY_TIMEOUT_EXCEEDS_QUEUE_LEASE");
      if(old && (old.stage!=="DONE"||old.attempts>=policy.maxRecoveryAttempts||old.next_recovery_at>this.now()))return null;
      this.db.prepare(`INSERT INTO autopilot_recoveries(workstream_id,episode_id,task_revision,binding_fingerprint,
        approval_fingerprint,report_message_hash,stage,reason,attempts,next_recovery_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'RECHECK_WARNING','PERSISTENT_WARNING',?,?,?,?) ON CONFLICT(workstream_id) DO UPDATE SET
        episode_id=excluded.episode_id,task_revision=excluded.task_revision,binding_fingerprint=excluded.binding_fingerprint,
        approval_fingerprint=excluded.approval_fingerprint,report_message_hash=excluded.report_message_hash,
        stage=excluded.stage,reason=excluded.reason,attempts=excluded.attempts,next_recovery_at=excluded.next_recovery_at,
        stop_operation_id=NULL,report_operation_id=NULL,baseline_reply=NULL,created_at=excluded.created_at,updated_at=excluded.updated_at`)
        .run(id,randomUUID(),input.workstream.task_revision,scope.bindingFingerprint,this.approval(scope,policy),scope.reportMessageHash,
          (old?.attempts||0)+1,this.now()+policy.recoveryCooldownMs,this.now(),this.now());
      this.store.event(id,this.now(),"disconnect_begin",null,null,"RECHECK_WARNING");
      return this.get(id);
    });
  }
  transition(id,stage,reason){
    if(["DONE","UNKNOWN","WAIT_HUMAN"].includes(stage))this.queue?.cancelPending(id,"recovery");
    this.db.prepare("UPDATE autopilot_recoveries SET stage=?,reason=?,updated_at=? WHERE workstream_id=?").run(stage,reason,this.now(),id);
    this.store.event(id,this.now(),"disconnect_stage",null,null,reason);
    return this.get(id);
  }
  guard(input,row){
    if(input.globalStopped||!input.workstream.enabled||input.workstream.paused)return "STOPPED";
    if(input.operation||input.workstream.active_operation_id||!["OBSERVING","READY"].includes(input.workstream.state))return "UNRECONCILED_OPERATION";
    const problem=scopeProblem(input.workstream,input.scope,input.now);
    if(problem)return problem;
    if(input.scope.recoveryPermitted!==true||this.approval(input.scope,input.policy)!==row.approval_fingerprint)return "RECOVERY_APPROVAL_CHANGED";
    const classified=classifyObservation(input.observation,{previous:input.previous,now:input.now,...input.policy});
    if(classified.state==="WAIT_HUMAN")return classified.reasonCode;
    if(classified.state==="UNKNOWN"&&classified.reasonCode!=="RESPONSE_STABILIZING")return classified.reasonCode;
    if(!input.observation?.verified||input.observation.bindingFingerprint!==row.binding_fingerprint||
      !Number.isSafeInteger(input.observation.observedAt)||input.observation.observedAt>this.now()||
      this.now()-input.observation.observedAt>input.policy.maxAgeMs||input.observation.uiAmbiguous||
      input.observation.composerHasDraft!==false)return "RECOVERY_OBSERVATION_UNVERIFIED";
    return null;
  }
  intent(id,row,kind){
    return this.store.transaction(()=>{
      const current=this.get(id);
      const expected=kind==="stop"?"RECHECK_WARNING":"STOP_RESULT_VERIFIED";
      if(current?.episode_id!==row.episode_id||current.stage!==expected)return null;
      const input=this.inputs(id,row);
      if(this.guard(input,row)|| (kind==="stop"? !input.observation.connectionWarning||
        !input.observation.stopControlVerified||input.observation.assistantBusy!==true:
        input.observation.assistantBusy!==false||input.observation.connectionWarning))return null;
      const operationId=randomUUID();
      this.db.prepare("INSERT INTO operations(id,workstream_id,task_revision,kind,dedupe_key,status,started_at) VALUES(?,?,?,?,?,'reserved',?)")
        .run(operationId,id,row.task_revision,"disconnect-"+kind,hashAction([row.episode_id,kind]),this.now());
      const column=kind==="stop"?"stop_operation_id":"report_operation_id";
      this.db.prepare(`UPDATE autopilot_recoveries SET ${column}=?,baseline_reply=?,updated_at=? WHERE workstream_id=?`)
        .run(operationId,this.state.latest(id)?.observation.replyFingerprint||null,this.now(),id);
      this.transition(id,kind==="stop"?"STOP_INTENT_RECORDED":"REPORT_INTENT_RECORDED","INTENT_RECORDED_BEFORE_"+kind.toUpperCase());
      return {operationId,workstreamId:id,bindingFingerprint:row.binding_fingerprint,messageHash:row.report_message_hash};
    });
  }
  async perform(id,row,kind,adapter){
    const execute=async()=>{
      const intent=this.intent(id,row,kind);if(!intent)return this.get(id);
      let receipt,timer;const controller=new AbortController();
      try{receipt=await Promise.race([Promise.resolve(adapter({...intent,signal:controller.signal})),new Promise((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(Error("RECOVERY_EFFECT_TIMEOUT"));},this.context(id).policy.recoveryStepTimeoutMs);
      })]);}catch{}finally{clearTimeout(timer);}
      return this.receipt(id,intent,receipt,kind==="stop"?"clicked":"submitted",kind==="stop"?"STOP_RESULT_PENDING":"REPORT_RESULT_PENDING");
    };
    if(this.queue){await this.queue.run({kind:"recovery",resourceKey:row.episode_id+":"+kind,workstreamId:id},execute);return this.get(id);}
    return execute();
  }
  async advance(id){
    if(this.running.has(id))return this.get(id);
    this.running.add(id);
    try{
      let row=this.get(id);
      if(!row||["DONE","UNKNOWN","WAIT_HUMAN"].includes(row.stage))return row;
      const input=this.inputs(id,row),problem=this.guard(input,row);
      if(problem)return this.store.transaction(()=>this.transition(id,"WAIT_HUMAN",problem));
      if(["STOP_INTENT_RECORDED","REPORT_INTENT_RECORDED"].includes(row.stage))
        return this.store.transaction(()=>this.transition(id,"UNKNOWN","UNRECONCILED_EXTERNAL_INTENT"));
      if(this.now()-row.updated_at>input.policy.recoveryStepTimeoutMs)
        return this.store.transaction(()=>this.transition(id,"UNKNOWN","RECOVERY_STEP_TIMEOUT"));
      if(row.stage==="RECHECK_WARNING"){
        if(!input.observation.connectionWarning)return this.store.transaction(()=>this.transition(id,"DONE","WARNING_CLEARED_NO_CLICK"));
        if(!input.observation.stopControlVerified||input.observation.assistantBusy!==true)
          return this.store.transaction(()=>this.transition(id,"WAIT_HUMAN","STOP_CONTROL_UNVERIFIED"));
        return await this.perform(id,row,"stop",this.stop);
      }
      if(row.stage==="STOP_RESULT_PENDING"){
        const proof=await this.verifyStopped({operationId:row.stop_operation_id,bindingFingerprint:row.binding_fingerprint});
        if(proof?.verified!==true||proof.operationId!==row.stop_operation_id||proof.bindingFingerprint!==row.binding_fingerprint||
          !Number.isSafeInteger(proof.observedAt)||proof.observedAt<=row.updated_at||proof.observedAt>this.now()||
          this.now()-proof.observedAt>input.policy.maxAgeMs)return row;
        return this.store.transaction(()=>{
          if(this.get(id)?.stage!=="STOP_RESULT_PENDING"||this.get(id).episode_id!==row.episode_id)return this.get(id);
          this.db.prepare("UPDATE operations SET status='completed',finished_at=?,result='STOP_INDEPENDENTLY_VERIFIED' WHERE id=?").run(this.now(),row.stop_operation_id);
          return this.transition(id,"STOP_RESULT_VERIFIED","STOP_INDEPENDENTLY_VERIFIED");
        });
      }
      if(row.stage==="STOP_RESULT_VERIFIED"){
        if(input.observation.assistantBusy!==false||input.observation.connectionWarning)return row;
        return await this.perform(id,row,"report",this.requestReport);
      }
      if(row.stage==="REPORT_RESULT_PENDING"){
        const classified=classifyObservation(input.observation,{previous:input.previous,now:input.now,...input.policy});
        if(!classified.assistantStable||input.observation.observedAt<=row.updated_at||
          input.observation.replyFingerprint===row.baseline_reply)return row;
        const proof=await this.verifyReport({operationId:row.report_operation_id,bindingFingerprint:row.binding_fingerprint,
          replyFingerprint:input.observation.replyFingerprint});
        if(proof?.verified!==true||proof.operationId!==row.report_operation_id||
          proof.bindingFingerprint!==row.binding_fingerprint||proof.replyFingerprint!==input.observation.replyFingerprint)return row;
        return this.store.transaction(()=>{
          if(this.get(id)?.stage!=="REPORT_RESULT_PENDING"||this.get(id).episode_id!==row.episode_id)return this.get(id);
          this.db.prepare("UPDATE operations SET status='completed',finished_at=?,result='REPORT_RESPONSE_INDEPENDENTLY_VERIFIED' WHERE id=?").run(this.now(),row.report_operation_id);
          return this.transition(id,"REPORT_RESPONSE_VERIFIED","REPORT_RESPONSE_INDEPENDENTLY_VERIFIED");
        });
      }
      if(row.stage==="REPORT_RESPONSE_VERIFIED"){
        const decision=decideNextAction(input);
        this.store.transaction(()=>this.transition(id,"DONE","REEVALUATE_"+decision.nextAction));
        return {...this.get(id),decision}; // Normal coordinator alone may reserve CONTINUE.
      }
      return row;
    }catch{return this.store.transaction(()=>this.transition(id,"UNKNOWN","RECOVERY_ADAPTER_UNAVAILABLE"));}
    finally{this.running.delete(id);}
  }
  receipt(id,intent,receipt,outcome,stage){
    return this.store.transaction(()=>{
      const current=this.get(id),expected=outcome==="clicked"?"STOP_INTENT_RECORDED":"REPORT_INTENT_RECORDED";
      if(!current||current.stage!==expected||
        (outcome==="clicked"?current.stop_operation_id:current.report_operation_id)!==intent.operationId)return current;
      const valid=receipt?.outcome===outcome&&receipt.operationId===intent.operationId&&receipt.bindingFingerprint===intent.bindingFingerprint;
      this.db.prepare("UPDATE operations SET status=?,result=? WHERE id=?")
        .run(valid?"accepted":"abandoned",valid?"ACK_NOT_COMPLETION":"UNKNOWN_NO_REPLAY",intent.operationId);
      return this.transition(id,valid?stage:"UNKNOWN",valid?"ACK_REQUIRES_INDEPENDENT_VERIFICATION":"UNKNOWN_NO_REPLAY");
    });
  }
  reconcile(){
    return this.store.transaction(()=>{
      const rows=this.db.prepare("SELECT workstream_id,stop_operation_id,report_operation_id FROM autopilot_recoveries WHERE stage IN ('STOP_INTENT_RECORDED','REPORT_INTENT_RECORDED')").all();
      for(const row of rows){
        this.db.prepare("UPDATE operations SET status='abandoned',result='UNKNOWN_NO_REPLAY' WHERE id IN (?,?) AND status='reserved'")
          .run(row.stop_operation_id,row.report_operation_id);
        this.transition(row.workstream_id,"UNKNOWN","RESTART_UNCERTAIN_NO_REPLAY");
      }
      return rows.length;
    });
  }
}
