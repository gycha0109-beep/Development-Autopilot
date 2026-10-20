import {createHash} from "node:crypto";
import {decideGate} from "./decision-gate.js";
const hex=value=>typeof value==="string"&&/^[a-f0-9]{40}$/i.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const one=(rows,id)=>{const matches=(rows||[]).filter(r=>r.workstreamId===id);return matches.length===1?matches[0]:null;};

export function ciResumeTarget({workstream,watchtower,github}){
  const wt=one(watchtower?.targets,workstream.id),gh=one(github?.targets,workstream.id);
  if(!wt||!gh||!workstream.track_key||!hex(wt.headSha)||wt.headSha.toLowerCase()!==gh.headSha?.toLowerCase()||
    !positive(wt.repositoryId)||!positive(wt.runId)||!positive(wt.attempt)||!positive(gh.prNumber))return null;
  const target={workstreamId:workstream.id,taskRevision:workstream.task_revision,
    repository:workstream.repository,projectKey:workstream.project_key,trackKey:workstream.track_key,
    repositoryId:wt.repositoryId,prNumber:gh.prNumber,headSha:wt.headSha.toLowerCase(),runId:wt.runId,attempt:wt.attempt,
    watchtowerConfiguredAt:wt.configuredAt,githubConfiguredAt:gh.configuredAt};
  return {...target,targetHash:createHash("sha256").update(JSON.stringify([1,target,
    "REQUIRE_MERGED_AND_ALL_REQUIRED_CHECKS"])).digest("hex")};
}

// Permission is for a bounded chat continuation after verification, never merge/phase acceptance.
export function ciResumeCandidate(args){
  const target=ciResumeTarget(args);if(!target)return null;
  const gate=decideGate(args);
  if(!["WAIT_EXTERNAL","WAIT_HUMAN","REVIEWED"].includes(gate.decision))return null;
  const gh=one(args.github.results,args.workstream.id),wt=one(args.watchtower.results,args.workstream.id);
  if(gh?.runVerified!==true||gh.runId!==target.runId||gh.attempt!==target.attempt||
    gh.runCiState!==wt?.ciState)return null;
  return {...target,gateDecision:gate.decision};
}
