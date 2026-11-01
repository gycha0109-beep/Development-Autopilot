// Independent CI failure evidence for a chat, without creating a Workstream.
// It is advisory only: it can select an investigation macro, never authorize
// CI progression, a PR merge, or any user-restricted action.
const SHA=/^[a-f0-9]{40}$/;
const MAX_AGE_MS=5*60_000,RECENT_RUN_MS=3*60*60_000;
const at=x=>Number.isFinite(Date.parse(x||""))?Date.parse(x):NaN;
export function verifiedCiFailure({scan,incidents=[],registry,repository,now=Date.now()}={}){
  if(typeof repository!=="string"||!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository))
    return null;
  if(scan?.status!=="observed"||!Number.isSafeInteger(scan.checkedAt)||
     now-scan.checkedAt<0||now-scan.checkedAt>MAX_AGE_MS)return null;
  const registered=(registry?.repositories||[]).filter(r=>
    r.name===repository||r.fullName===repository||r.repository===repository);
  if(registered.length!==1)return null;
  const matches=(scan.repositories||[]).filter(r=>r.repository===repository);
  if(matches.length!==1)return null;
  const source=matches[0];
  if(source.status!=="observed"||!Array.isArray(source.runs)||
    !Number.isFinite(at(source.observedAt))||
    Math.abs(now-at(source.observedAt))>MAX_AGE_MS)return null;
  // A newer attempt for the same run always supersedes an older failure.
  const latest=new Map();
  for(const run of source.runs){
    if(!Number.isSafeInteger(run.runId)||run.runId<1||
      !Number.isSafeInteger(run.runAttempt)||run.runAttempt<1||
      !SHA.test(run.headSha||"")||!Number.isFinite(at(run.createdAt)))continue;
    const old=latest.get(run.runId);
    if(!old||run.runAttempt>old.runAttempt)latest.set(run.runId,run);
  }
  const failures=[...latest.values()].filter(run=>
    run.ciState==="FAILURE"&&now-at(run.createdAt)>=0&&
    now-at(run.createdAt)<=RECENT_RUN_MS&&
    incidents.some(i=>i.state==="open"&&i.code==="CI_FAILED"&&
      i.scope==="repo:"+repository+":"+run.runId+":"+run.runAttempt));
  if(failures.length===0)return null;
  const newest=failures.sort((a,b)=>at(b.createdAt)-at(a.createdAt))[0];
  return {identity:"ci:"+repository+":"+newest.runId+":"+newest.runAttempt+
    ":"+newest.headSha.toLowerCase(),repository,
    runId:newest.runId,runAttempt:newest.runAttempt,headSha:newest.headSha,
    workflowName:String(newest.workflowName||"").slice(0,100),
    observedAt:scan.checkedAt,advisoryOnly:true};
}
