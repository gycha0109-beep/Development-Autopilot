import {AutopilotState} from "./autopilot-state.js";
import {decideNextAction,hashAction} from "./autopilot-decision.js";
import {MigrationContinuity} from "./migration-continuity.js";
import {projectObservation} from "./chat-observation.js";
import {CIWaitLedger} from "./ci-wait.js";

// Injectable/offline runtime. No default page reader, browser activation or API.
// Opted-in workstreams use existing ChatContinuation queue/claim/ACK exclusively.
export class AutopilotCoordinator {
  constructor(store,{chat,watchtower,github,gate,observe,inbox=null,queue=null,verifyMigration=null,now=()=>Date.now()}={}){
    if(!chat||!watchtower||!github||!gate||typeof observe!=="function")throw Error("AUTOPILOT_ADAPTERS_REQUIRED");
    Object.assign(this,{store,db:store.db,chat,watchtower,github,gate,observe,now});
    this.inbox=inbox;
    this.ciWait=new CIWaitLedger(store);
    this.queue=queue;
    this.state=new AutopilotState(store,{now});this.inFlight=new Map();this.externalPending=null;this.lastExternal=null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS autopilot_schedules(
      workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),task_revision INTEGER NOT NULL,
      binding_fingerprint TEXT NOT NULL,policy TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      remaining_work INTEGER NOT NULL CHECK(remaining_work IN (0,1)),
      next_inspect_at INTEGER NOT NULL,next_external_check_at INTEGER,
      updated_at INTEGER NOT NULL) STRICT;`);
    if(chat.observationPolicy)throw Error("AUTOPILOT_GUARD_ALREADY_INSTALLED");
    this.migration=new MigrationContinuity(this,{verify:verifyMigration});
    chat.observationPolicy={admitQueue:(id,intent)=>this.admit(id,intent),
      bindCommand:(id,intent,commandId)=>this.bindCommand(id,intent,commandId),
      admitClaim:command=>this.admit(command.workstream_id,null,command.id),
      pauseForMigration:(id,extensionId,sessionKey)=>this.migration.pause(id,extensionId,sessionKey),
      resumeForMigration:id=>this.migration.canResume(id),migrationResumed:id=>this.migration.resumed(id)};
  }
  get(id){
    const row=this.db.prepare("SELECT * FROM autopilot_schedules WHERE workstream_id=?").get(id);
    return row?{...row,enabled:!!row.enabled,policy:JSON.parse(row.policy)}:null;
  }
  configure(id,{bindingFingerprint,policy,remainingWork,observationPermitted,executionPermitted}={}){
    const stream=this.store.mustGet(id),cfg=this.chat.config(id);
    if(!cfg?.enabled||cfg.mode!=="scheduled"||cfg.expiresAt<=this.now()||this.state.pending(id))throw Error("AUTOPILOT_EXISTING_APPROVAL_REQUIRED");
    if(observationPermitted!==true||executionPermitted!==true||typeof remainingWork!=="boolean"||
      !/^[a-f0-9]{64}$/.test(bindingFingerprint||""))throw Error("AUTOPILOT_EXPLICIT_CAPABILITY_REQUIRED");
    const normalized={};
    for(const key of ["stableForMs","maxAgeMs","inspectIntervalMs","externalIntervalMs","disconnectDebounceMs","observationTimeoutMs"]){
      if(!Number.isSafeInteger(policy?.[key])||policy[key]<=0||policy[key]>86_400_000)throw Error("INVALID_AUTOPILOT_POLICY");
      normalized[key]=policy[key];
    }
    if(normalized.maxAgeMs<normalized.stableForMs)throw Error("INVALID_AUTOPILOT_POLICY");
    if(this.queue&&this.queue.policy("inspect").leaseMs<=normalized.observationTimeoutMs)throw Error("OBSERVATION_TIMEOUT_EXCEEDS_QUEUE_LEASE");
    return this.store.transaction(()=>{
      this.db.prepare(`INSERT INTO autopilot_schedules(workstream_id,task_revision,binding_fingerprint,policy,enabled,remaining_work,next_inspect_at,updated_at)
        VALUES(?,?,?,?,1,?,?,?) ON CONFLICT(workstream_id) DO UPDATE SET task_revision=excluded.task_revision,
        binding_fingerprint=excluded.binding_fingerprint,policy=excluded.policy,enabled=1,remaining_work=excluded.remaining_work,
        next_inspect_at=excluded.next_inspect_at,next_external_check_at=NULL,updated_at=excluded.updated_at`)
        .run(id,stream.task_revision,bindingFingerprint,JSON.stringify(normalized),Number(remainingWork),this.now(),this.now());
      this.store.event(id,this.now(),"autopilot_configured",null,null,"EXPLICIT_OBSERVATION_AND_EXECUTION_SCOPE");
      return this.get(id);
    });
  }
  context(id){
    const schedule=this.get(id),cfg=this.chat.config(id);
    return {policy:schedule?.policy||{},scope:{approved:!!(schedule?.enabled&&cfg?.enabled&&cfg.sentCount<cfg.maxMessages),
      taskRevision:schedule?.task_revision,expiresAt:cfg?.expiresAt,bindingFingerprint:schedule?.binding_fingerprint,
      messageLimitReached:!!(Number.isSafeInteger(cfg?.sentCount)&&Number.isSafeInteger(cfg?.maxMessages)&&
        cfg.maxMessages>0&&cfg.sentCount>=cfg.maxMessages),
      messageHash:typeof cfg?.message==="string"?hashAction(cfg.message):null,observationPermitted:!!schedule,executionPermitted:!!schedule,
      remainingWork:!!schedule?.remaining_work,nextEligibleDispatchAt:cfg?.nextDueAt,evidenceHash:cfg?.evidenceHash,
      ciResumeTargetHash:cfg?.ciResumeTargetHash},
      ci:{watchtower:this.watchtower.current(),github:this.github.current(),review:this.gate.getReview?.(id)||null,
        wait:this.ciWait.current(id)}};
  }
  admit(id,intent=null,commandId=null){
    if(!this.get(id))return null; // preexisting unmanaged campaigns are not silently enrolled.
    const claim=commandId?this.db.prepare("SELECT * FROM autopilot_response_claims WHERE command_id=? AND workstream_id=?").get(commandId,id):
      this.db.prepare("SELECT * FROM autopilot_response_claims WHERE operation_id=? AND workstream_id=?").get(intent?.operationId||"",id);
    if(!claim || (commandId?claim.status!=="submitted":claim.status!=="reserved"))return "OBSERVATION_INTENT_REQUIRED";
    const latest=this.state.latest(id),previous=this.state.latest(id,1),stream=this.store.mustGet(id);
    if(!latest||latest.task_revision!==stream.task_revision||latest.observation.replyFingerprint!==claim.reply_fingerprint||
      latest.observation.bindingFingerprint!==claim.binding_fingerprint)return "OBSERVATION_RESPONSE_CHANGED";
    const decision=decideNextAction({...this.context(id),workstream:stream,globalStopped:this.store.isStopped(),
      operation:this.state.pending(id,{intentId:claim.operation_id,commandId:commandId||""}),now:this.now(),
      observation:latest.observation,previous:previous?.task_revision===stream.task_revision?previous.observation:null});
    return decision.nextAction==="CONTINUE"&&decision.actionFingerprint===claim.action_fingerprint?null:"OBSERVATION_PRECONDITION_CHANGED";
  }
  bindCommand(id,intent,commandId){
    if(!this.get(id))return;
    // Called inside ChatContinuation's insertion transaction, before commit.
    const row=this.db.prepare("UPDATE autopilot_response_claims SET status='submitted',command_id=?,updated_at=? WHERE operation_id=? AND workstream_id=? AND status='reserved'")
      .run(commandId,this.now(),intent?.operationId||"",id);
    if(row.changes!==1)throw Error("AUTOPILOT_INTENT_BIND_FAILED");
  }
  async refreshExternal(){
    if(this.externalPending)return this.externalPending;
    const signature=JSON.stringify([this.watchtower.targets.list(),this.github.targets.list()]);
    if(this.lastExternal?.at===this.now()&&this.lastExternal.signature===signature)return;
    this.lastExternal={at:this.now(),signature};
    const refresh=()=>Promise.allSettled([Promise.resolve().then(()=>this.watchtower.refresh()),
      Promise.resolve().then(()=>this.github.refresh())]);
    this.externalPending=(this.queue?this.queue.run({kind:"ci",resourceKey:"shared-ci"},refresh):refresh())
      .finally(()=>{this.externalPending=null;});
    return this.externalPending;
  }
  async read(id,schedule){
    const source=async()=>{
      let timer;const controller=new AbortController();
      try{const snapshot=await Promise.race([Promise.resolve().then(()=>this.observe(id,{signal:controller.signal})),new Promise((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(Error("OBSERVATION_TIMEOUT"));},schedule.policy.observationTimeoutMs);
      })]);const projected=projectObservation(snapshot);
        if(!projected.verified)throw Error("OBSERVATION_UNAVAILABLE");return projected;
      }finally{clearTimeout(timer);}
    };
    const unavailable={schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",verified:false,observedAt:this.now()};
    if(this.queue){const receipt=await this.queue.run({kind:"inspect",resourceKey:id,workstreamId:id},source);
      return {queueReceipt:receipt,snapshot:receipt.outcome==="completed"?receipt.value:unavailable};}
    try{return {snapshot:await source()};}catch{return {snapshot:unavailable};}
  }
  async run(id){
    const schedule=this.get(id);
    if(!schedule?.enabled||this.store.isStopped()||!this.store.mustGet(id).enabled||this.store.mustGet(id).paused){
      this.queue?.cancelPending(id,"inspect");this.queue?.cancelPending(id,"dispatch");return null;}
    if(schedule.next_external_check_at!==null&&schedule.next_external_check_at<=this.now())await this.refreshExternal();
    let decision,nextInspectAt=schedule.next_inspect_at;
    if(schedule.next_inspect_at<=this.now()){
      const read=await this.read(id,schedule);
      if(read.queueReceipt&&(!read.queueReceipt.ran||read.queueReceipt.blocked)){
        if(read.queueReceipt.blocked){
          this.db.prepare("UPDATE autopilot_schedules SET enabled=0 WHERE workstream_id=?").run(id);
          this.inbox?.open(id,{reasonCategory:"recovery",reasonCode:"OBSERVATION_RETRY_EXHAUSTED",actionFingerprint:hashAction([id,"inspection",schedule.binding_fingerprint]),
            evidenceTimestamp:this.now(),expiresAt:this.now()+3_600_000});
          return {workstreamId:id,queueDeferred:read.queueReceipt.reasonCode,command:null};
        }
        nextInspectAt=read.queueReceipt.retryAt||this.now()+1;
        // A busy read queue must not block the independent dispatch queue.
        // Existing samples still must pass freshness/stability/approval gates.
        decision=this.state.reconsider(id,this.context(id));
        if(!decision){
          this.db.prepare("UPDATE autopilot_schedules SET next_inspect_at=? WHERE workstream_id=?").run(nextInspectAt,id);
          return {workstreamId:id,queueDeferred:read.queueReceipt.reasonCode,command:null};
        }
      }else{
        decision=this.state.evaluate(id,read.snapshot,this.context(id));
        nextInspectAt=this.now()+schedule.policy.inspectIntervalMs;
      }
    }else decision=this.state.reconsider(id,this.context(id));
    if(!decision)return null;
    if(["WAIT_CI","CHECK_CI"].includes(decision.nextAction)&&schedule.next_external_check_at===null){
      await this.refreshExternal();decision=this.state.reconsider(id,this.context(id));
    }
    if(["WAIT_CI","CHECK_CI"].includes(decision.nextAction)){
      this.ciWait.record({workstream:this.store.mustGet(id),
        observation:this.state.latest(id)?.observation,ci:this.context(id).ci,now:this.now()},
        decision.nextAction==="CHECK_CI");
      decision=this.state.reconsider(id,this.context(id));
    }
    if(decision.nextAction==="CONTINUE")this.ciWait.finish(id,this.now(),"CI_GATE_RELEASED");
    if(decision.nextAction!=="CONTINUE")this.queue?.cancelPending(id,"dispatch");
    let command=null;
    if(decision.nextAction==="CALL_OPERATOR"&&this.inbox){
      const reasonCategory=this.state.latest(id)?.observation.humanActionCategory||
        (decision.reasonCode.includes("DISCONNECT")?"recovery":decision.reasonCode.includes("CI_")?"ci":"approval");
      const targets=this.github.targets.list().filter(t=>t.workstreamId===id);
      this.inbox.open(id,{reasonCategory,reasonCode:decision.reasonCode,actionFingerprint:decision.actionFingerprint,
        headSha:targets.length===1?targets[0].headSha:null,evidenceTimestamp:this.now(),expiresAt:this.now()+3_600_000});
    }
    if(decision.nextAction==="CONTINUE"){
      const dispatch=()=>{
        const reservation=this.state.reserve(id,decision.actionFingerprint,this.context(id));
        if(!reservation)return null;
        try{const queued=this.chat.queue(id,{observationIntent:reservation});
          if(!queued)this.state.settle(reservation.operationId,"blocked");return queued;
        }catch{this.state.settle(reservation.operationId,"unknown");return null;}
      };
      if(this.queue){const receipt=await this.queue.run({kind:"dispatch",resourceKey:id,workstreamId:id},dispatch);
        command=receipt.outcome==="completed"?receipt.value:null;
      }else command=dispatch();
    }
    const external=["WAIT_CI","CHECK_CI"].includes(decision.nextAction)?
      schedule.next_external_check_at>this.now()?schedule.next_external_check_at:this.now()+schedule.policy.externalIntervalMs:null;
    this.db.prepare("UPDATE autopilot_schedules SET next_inspect_at=?,next_external_check_at=?,updated_at=? WHERE workstream_id=?")
      .run(nextInspectAt,external,this.now(),id);
    return {workstreamId:id,decision,command};
  }
  async tick(){
    if(this.queue)for(const item of this.store.list())if(!item.enabled||item.paused||!this.get(item.id)?.enabled){
      this.queue.cancelPending(item.id,"inspect");this.queue.cancelPending(item.id,"dispatch");}
    const due=this.db.prepare("SELECT workstream_id FROM autopilot_schedules WHERE enabled=1 AND (next_inspect_at<=? OR next_external_check_at<=?) ORDER BY next_inspect_at,workstream_id").all(this.now(),this.now());
    const jobs=[];
    for(const row of due){
      if(this.inFlight.has(row.workstream_id))continue;
      const job=this.run(row.workstream_id).catch(()=>({workstreamId:row.workstream_id,errorCode:"AUTOPILOT_INSPECTION_FAILED"}))
        .finally(()=>this.inFlight.delete(row.workstream_id));
      this.inFlight.set(row.workstream_id,job);jobs.push(job);
    }
    return Promise.all(jobs);
  }
}
