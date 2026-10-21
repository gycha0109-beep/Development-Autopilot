import {ChromeObservationTransport} from "./chrome-observation-transport.js";
import {AutopilotCoordinator} from "./autopilot-coordinator.js";
import {OperatorInbox} from "./operator-inbox.js";
import {FairWorkQueue,QUEUE_KINDS} from "./fair-work-queue.js";
import {randomUUID} from "node:crypto";
import {hashAction} from "./autopilot-decision.js";
import {DisconnectRecovery} from "./disconnect-recovery.js";
import {ChromeRecoveryTransport} from "./chrome-recovery-transport.js";
import {RECOVERY_REPORT_MESSAGE} from "../extension/disconnect-page.js";
import {LoadingRecovery} from './loading-recovery.js';
import {ChromeMigrationResume} from './chrome-migration-resume.js';

export const runtimePolicy=Object.freeze({stableForMs:30_000,maxAgeMs:180_000,inspectIntervalMs:60_000,
  externalIntervalMs:60_000,disconnectDebounceMs:30_000,observationTimeoutMs:80_000});

function migrateDefaultRecoveryLease(store,limits){
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autopilot_queue_policies'").get())return;
  const legacy={...limits.recovery,leaseMs:90_000};
  store.transaction(()=>{
    const row=store.db.prepare("SELECT policy FROM autopilot_queue_policies WHERE kind='recovery'").get();
    if(row?.policy!==JSON.stringify(legacy))return; // Custom policies still require review.
    if(store.db.prepare("SELECT 1 FROM autopilot_queue_tasks WHERE kind='recovery' AND status IN ('pending','running')").get())
      throw Error("RECOVERY_POLICY_MIGRATION_HAS_ACTIVE_TASKS");
    // Versioned, exact-default-only upgrade: no leases, task history, next-start
    // time, existing campaigns, or authority are reset or extended.
    store.db.prepare("UPDATE autopilot_queue_policies SET policy=? WHERE kind='recovery' AND policy=?")
      .run(JSON.stringify(limits.recovery),row.policy);
  });
}

