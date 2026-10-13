import { GitHubVerifier,GitHubFactError,checkGitHubTarget } from "./github-verifier.js";

export class GitHubTargets {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS github_pr_targets(",
      "workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),",
      "pr_number INTEGER NOT NULL CHECK(pr_number>0),",
      "head_sha TEXT NOT NULL,configured_at INTEGER NOT NULL) STRICT;"
    ].join(" "));
  }
  list(){
    return this.db.prepare(
      "SELECT workstream_id AS workstreamId,pr_number AS prNumber,"+
      "head_sha AS headSha,configured_at AS configuredAt "+
      "FROM github_pr_targets ORDER BY workstream_id"
    ).all();
  }
  set(id,prNumber,headSha,at=Date.now()){
    const stream=this.store.mustGet(id);
    const target=checkGitHubTarget({repository:stream.repository,prNumber,headSha});
    return this.store.transaction(()=>{
      this.db.prepare(
        "INSERT INTO github_pr_targets(workstream_id,pr_number,head_sha,configured_at) "+
        "VALUES(?,?,?,?) ON CONFLICT(workstream_id) DO UPDATE SET "+
        "pr_number=excluded.pr_number,head_sha=excluded.head_sha,"+
        "configured_at=excluded.configured_at"
      ).run(id,target.prNumber,target.headSha,at);
      this.store.event(id,at,"github_target_set",null,null,
        "operator_exact_pr_and_sha_binding");
      return {...target,workstreamId:id,configuredAt:at};
    });
  }
  clear(id,at=Date.now()){
    this.store.transaction(()=>{
      this.store.mustGet(id);
      this.db.prepare("DELETE FROM github_pr_targets WHERE workstream_id=?").run(id);
      this.store.event(id,at,"github_target_clear",null,null,"operator_unlinked");
    });
  }
}

export class GitHubObserver {
  constructor(store,{verifier=new GitHubVerifier(),now=()=>Date.now(),watchtower=null}={}){
    this.store=store;
    this.verifier=verifier;
    this.now=now;
    this.watchtower=watchtower;
    this.targets=new GitHubTargets(store);
    this.snapshot={status:"not_checked",checkedAt:null,results:[],errorCode:null};
    this.pending=null;
    this.lastSignature=null;
  }
  current(){return {...this.snapshot,targets:this.targets.list()};}
  async refresh(){
    if(this.pending){
      await this.pending;
      if(this.lastSignature!==JSON.stringify(this.targets.list()))return this.refresh();
      return this.current();
    }
    this.pending=this._refresh().finally(()=>{this.pending=null;});
    return this.pending;
  }
  async _refresh(){
    const targets=this.targets.list();
    this.lastSignature=JSON.stringify(targets);
    const workstreams=new Map(this.store.list().map(w=>[w.id,w]));
    const watchTargets=this.watchtower?.targets.list()||[];
    const results=[];
    for(const target of targets){
      const stream=workstreams.get(target.workstreamId);
      if(!stream){
        results.push({workstreamId:target.workstreamId,state:"UNKNOWN",reason:"WORKSTREAM_NOT_FOUND",safeToAdvance:false});
        continue;
      }
      const watch=watchTargets.find(t=>t.workstreamId===target.workstreamId);
      if(watch&&watch.headSha.toLowerCase()!==target.headSha.toLowerCase()){
        results.push({workstreamId:target.workstreamId,state:"UNKNOWN",
          reason:"WATCHTOWER_GITHUB_HEAD_MISMATCH",safeToAdvance:false});
        continue;
      }
      try{
        const result=await this.verifier.verify({
          repository:stream.repository,prNumber:target.prNumber,headSha:target.headSha
        });
        results.push({workstreamId:target.workstreamId,repository:stream.repository,...result,safeToAdvance:false});
      }catch(error){
        results.push({
          workstreamId:target.workstreamId,state:"UNKNOWN",safeToAdvance:false,
          reason:error instanceof GitHubFactError?error.code:"GITHUB_UNAVAILABLE"
        });
      }
    }
    this.snapshot={status:"observed",checkedAt:this.now(),results,errorCode:null};
    return this.current();
  }
}
