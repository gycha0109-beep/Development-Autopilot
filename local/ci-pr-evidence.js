// Watchtower v0.3.41 PR-scoped evidence. A workflow_dispatch integration
// Run can have a different Run SHA from the PR candidate SHA.
// This class only observes; it never authorizes a merge, retry or macro.
const SHA=/^[a-f0-9]{40}$/i;
const fresh=(at,now,limit)=>Number.isSafeInteger(at)&&at<=now+5000&&now-at<=limit;
const nonempty=value=>typeof value==="string"&&value.length>0;

export function assessPrRun(run,scope,now=Date.now()){
  const unknown=(reason,extras={})=>({kind:run?.ciKind??"unknown",state:"UNKNOWN",
    reason,runId:run?.runId??null,attempt:run?.runAttempt??null,
    runSha:run?.headSha??null,candidateSha:run?.integrationCandidateHeadSha??null,
    integrationBaselineVerified:false,safeToAdvance:false,...extras});
  if(!scope||!run||!["general","integration"].includes(run.ciKind))
    return unknown("CI_KIND_UNKNOWN");
  if(run.prNumber!==scope.prNumber||run.prIdentityConflict!==false||
     run.ciKindSource!=="workflow_path"||
     !["github_pull_requests","integration_title","github_and_integration_title"]
       .includes(run.prIdentitySource)||
     run.repositoryId!==scope.repositoryId||run.repository!==scope.repository||
     !Number.isSafeInteger(run.runId)||run.runId<=0||
     !Number.isSafeInteger(run.runAttempt)||run.runAttempt<=0||
     !SHA.test(run.headSha||""))
    return unknown("PR_RUN_IDENTITY_MISMATCH");
  if(run.ciKind==="general"&&run.headSha.toLowerCase()!==scope.headSha.toLowerCase())
    return unknown("GENERAL_RUN_PR_HEAD_MISMATCH");
  if(run.ciKind==="integration"&&
     (!SHA.test(run.integrationCandidateHeadSha||"")||
      run.integrationCandidateHeadSha.toLowerCase()!==scope.headSha.toLowerCase()))
    return unknown("INTEGRATION_CANDIDATE_HEAD_MISMATCH");
  if(run.targetVerified!==true||run.latestKnownAttempt!==run.runAttempt||
     run.attributionConflict===true||run.repositoryEnabled!==true||
     run.evidenceState!=="FRESH"||run.decisionState!==run.ciState||
     run.safeToAdvance!==false||run.pollErrorCode||
     !nonempty(run.observedAt)||!Number.isFinite(Date.parse(run.observedAt))||
     Math.abs(Date.parse(run.observedAt)-now)>60_000)
    return unknown("PR_RUN_EVIDENCE_UNVERIFIED");
  const baseVerified=run.ciKind==="integration"&&run.integrationBaselineVerified===true&&
    SHA.test(run.integrationCandidateBaseSha||"");
  const raw=run.ciState;
  const state=["QUEUED","RUNNING"].includes(raw)?"PENDING":
    raw==="FAILURE"?"RED":raw==="SUCCESS"?
      (run.ciKind==="integration"&&!baseVerified?"UNKNOWN":"GREEN"):"UNKNOWN";
  return unknown(state==="UNKNOWN"&&run.ciKind==="integration"&&raw==="SUCCESS"?
      "INTEGRATION_BASELINE_UNVERIFIED":raw==="SUCCESS"?
      "CI_SUCCESS_EVIDENCE_ONLY":raw==="FAILURE"?"CI_FAILURE":raw==="RUNNING"||raw==="QUEUED"?
      "CI_RUNNING":"PR_RUN_INDETERMINATE",
    {kind:run.ciKind,state,ciState:raw,
     integrationBaselineVerified:baseVerified,
     candidateSha:run.integrationCandidateHeadSha??null,
     candidateBaseSha:baseVerified?run.integrationCandidateBaseSha:null});
}

function exactIdentity(a,b){
  return a?.runId===b?.runId && a?.runAttempt===b?.runAttempt &&
    a?.headSha===b?.headSha && a?.prNumber===b?.prNumber &&
    a?.repositoryId===b?.repositoryId && a?.ciKind===b?.ciKind &&
    a?.integrationCandidateHeadSha===b?.integrationCandidateHeadSha &&
    a?.integrationCandidateBaseSha===b?.integrationCandidateBaseSha &&
    a?.integrationBaselineVerified===b?.integrationBaselineVerified;
}

