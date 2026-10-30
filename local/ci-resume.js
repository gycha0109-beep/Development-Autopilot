import { createHash } from "node:crypto";

const SHA=/^[a-f0-9]{40}$/i;
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function ciResumeCandidates({store,watchtower,github,gate,now=Date.now(),requireReviewed=true}){
  const wt=watchtower.current(),gh=github.current();
  if(wt.status!=="connected"||gh.status!=="observed")return [];
  return store.list().flatMap(workstream=>{
    const id=workstream.id;
    const decision=gate.one(id);
    if(!["REVIEWED","WAIT_HUMAN"].includes(decision?.decision)||
      (requireReviewed&&(decision.operatorReviewed!==true||!decision.expiresAt||decision.expiresAt<=now))||
      !decision.evidenceHash)return [];
    const wtTargets=wt.targets.filter(x=>x.workstreamId===id);
    const ghTargets=gh.targets.filter(x=>x.workstreamId===id);
    if(wtTargets.length!==1||ghTargets.length!==1)return [];
    const w=wtTargets[0],g=ghTargets[0];
    if(!SHA.test(w.headSha)||w.headSha.toLowerCase()!==g.headSha?.toLowerCase())return [];
    const wtResult=wt.results.filter(x=>x.workstreamId===id);
    const ghResult=gh.results.filter(x=>x.workstreamId===id);
    if(wtResult.length!==1||ghResult.length!==1||
      wtResult[0].decision!=="VERIFY_GITHUB"||wtResult[0].ciState!=="SUCCESS"||
      ghResult[0].state!=="MERGED_CONFIRMED"||ghResult[0].merged!==true||
      ghResult[0].requiredChecksVerified!==true)return [];
    const identity={workstreamId:id,repository:workstream.repository,trackKey:workstream.track_key,
      repositoryId:w.repositoryId,runId:w.runId,attempt:w.attempt,prNumber:g.prNumber,
      headSha:w.headSha.toLowerCase(),evidenceHash:decision.evidenceHash};
    return [{...identity,targetHash:hash(identity),expiresAt:decision.expiresAt||null}];
  });
}

export function ciFollowupStatus({workstreamId,watchtower,github,gate}){
  const decision=gate.one(workstreamId);
  const wt=watchtower.current(),gh=github.current();
  const w=wt.results.filter(x=>x.workstreamId===workstreamId);
  const g=gh.results.filter(x=>x.workstreamId===workstreamId);
  if(decision?.decision==="REVIEWED")return {action:"APPROVED_RESUME",reason:decision.reason};
  if(decision?.decision==="WAIT_HUMAN")return {action:"REQUIRE_APPROVAL",reason:decision.reason};
  if(decision?.decision==="WAIT_EXTERNAL")return {action:"WAIT_CI_OR_MERGE",reason:decision.reason};
  if(decision?.decision==="BLOCKED"&&w.length===1&&w[0].decision==="BLOCKED"&&
    wt.status==="connected"&&g.length===1&&gh.status==="observed")
    return {action:"REVIEW_FAILURE",reason:decision.reason};
  return {action:"STOP_UNVERIFIED",reason:decision?.reason||"NO_EVIDENCE"};
}
