// Synthetic CI contract, independent of any real Watchtower Registry or GitHub.
export const CI_TARGET=Object.freeze({repository:'sim-owner/sim-repo',projectKey:'sim-project',trackKey:'ops',repositoryId:12,runId:77,attempt:2,prNumber:18,headSha:'a'.repeat(40)});
export function ciResponse(path,query,config={state:'running'}){
  const t={...CI_TARGET,...config.identity},now=new Date().toISOString();
  const state=config.state==='success'?'SUCCESS':config.state==='failure'?'FAILURE':'RUNNING';
  if(config.state==='unknown')return {status:503,data:{error:'SYNTHETIC_UNAVAILABLE'}};
  const run={runId:t.runId,repositoryId:t.repositoryId,repository:t.repository,repositoryEnabled:true,headSha:t.headSha,
    runAttempt:t.attempt,latestKnownAttempt:t.attempt,targetVerified:true,safeToAdvance:false,workTrackKey:t.trackKey,workTrackActive:true,
    evidenceState:'FRESH',ciState:state,decisionState:state,responsibilityKind:'project-wide',attributionConflict:false,observedAt:now};
  const envelope=data=>({status:200,data:{contractVersion:'1.0',data}});
  if(path==='/v1/health')return envelope({bridge:'connected',version:'1.0'});
  if(path==='/v1/registry')return envelope({projects:[{id:3,key:t.projectKey,name:'Synthetic project',active:true}],
    repositories:[{id:t.repositoryId,projectId:3,name:t.repository,enabled:true,lastSuccessfulPollAt:now,pollErrorCode:null}],
    tracks:[{id:9,projectId:3,canonicalTrackKey:t.trackKey,name:'Synthetic Ops',active:true}]});
  if(path==='/v1/runs/77'){
    if(query.get('repository_id')!=='12'||query.get('head_sha')!==CI_TARGET.headSha||query.get('attempt')!=='2')return {status:409,data:{error:{code:'TARGET_MISMATCH'}}};
    return envelope({run});
  }
  const prefix='/github/repos/'+CI_TARGET.repository;
  const status=config.state==='running'?'in_progress':'completed',conclusion=config.state==='success'?'success':config.state==='failure'?'failure':null;
  if(path===prefix+'/pulls/18')return {status:200,data:{number:t.prNumber,merged:config.merged!==false,state:config.merged===false?'open':'closed',
    head:{sha:t.headSha,ref:'sim-feature',repo:{full_name:t.repository}},base:{ref:'main',repo:{full_name:t.repository}}}};
  if(path===prefix+'/actions/runs/77')return {status:200,data:{id:t.runId,repository:{full_name:t.repository},head_sha:t.headSha,
    run_attempt:t.attempt,pull_requests:[{number:t.prNumber,head:{sha:t.headSha}}],status,conclusion}};
  if(path===prefix+'/commits/'+CI_TARGET.headSha+'/check-runs')return {status:200,data:{total_count:1,check_runs:[{id:1,name:'CI',status,conclusion,app:{id:7}}]}};
  if(path===prefix+'/commits/'+CI_TARGET.headSha+'/status')return {status:200,data:{statuses:[]}};
  if(path===prefix+'/branches/main/protection/required_status_checks')return {status:200,data:{contexts:['CI'],checks:[]}};
  if(path===prefix+'/rules/branches/main')return {status:200,data:[]};
  return {status:404,data:{error:'SYNTHETIC_TARGET_NOT_FOUND'}};
}