export class CiPrEvidenceObserver {
  constructor({watchtower,github,store,now=()=>Date.now()}={}){
    this.watchtower=watchtower;this.github=github;this.store=store;this.now=now;
    this.pending=null;
    this.snapshot={status:"not_checked",checkedAt:null,results:[],errorCode:null};
  }
  current(){return this.snapshot;}
  async refresh(){
    if(this.pending)return this.pending;
    this.pending=this._refresh().finally(()=>{this.pending=null;});
    return this.pending;
  }
  async _refresh(){
    const now=this.now(),watch=this.watchtower.current(),github=this.github.current();
    const targets=github.targets||[],wtTargets=watch.targets||[];
    const results=[];
    for(const target of targets){
      const workstream=this.store.get(target.workstreamId);
      const wt=wtTargets.filter(x=>x.workstreamId===target.workstreamId);
      const original={workstreamId:target.workstreamId,repository:workstream?.repository||null,
        prNumber:target.prNumber,headSha:target.headSha,status:"unknown",runs:[],
        completeCoverage:false,reason:"EVIDENCE_MISSING"};
      if(!workstream||!SHA.test(target.headSha||"")||wt.length!==1||
         wt[0].headSha!==target.headSha||
         watch.status!=="connected"||watch.contractVersion!=="1.0"||
         github.status!=="observed"||
         !fresh(watch.checkedAt,now,90000)||!fresh(github.checkedAt,now,180000)||
         watch.checkedAt<wt[0].configuredAt||github.checkedAt<target.configuredAt){
        results.push({...original,reason:"PR_BINDING_OR_OBSERVATION_UNAVAILABLE"});
        continue;
      }
      const scope={prNumber:target.prNumber,headSha:target.headSha,
        repositoryId:wt[0].repositoryId,repository:workstream.repository};
      try{
        const response=await this.watchtower.client.runs({
          repositoryId:scope.repositoryId,prNumber:scope.prNumber,limit:100});
        // This listing is explicitly incomplete and cannot prove no CI exists.
        if(response.completeCoverage!==false||!Array.isArray(response.runs))
          throw Error("INCOMPLETE_PR_RUN_LIST");
        if(response.runs.some(x=>!x.ciKind||!Object.hasOwn(x,"prNumber")))
          throw Object.assign(Error("PR_SCOPED_BRIDGE_UNSUPPORTED"),
            {code:"PR_SCOPED_BRIDGE_UNSUPPORTED"});
        const selected=[];
        for(const kind of ["general","integration"]){
          const matches=response.runs.filter(x=>x.ciKind===kind);
          matches.sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)||
            b.runId-a.runId);
          if(matches.length===0)continue;
          const latest=matches[0];
          // Do not backfill an older success if the newest attempt is stale.
          const exact=await this.watchtower.client.run({runId:latest.runId,
            repositoryId:scope.repositoryId,headSha:latest.headSha,
            attempt:latest.runAttempt,prNumber:scope.prNumber});
          if(!exactIdentity(latest,exact)){
            selected.push({kind,state:"UNKNOWN",reason:"RUN_CHANGED_BETWEEN_READS",
              runId:latest.runId,attempt:latest.runAttempt,safeToAdvance:false});
            continue;
          }
          const result=assessPrRun(exact,scope,now);
          // Track identity is observational association, never reassignment.
          // Project-wide and integration workflows are associated with a PR
          // without becoming track-owned. A *contradictory* track remains unsafe.
          if(workstream.track_key&&exact.workTrackKey&&
             exact.workTrackKey!==workstream.track_key)
            selected.push({...result,state:"UNKNOWN",reason:"WORK_TRACK_MISMATCH"});
          else selected.push(result);
        }
        const unchanged=this.github.current().targets.find(t=>t.workstreamId===target.workstreamId);
        const watchUnchanged=this.watchtower.current().targets.find(t=>t.workstreamId===target.workstreamId);
        if(!unchanged||unchanged.headSha!==target.headSha||
           unchanged.prNumber!==target.prNumber||
           !watchUnchanged||watchUnchanged.runId!==wt[0].runId||
           watchUnchanged.attempt!==wt[0].attempt)
          results.push({...original,reason:"TARGET_CHANGED_DURING_REFRESH"});
        else
          results.push({...original,status:"observed",reason:"PR_SCOPED_EVIDENCE",
            runs:selected});
      }catch(error){
        results.push({...original,reason:error?.code||"PR_SCOPED_BRIDGE_UNAVAILABLE"});
      }
    }
    const latestTargets=this.github.current().targets;
    this.snapshot={status:"observed",checkedAt:now,results:
      JSON.stringify(latestTargets)===JSON.stringify(targets)?results:[],
      errorCode:null};
    return this.current();
  }
}
