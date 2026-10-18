import {AutopilotState} from "./autopilot-state.js";
import {decideNextAction,hashAction} from "./autopilot-decision.js";
import {MigrationContinuity} from "./migration-continuity.js";

// Injectable/offline runtime. No default page reader, browser activation or API.
// Opted-in workstreams use existing ChatContinuation queue/claim/ACK exclusively.
export class AutopilotCoordinator {
  constructor(store,{chat,watchtower,github,gate,observe,verifyMigration=null,now=()=>Date.now()}={}){
    if(!chat||!watchtower||!github||!gate||typeof observe!=="function")throw Error("AUTOPILOT_ADAPTERS_REQUIRED");
    Object.assign(this,{store,db:store.db,chat,watchtower,github,gate,observe,now});
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
      messageHash:hashAction(cfg?.message),observationPermitted:!!schedule,executionPermitted:!!schedule,
      remainingWork:!!schedule?.remaining_work,nextEligibleDispatchAt:cfg?.nextDueAt,evidenceHash:cfg?.evidenceHash},
      ci:{watchtower:this.watchtower.current(),github:this.github.current(),review:this.gate.getReview?.(id)||null}};
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
    this.externalPending=Promise.allSettled([Promise.resolve().then(()=>this.watchtower.refresh()),
      Promise.resolve().then(()=>this.github.refresh())]).finally(()=>{this.externalPending=null;});
    return this.externalPending;
  }
  async read(id,schedule){
    let timer;
    try{return await Promise.race([Promise.resolve().then(()=>this.observe(id)),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error("OBSERVATION_TIMEOUT")),schedule.policy.observationTimeoutMs);
    })]);}catch{return {schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",verified:false,observedAt:this.now()};}
    finally{clearTimeout(timer);}
  }
  async run(id){
    const schedule=this.get(id);
    if(!schedule?.enabled||this.store.isStopped()||!this.store.mustGet(id).enabled||this.store.mustGet(id).paused)return null;
    if(schedule.next_external_check_at!==null&&schedule.next_external_check_at<=this.now())await this.refreshExternal();
    let decision=schedule.next_inspect_at<=this.now()?
      this.state.evaluate(id,await this.read(id,schedule),this.context(id)):this.state.reconsider(id,this.context(id));
    if(!decision)return null;
    if(["WAIT_CI","CHECK_CI"].includes(decision.nextAction)&&schedule.next_external_check_at===null){
      await this.refreshExternal();decision=this.state.reconsider(id,this.context(id));
    }
    let command=null;
    if(decision.nextAction==="CONTINUE"){
      const reservation=this.state.reserve(id,decision.actionFingerprint,this.context(id));
      if(reservation){
        try{
          command=this.chat.queue(id,{observationIntent:reservation});
          if(!command)this.state.settle(reservation.operationId,"blocked");
        }catch{this.state.settle(reservation.operationId,"unknown");}
      }
    }
    const external=["WAIT_CI","CHECK_CI"].includes(decision.nextAction)?
      schedule.next_external_check_at>this.now()?schedule.next_external_check_at:this.now()+schedule.policy.externalIntervalMs:null;
    this.db.prepare("UPDATE autopilot_schedules SET next_inspect_at=?,next_external_check_at=?,updated_at=? WHERE workstream_id=?")
      .run(schedule.next_inspect_at<=this.now()?this.now()+schedule.policy.inspectIntervalMs:schedule.next_inspect_at,external,this.now(),id);
    return {workstreamId:id,decision,command};
  }
  async tick(){
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
