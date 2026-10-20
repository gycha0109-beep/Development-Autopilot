import {ChromeObservationTransport} from "./chrome-observation-transport.js";
import {AutopilotCoordinator} from "./autopilot-coordinator.js";
import {OperatorInbox} from "./operator-inbox.js";
import {FairWorkQueue,QUEUE_KINDS} from "./fair-work-queue.js";
import {randomUUID} from "node:crypto";
import {hashAction} from "./autopilot-decision.js";

export const runtimePolicy=Object.freeze({stableForMs:30_000,maxAgeMs:180_000,inspectIntervalMs:60_000,
  externalIntervalMs:60_000,disconnectDebounceMs:30_000,observationTimeoutMs:80_000});

export class AutopilotRuntime {
  constructor(store,{bridge,chat,watchtower,github,gate,now=()=>Date.now()}={}){
    Object.assign(this,{store,chat,now});this.reviewEpoch=randomUUID();
    this.transport=new ChromeObservationTransport(store,{bridge,now});
    const limits=Object.fromEntries(QUEUE_KINDS.map(kind=>[kind,{maxConcurrent:kind==="inspect"?20:1,
      minIntervalMs:kind==="dispatch"?1000:0,leaseMs:90_000,backoffMs:10_000,maxFailures:3}]));
    this.queue=new FairWorkQueue(store,{limits,now});
    this.inbox=new OperatorInbox(store,{queue:this.queue,now});
    this.coordinator=new AutopilotCoordinator(store,{chat,watchtower,github,gate,inbox:this.inbox,queue:this.queue,now,
      observe:(id,options)=>this.transport.read(id,options)});
    // Legacy time-only scheduled campaigns must be enrolled explicitly. Manual
    // one-shot approvals retain their existing path; no schedules are rewritten.
    const policy=chat.observationPolicy;
    const guard=id=>{
      if(!this.coordinator.get(id))return chat.config(id)?.mode==="scheduled"?"AUTOPILOT_ENROLLMENT_REQUIRED":null;
      try{this.transport.current(id);return null;}catch{return "OBSERVATION_SCOPE_CHANGED";}
    };
    const queue=policy.admitQueue,claim=policy.admitClaim;
    policy.admitQueue=(id,intent)=>guard(id)||queue(id,intent);
    policy.admitClaim=command=>guard(command.workstream_id)||claim(command);
    policy.commandProof=id=>this.coordinator.get(id)?this.coordinator.state.latest(id)?.observation:null;
  }
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
    this.chat.stop(id);this.transport.disable(id);
    this.store.db.prepare("UPDATE autopilot_schedules SET enabled=0 WHERE workstream_id=?").run(id);
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
    schedule:this.coordinator.get(ws.id),ciWait:this.coordinator.ciWait.current(ws.id),
    decision:this.coordinator.state.latest(ws.id)?.decision||null})),inbox:this.inbox.list().map(item=>({...item,
      reviewReason:["closed","consumed","expired"].includes(item.state)?"REQUEST_ALREADY_REVIEWED":this.reviewReady(this.inbox.row(item.requestId))}))};}
  close(){this.transport.close();}
}
