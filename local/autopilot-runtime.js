import {ChromeObservationTransport} from "./chrome-observation-transport.js";
import {AutopilotCoordinator} from "./autopilot-coordinator.js";
import {OperatorInbox} from "./operator-inbox.js";
import {FairWorkQueue,QUEUE_KINDS} from "./fair-work-queue.js";

export const runtimePolicy=Object.freeze({stableForMs:30_000,maxAgeMs:180_000,inspectIntervalMs:60_000,
  externalIntervalMs:60_000,disconnectDebounceMs:30_000,observationTimeoutMs:80_000});

export class AutopilotRuntime {
  constructor(store,{bridge,chat,watchtower,github,gate,now=()=>Date.now()}={}){
    Object.assign(this,{store,chat,now});
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
  snapshot(){return {scopes:this.store.list().map(ws=>({workstreamId:ws.id,
    enabled:!!this.transport.scope(ws.id)?.enabled,observation:this.transport.latest(ws.id),
    schedule:this.coordinator.get(ws.id),ciWait:this.coordinator.ciWait.current(ws.id),
    decision:this.coordinator.state.latest(ws.id)?.decision||null})),inbox:this.inbox.list()};}
  close(){this.transport.close();}
}
