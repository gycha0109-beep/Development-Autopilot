import {randomUUID} from "node:crypto";
import {projectObservation} from "./chat-observation.js";
import {REQUIRED_COMPOSER_BUILD} from "./chrome-bridge.js";

// Requests are deliberately process-local: restart invalidates every outstanding
// challenge. Only whitelisted observations (never URLs/bodies/drafts) persist.
export class ChromeObservationTransport {
  constructor(store,{bridge,now=()=>Date.now()}={}){
    Object.assign(this,{store,bridge,now});this.pending=new Map();this.reviews=new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS chrome_observation_scopes(
      workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,
      extension_id TEXT NOT NULL,session_key TEXT NOT NULL,linked_at INTEGER NOT NULL,
      task_revision INTEGER NOT NULL,enabled INTEGER NOT NULL,latest TEXT) STRICT;`);
    if(!store.db.prepare("PRAGMA table_info(chrome_observation_scopes)").all().some(c=>c.name==="receipt"))
      store.db.exec("ALTER TABLE chrome_observation_scopes ADD COLUMN receipt TEXT");
  }
  scope(id){return this.store.db.prepare("SELECT * FROM chrome_observation_scopes WHERE workstream_id=?").get(id);}
  link(id){
    const snap=this.bridge.getSnapshot(this.now());
    const link=snap.links.find(l=>l.workstreamId===id&&l.status==="connected");
    if(!link||!snap.clients.some(c=>c.extensionId===link.extensionId&&c.status==="online"))throw Error("OBSERVATION_TAB_NOT_CONNECTED");
    if(!snap.clients.some(c=>c.extensionId===link.extensionId&&c.composerBuild===REQUIRED_COMPOSER_BUILD))
      throw Error("OBSERVATION_WORKER_UPGRADE_REQUIRED");
    return link;
  }
  enable(id,permitted){
    if(permitted!==true)throw Error("OBSERVATION_EXPLICIT_PERMISSION_REQUIRED");
    const link=this.link(id),ws=this.store.mustGet(id);
    this.cancel(id);
    this.store.db.prepare(`INSERT INTO chrome_observation_scopes
      (workstream_id,extension_id,session_key,linked_at,task_revision,enabled,latest) VALUES(?,?,?,?,?,1,NULL)
      ON CONFLICT(workstream_id) DO UPDATE SET extension_id=excluded.extension_id,
      session_key=excluded.session_key,linked_at=excluded.linked_at,task_revision=excluded.task_revision,enabled=1,latest=NULL`)
      .run(id,link.extensionId,link.sessionKey,link.linkedAt,ws.task_revision);
    this.store.event(id,this.now(),"observation_scope_enabled",null,null,"EXPLICIT_READ_ONLY_PERMISSION");
  }
  current(id){
    const scope=this.scope(id),link=this.link(id),ws=this.store.mustGet(id);
    if(!scope?.enabled||scope.extension_id!==link.extensionId||scope.session_key!==link.sessionKey||
      scope.linked_at!==link.linkedAt||scope.task_revision!==ws.task_revision||this.store.isStopped()||!ws.enabled||
      (ws.paused&&this.reviews.get(id)?.valid()!==true))
      throw Error("OBSERVATION_SCOPE_CHANGED");
    return scope;
  }
  latest(id){const row=this.scope(id);return row?.latest?JSON.parse(row.latest):null;}
  diagnostics(id){
    const scope=this.scope(id),request=this.pending.get(id);
    const receipt=scope?.receipt?JSON.parse(scope.receipt):null;
    let link;try{link=this.link(id);}catch{ /* Historical receipt stays visible, never current proof. */ }
    return {pending:request?{requestId:request.requestId,requestedAt:request.issuedAt,deadlineAt:request.deadlineAt}:null,
      lastReceipt:receipt?{...receipt,currentBinding:receipt.linkedAt===scope.linked_at&&
        receipt.taskRevision===scope.task_revision&&receipt.sessionKey===scope.session_key&&
        receipt.extensionId===scope.extension_id&&link?.linkedAt===receipt.linkedAt&&
        link?.sessionKey===receipt.sessionKey&&link?.extensionId===receipt.extensionId&&
        this.store.get(id)?.task_revision===receipt.taskRevision}:null};
  }
  // Diagnostic receipts are evidence of delivery only, never response/dispatch
  // proof. Only server challenge metadata and projected reason codes persist.
  settle(id,request,outcome,reasonCode,observation=null){
    const finishedAt=this.now();
    if(this.scope(id)&&this.store.get(id))this.store.transaction(()=>{
      const receipt={requestId:request.requestId,extensionId:request.extensionId,sessionKey:request.sessionKey,
        linkedAt:request.linkedAt,taskRevision:request.taskRevision,requestedAt:request.issuedAt,
        finishedAt,roundTripMs:Math.max(0,finishedAt-request.issuedAt),outcome,reasonCode,
        ...(request.review?{operatorReview:request.review}: {})};
      this.store.db.prepare("UPDATE chrome_observation_scopes SET receipt=? WHERE workstream_id=?")
        .run(JSON.stringify(receipt),id);
      // Clearing a prior sample on failed delivery prevents its display as a
      // fresh observation. The receipt/event preserve the diagnostic history.
      this.store.db.prepare("UPDATE chrome_observation_scopes SET latest=? WHERE workstream_id=?")
        .run(observation?JSON.stringify(observation):null,id);
      this.store.event(id,finishedAt,"chrome_observation_"+outcome.toLowerCase(),null,null,reasonCode);
    });
    this.pending.delete(id);this.reviews.delete(id);request.finish(observation);
    this.onObservation?.(id,observation);
  }
  cancel(id){const request=this.pending.get(id);if(request)this.settle(id,request,"CANCELLED","OBSERVATION_CANCELLED");}
  disable(id){this.cancel(id);this.store.db.prepare("UPDATE chrome_observation_scopes SET enabled=0,latest=NULL WHERE workstream_id=?").run(id);}
  review(id,metadata,valid){
    if(this.pending.has(id))throw Error("OBSERVATION_ALREADY_PENDING");
    this.reviews.set(id,{metadata,valid});
    try{void this.read(id);}catch(error){this.reviews.delete(id);throw error;}
    return {requested:true};
  }
  read(id,{signal,timeoutMs=80_000,recoveryOperationId=null,loadingRecoveryId=null}={}){
    const scope=this.current(id);
    if(this.pending.has(id))throw Error("OBSERVATION_ALREADY_PENDING");
    if(signal?.aborted)return Promise.resolve(null);
    return new Promise(resolve=>{
      let timer;
      const abort=()=>this.cancel(id);
      const finish=value=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);resolve(value);};
      const request={requestId:randomUUID(),workstreamId:id,sessionKey:scope.session_key,
        extensionId:scope.extension_id,linkedAt:scope.linked_at,taskRevision:scope.task_revision,
        issuedAt:this.now(),deadlineAt:this.now()+timeoutMs,finish,
        ...(this.reviews.has(id)?{review:this.reviews.get(id).metadata}: {}),
        ...(/^[a-f0-9-]{36}$/.test(recoveryOperationId||"")?{recoveryOperationId}:{}),
        ...(/^[a-f0-9-]{36}$/.test(loadingRecoveryId||"")?{loadingRecoveryId}:{})};
      this.pending.set(id,request);
      signal?.addEventListener("abort",abort,{once:true});
      timer=setTimeout(()=>this.settle(id,request,"TIMEOUT","OBSERVATION_DELIVERY_TIMEOUT"),timeoutMs);timer.unref?.();
    });
  }
  requests(extensionId){
    const result=[];
    for(const [id,request] of this.pending){
      try{this.current(id);}catch{this.cancel(id);continue;}
      if(request.extensionId===extensionId)result.push({requestId:request.requestId,workstreamId:id,
        sessionKey:request.sessionKey,taskRevision:request.taskRevision,
        ...(request.recoveryOperationId?{recoveryOperationId:request.recoveryOperationId}:{}),
        ...(request.loadingRecoveryId?{loadingRecoveryId:request.loadingRecoveryId}:{})});
    }
    return result;
  }
  accept(extensionId,{requestId,observation}={}){
    const request=[...this.pending.values()].find(r=>r.requestId===requestId&&r.extensionId===extensionId);
    if(!request)throw Error("OBSERVATION_CHALLENGE_NOT_CURRENT");
    this.current(request.workstreamId);
    // Timestamp is challenge issuance, not a browser-supplied clock or receipt
    // time. A late upload cannot become a fresh observation after a restart.
    const projected=projectObservation(observation,request.issuedAt);
    if(projected.recoveryReportProof?.operationId!==request.recoveryOperationId)delete projected.recoveryReportProof;
    this.settle(request.workstreamId,request,"RECEIVED",projected.reasonCode,projected);
    return {accepted:true};
  }
  close(){for(const id of this.pending.keys())this.cancel(id);}
}
