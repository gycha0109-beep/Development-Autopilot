import {
  WatchtowerClient, WatchtowerError, matchingRepository, decideWatchtowerRun,
  safePositiveInteger,safeSha,safeTrack
} from "./watchtower-client.js";

function checkInput(input){
  if(!input || typeof input!=="object")throw new WatchtowerError("INVALID_TARGET");
  if(input.repositoryId===undefined)throw new WatchtowerError("INVALID_TARGET","Repository ID가 필요합니다.");
  safePositiveInteger(input.repositoryId,"Repository ID");
  safePositiveInteger(input.runId,"Run ID");
  safeSha(input.headSha);
  safePositiveInteger(input.attempt,"Attempt");
  return {
    repositoryId:input.repositoryId,
    runId:input.runId,
    headSha:input.headSha.toLowerCase(),
    attempt:input.attempt
  };
}
export class WatchtowerTargets {
  constructor(store){
    this.store=store;
    this.db=store.db;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS watchtower_targets(",
      "workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),",
      "repository_id INTEGER NOT NULL CHECK(repository_id>0),",
      "run_id INTEGER NOT NULL CHECK(run_id>0),",
      "head_sha TEXT NOT NULL,",
      "attempt INTEGER NOT NULL CHECK(attempt>0),",
      "configured_at INTEGER NOT NULL) STRICT;"
    ].join(" "));
  }
  list(){
    return this.db.prepare(
      "SELECT workstream_id AS workstreamId,repository_id AS repositoryId,"+
      "run_id AS runId,head_sha AS headSha,attempt,configured_at AS configuredAt "+
      "FROM watchtower_targets ORDER BY workstream_id"
    ).all();
  }
  set(workstreamId,input,at=Date.now()){
    const target=checkInput(input);
    return this.store.transaction(()=>{
      const workstream=this.store.mustGet(workstreamId);
      if(workstream.track_key)safeTrack(workstream.track_key);
      this.db.prepare(
        "INSERT INTO watchtower_targets(workstream_id,repository_id,run_id,head_sha,attempt,configured_at) "+
        "VALUES(?,?,?,?,?,?) ON CONFLICT(workstream_id) DO UPDATE SET "+
        "repository_id=excluded.repository_id,run_id=excluded.run_id,"+
        "head_sha=excluded.head_sha,attempt=excluded.attempt,configured_at=excluded.configured_at"
      ).run(workstreamId,target.repositoryId,target.runId,target.headSha,target.attempt,at);
      this.store.event(workstreamId,at,"watchtower_target_set",null,null,
        "operator_exact_run_binding_requires_independent_github_verification");
      return {...target,workstreamId,configuredAt:at};
    });
  }
  clear(workstreamId,at=Date.now()){
    return this.store.transaction(()=>{
      this.store.mustGet(workstreamId);
      this.db.prepare("DELETE FROM watchtower_targets WHERE workstream_id=?").run(workstreamId);
      this.store.event(workstreamId,at,"watchtower_target_clear",null,null,"operator_unlinked");
    });
  }
}

export class WatchtowerObserver {
  constructor(store,options={}){
    this.store=store;
    this.targets=new WatchtowerTargets(store);
    this.client=options.client||new WatchtowerClient();
    this.now=options.now||(()=>Date.now());
    this.snapshot={
      status:"not_checked",contractVersion:"1.0",
      checkedAt:null,registry:null,results:[],errorCode:null
    };
    this.pending=null;
    this.lastTargetSignature=null;
  }
  current(){
    return {
      ...this.snapshot,
      targets:this.targets.list()
    };
  }
  async refresh(){
    if(this.pending){
      await this.pending;
      if(this.lastTargetSignature!==JSON.stringify(this.targets.list()))return this.refresh();
      return this.current();
    }
    this.pending=this._refresh().finally(()=>{this.pending=null;});
    return this.pending;
  }
  async _refresh(){
    const checkedAt=this.now();
    const targets=this.targets.list();
    this.lastTargetSignature=JSON.stringify(targets);
    try{
      const [health,registry]=await Promise.all([
        this.client.health(),this.client.registry()
      ]);
      if(health.contractVersion!=="1.0")throw new WatchtowerError("CONTRACT_MISMATCH");
      const streams=new Map(this.store.list().map(w=>[w.id,w]));
      const results=[];
      for(const target of targets){
        const workstream=streams.get(target.workstreamId);
        if(!workstream){
          results.push({
            workstreamId:target.workstreamId,
            decision:"UNKNOWN",reason:"WORKSTREAM_NOT_FOUND",safeToAdvance:false
          });
          continue;
        }
        const match=matchingRepository(registry,workstream.repository,workstream.project_key);
        if(!match.matched || match.repository.id!==target.repositoryId){
          results.push({
            workstreamId:target.workstreamId,decision:"UNKNOWN",
            reason:match.matched?"REPOSITORY_ID_MISMATCH":match.reason,safeToAdvance:false
          });
          continue;
        }
        const track=workstream.track_key;
        if(track && !registry.tracks.some(t=>
          t.canonicalTrackKey===track && t.projectId===match.repository.projectId && t.active===true)){
          results.push({
            workstreamId:target.workstreamId,decision:"UNKNOWN",
            reason:"TRACK_NOT_REGISTERED_OR_INACTIVE",safeToAdvance:false
          });
          continue;
        }
        try{
          const run=await this.client.run({
            runId:target.runId,repositoryId:target.repositoryId,
            headSha:target.headSha,attempt:target.attempt
          });
          const decision=decideWatchtowerRun(run,{
            ...target,repository:workstream.repository,trackKey:track
          },checkedAt);
          results.push({
            workstreamId:target.workstreamId,runId:target.runId,
            headSha:target.headSha,attempt:target.attempt,
            ciState:run.ciState,evidenceState:run.evidenceState,
            workTrackKey:run.workTrackKey,responsibilityKind:run.responsibilityKind,
            ...decision
          });
        }catch(err){
          results.push({
            workstreamId:target.workstreamId,decision:"UNKNOWN",
            reason:err instanceof WatchtowerError?err.code:"WATCHTOWER_ERROR",safeToAdvance:false
          });
        }
      }
      this.snapshot={
        status:"connected",contractVersion:"1.0",checkedAt,
        registry:{
          projects:registry.projects.map(p=>({id:p.id,key:p.key,name:p.name,active:p.active})),
          repositories:registry.repositories.map(r=>({
            id:r.id,projectId:r.projectId,name:r.name,enabled:r.enabled,
            lastSuccessfulPollAt:r.lastSuccessfulPollAt,pollErrorCode:r.pollErrorCode
          })),
          tracks:registry.tracks.map(t=>({
            id:t.id,projectId:t.projectId,canonicalTrackKey:t.canonicalTrackKey,
            name:t.name,active:t.active
          }))
        },
        results,errorCode:null
      };
    }catch(err){
      this.snapshot={
        status:"unavailable",contractVersion:"1.0",checkedAt,
        registry:null,results:targets.map(t=>({
          workstreamId:t.workstreamId,decision:"UNKNOWN",reason:"WATCHTOWER_UNAVAILABLE",
          safeToAdvance:false
        })),
        errorCode:err instanceof WatchtowerError?err.code:"WATCHTOWER_ERROR"
      };
    }
    return this.current();
  }
}