export class AutopilotRuntime {
  constructor(store,{bridge,chat,watchtower,github,gate,now=()=>Date.now()}={}){
    Object.assign(this,{store,chat,now});this.reviewEpoch=randomUUID();this.migrationWatches=new Map();
    this.transport=new ChromeObservationTransport(store,{bridge,now});
    const limits=Object.fromEntries(QUEUE_KINDS.map(kind=>[kind,{maxConcurrent:kind==="inspect"?20:1,
      minIntervalMs:kind==="dispatch"?1000:0,leaseMs:kind==="recovery"?330_000:90_000,backoffMs:10_000,maxFailures:3}]));
    migrateDefaultRecoveryLease(store,limits);
    this.queue=new FairWorkQueue(store,{limits,now});
    this.inbox=new OperatorInbox(store,{queue:this.queue,now});
    this.coordinator=new AutopilotCoordinator(store,{chat,watchtower,github,gate,inbox:this.inbox,queue:this.queue,now,
      observe:(id,options)=>{
        const recovery=this.recovery?.get(id);
        return this.transport.read(id,{...options,recoveryOperationId:recovery?.stage==="REPORT_RESULT_PENDING"?recovery.report_operation_id:null});
      }});
    store.db.exec(`CREATE TABLE IF NOT EXISTS chrome_recovery_scopes(
      workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),task_revision INTEGER NOT NULL,
      binding_fingerprint TEXT NOT NULL,campaign_hash TEXT NOT NULL,enabled INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,approved_at INTEGER NOT NULL) STRICT;`);
    this.recoveryTransport=new ChromeRecoveryTransport(store,{observation:this.transport,now,eligible:command=>{
      const row=this.recovery?.get(command.workstream_id);
      return !!row&&(command.kind==="stop"?row.stage==="STOP_INTENT_RECORDED"&&row.stop_operation_id===command.operation_id:
        row.stage==="REPORT_INTENT_RECORDED"&&row.report_operation_id===command.operation_id)&&
        this.recovery.guard(this.recovery.inputs(command.workstream_id,row),row)===null;
    }});
    this.recovery=new DisconnectRecovery(store,{state:this.coordinator.state,context:id=>this.coordinator.context(id),queue:this.queue,now,
      stop:intent=>this.recoveryTransport.perform(intent,"stop"),requestReport:intent=>this.recoveryTransport.perform(intent,"report"),
      verifyStopped:intent=>this.recoveryTransport.verify(intent,"stop"),verifyReport:intent=>this.recoveryTransport.verify(intent,"report")});
    this.coordinator.recovery=this.recovery;
    this.coordinator.recoveryCapability=id=>this.recoveryCapability(id);
    this.recovery.reconcile();
    this.loading=new LoadingRecovery(store,{transport:this.transport,state:this.coordinator.state,inbox:this.inbox,now});
    this.coordinator.loading=this.loading;
    this.coordinator.handoffCapability=id=>{
      try{const scope=this.transport.current(id);return this.migrationWatches.get(scope.extension_id)?.has(scope.session_key)===true;}
      catch{return false;}
    };
    this.migrationResume=new ChromeMigrationResume({store,coordinator:this.coordinator,transport:this.transport,now});
    this.transport.onObservation=(id,page)=>this.loading.notice(id,page);
    // Legacy time-only scheduled campaigns must be enrolled explicitly. Manual
    // one-shot approvals retain their existing path; no schedules are rewritten.
    const policy=chat.observationPolicy;
    const guard=id=>{
      if(this.loading.blocked(id))return 'RESPONSE_LOADING_RECOVERY_PENDING';
      if(!this.coordinator.get(id))return chat.config(id)?.mode==="scheduled"?"AUTOPILOT_ENROLLMENT_REQUIRED":null;
      try{this.transport.current(id);return null;}catch{return "OBSERVATION_SCOPE_CHANGED";}
    };
    const queue=policy.admitQueue,claim=policy.admitClaim;
    policy.admitQueue=(id,intent)=>guard(id)||queue(id,intent);
    policy.admitClaim=command=>guard(command.workstream_id)||claim(command);
    policy.commandProof=id=>this.coordinator.get(id)?this.coordinator.state.latest(id)?.observation:null;
  }
  updateMigrationWatches(extensionId,sessionKeys=[]){this.migrationWatches.set(extensionId,new Set(sessionKeys));}
  preview(id,permitted){
    if(this.coordinator.get(id)?.enabled||this.chat.hasPending(id))throw Error("AUTOPILOT_STOP_BEFORE_REBIND");
    this.transport.enable(id,permitted);
    void this.transport.read(id);
    return {requested:true};
  }
  configure(id,options){
    this.transport.current(id);
    const sample=this.transport.latest(id);
    if(!sample?.verified||this.now()-sample.observedAt>runtimePolicy.maxAgeMs)throw Error("AUTOPILOT_FRESH_PREVIEW_REQUIRED");
    return this.coordinator.configure(id,{...options,bindingFingerprint:sample.bindingFingerprint,policy:runtimePolicy});
  }
  stop(id){
    this.loading.stop(id);
    this.store.db.prepare("UPDATE chrome_recovery_scopes SET enabled=0 WHERE workstream_id=?").run(id);
    for(const row of this.store.db.prepare("SELECT operation_id FROM chrome_recovery_commands WHERE workstream_id=? AND state IN ('queued','claimed')").all(id))
      this.recoveryTransport.unknown(row.operation_id,"RECOVERY_PERMISSION_REVOKED");
    this.chat.stop(id);this.transport.disable(id);
    this.store.db.prepare("UPDATE autopilot_schedules SET enabled=0 WHERE workstream_id=?").run(id);
  }
  recoveryCampaign(id){const c=this.chat.config(id);return hashAction([c?.approvedAt,c?.expiresAt,c?.message,c?.maxMessages,c?.ciResumeTargetHash]);}
  configureRecovery(id,permitted){
    if(permitted!==true)throw Error("RECOVERY_EXPLICIT_PERMISSION_REQUIRED");
    const cfg=this.chat.config(id),schedule=this.coordinator.get(id),sample=this.transport.latest(id);
    this.transport.current(id);
    if(!this.recoveryTransport.supported(id))throw Error("RECOVERY_WORKER_UPGRADE_REQUIRED");
    if(!schedule?.enabled||!cfg?.enabled||cfg.mode!=="scheduled"||cfg.sentCount>=cfg.maxMessages||cfg.expiresAt<=this.now()||
      this.coordinator.state.pending(id)||sample?.verified!==true||sample.bindingFingerprint!==schedule.binding_fingerprint||
      this.now()-sample.observedAt>runtimePolicy.maxAgeMs)throw Error("RECOVERY_EXISTING_FRESH_APPROVAL_REQUIRED");
    if(this.recovery.get(id))throw Error("RECOVERY_EPISODE_ALREADY_EXISTS");
    this.store.db.prepare(`INSERT INTO chrome_recovery_scopes VALUES(?,?,?,?,1,?,?) ON CONFLICT(workstream_id) DO UPDATE SET
      task_revision=excluded.task_revision,binding_fingerprint=excluded.binding_fingerprint,campaign_hash=excluded.campaign_hash,
      enabled=1,expires_at=excluded.expires_at,approved_at=excluded.approved_at`)
      .run(id,schedule.task_revision,schedule.binding_fingerprint,this.recoveryCampaign(id),cfg.expiresAt,this.now());
    this.store.event(id,this.now(),"disconnect_permission",null,null,"ONE_STOP_ONE_FIXED_REPORT_NO_EXTRA_CONTINUE");
    return {enabled:true,maxEpisodes:1,maxReportMessages:1,expiresAt:cfg.expiresAt};
  }
  recoveryCapability(id){
    const row=this.store.db.prepare("SELECT * FROM chrome_recovery_scopes WHERE workstream_id=?").get(id),schedule=this.coordinator.get(id);
    const permitted=!!(row?.enabled&&this.now()<row.expires_at&&row.task_revision===schedule?.task_revision&&
      row.binding_fingerprint===schedule?.binding_fingerprint&&row.campaign_hash===this.recoveryCampaign(id)&&this.recoveryTransport.supported(id));
    return {scope:{recoveryPermitted:permitted,reportMessageHash:hashAction(RECOVERY_REPORT_MESSAGE)},
      policy:{maxRecoveryAttempts:1,recoveryCooldownMs:900_000,recoveryStepTimeoutMs:300_000}};
  }
  reviewKey(row){
    const id=row.workstream_id;
    return {requestId:row.id,revision:row.revision,epoch:this.reviewEpoch,
      targets:hashAction([this.coordinator.github.targets.list().filter(t=>t.workstreamId===id),
        this.coordinator.watchtower.targets.list().filter(t=>t.workstreamId===id)])};
  }
  reviewReady(row){
    const id=row.workstream_id,sample=this.transport.latest(id),delivery=this.transport.diagnostics(id),
      receipt=delivery.lastReceipt,schedule=this.coordinator.get(id),ws=this.store.mustGet(id);
    if(this.store.isStopped()||!ws.enabled||!ws.paused||!schedule?.enabled||schedule.task_revision!==ws.task_revision)
      return "REVIEW_SCOPE_NOT_ACTIVE";
    if(ws.active_operation_id||!["OBSERVING","READY"].includes(ws.state))return "OPERATOR_OPERATION_PENDING";
    const targets=this.coordinator.github.targets.list().filter(t=>t.workstreamId===id);
    if(row.head_sha!==null&&(targets.length!==1||targets[0].headSha!==row.head_sha))return "OPERATOR_TARGET_CHANGED";
    if(delivery.pending)return "OBSERVATION_ALREADY_PENDING";
    if(!receipt?.currentBinding||receipt.outcome!=="RECEIVED"||
      JSON.stringify(receipt.operatorReview)!==JSON.stringify(this.reviewKey(row))||
      !sample||sample.observedAt!==receipt.requestedAt||sample.observedAt>this.now()||
      this.now()-sample.observedAt>runtimePolicy.maxAgeMs)return "FRESH_OPERATOR_REVIEW_REQUIRED";
    if(sample.verified!==true||sample.bindingFingerprint!==schedule.binding_fingerprint||sample.contentComplete!==true||
      !/^[a-f0-9]{64}$/.test(sample.replyFingerprint||"")||sample.assistantBusy!==false||sample.composerHasDraft!==false||
      ["stopControlVerified","connectionWarning","lengthWarning","providerRestriction","otherWarning","uiAmbiguous","humanActionCue","ciWaitCue"]
        .some(key=>sample[key]!==false))return "OPERATOR_ACTION_STILL_REQUIRED";
    return null;
  }
  operatorCommand(body){
    if(body?.command!=="reinspect")return this.inbox.commandLocal(body,row=>{
      const reason=this.reviewReady(row);if(reason)throw Error(reason);
      const id=row.workstream_id,pending=this.coordinator.state.pending(id);
      if(pending){
        // Resolving one request never dismisses another request or uncertain operation.
        if(this.inbox.row(pending.id))return {resumed:false,reasonCode:"OTHER_OPERATOR_REQUEST_PENDING"};
        throw Error("OPERATOR_OPERATION_PENDING");
      }
      this.store.db.prepare("UPDATE workstreams SET paused=0,updated_at=? WHERE id=?").run(this.now(),id);
      this.store.db.prepare("UPDATE autopilot_schedules SET next_inspect_at=0,next_external_check_at=0,observation_after=?,updated_at=? WHERE workstream_id=?")
        .run(this.now(),this.now(),id);
      // No changes to campaign enabled/expiry/count/message/CI authority. The
      // coordinator must read again and pass the usual decision/claim guards.
      return {resumed:true};
    });
    const row=this.inbox.validateLocal(body),id=row.workstream_id,ws=this.store.mustGet(id),schedule=this.coordinator.get(id);
    if(!ws.paused||!schedule?.enabled||schedule.task_revision!==ws.task_revision)throw Error("REVIEW_SCOPE_NOT_ACTIVE");
    const key=this.reviewKey(row);
    const result=this.transport.review(id,key,()=>{
      const current=this.inbox.row(row.id);
      return !!current&&!["closed","consumed"].includes(current.state)&&this.now()<current.expires_at&&
        current.task_revision===this.store.mustGet(id).task_revision&&
        JSON.stringify(this.reviewKey(current))===JSON.stringify(key);
    });
    this.store.db.prepare("INSERT INTO operator_command_receipts VALUES(?,?,?,?,?,?)")
      .run(body.commandId,id,row.id,hashAction("localhost-operator"),body.command,this.now());
    this.store.event(id,this.now(),"operator_local_reinspect",null,null,"READ_ONLY_WHILE_PAUSED",row.id);
    return {accepted:true,...result};
  }
  snapshot(){return {scopes:this.store.list().map(ws=>({workstreamId:ws.id,
    enabled:!!this.transport.scope(ws.id)?.enabled,observation:this.transport.latest(ws.id),
    observationDelivery:this.transport.diagnostics(ws.id),
    recovery:{workerSupported:this.recoveryTransport.supported(ws.id),permitted:this.recoveryCapability(ws.id).scope.recoveryPermitted,
      episode:this.recovery.get(ws.id)},
    loadingRecovery:{workerSupported:this.loading.supported(ws.id),episode:this.loading.get(ws.id),
      scope:this.store.db.prepare('SELECT enabled,expires_at FROM loading_recovery_scopes WHERE workstream_id=?').get(ws.id)||null},
    schedule:this.coordinator.get(ws.id),ciWait:this.coordinator.ciWait.current(ws.id),
    decision:this.coordinator.state.latest(ws.id)?.decision||null})),inbox:this.inbox.list().map(item=>({...item,
      reviewReason:["closed","consumed","expired"].includes(item.state)?"REQUEST_ALREADY_REVIEWED":this.reviewReady(this.inbox.row(item.requestId))}))};}
  close(){const loading=this.loading.close();this.recoveryTransport.close();this.transport.close();return Promise.allSettled([...this.coordinator.inFlight.values(),loading]);}
}
