import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {normalizeRepository} from "./repository-directory.js";
import {validCiBranch} from "./github-chat-ci.js";

const runFile=promisify(execFile);
const POLL_MS=60_000,MAX_AGE_MS=5*60_000;
export async function fetchGitHubBranchHead(repository,branch,{run=runFile}={}){
  const name=normalizeRepository(repository);
  if(!validCiBranch(branch))throw Error("COMPLETION_BRANCH_INVALID");
  const {stdout}=await run("gh",["api",
    "/repos/"+name+"/branches/"+encodeURIComponent(branch),
    "-H","Accept: application/vnd.github+json"],{
      timeout:15_000,maxBuffer:512*1024,windowsHide:true
    });
  let payload;
  try{payload=JSON.parse(stdout);}catch{throw Error("COMPLETION_HEAD_INVALID_JSON");}
  if(!SHA40.test(payload?.commit?.sha||""))
    throw Error("COMPLETION_HEAD_UNVERIFIED");
  return payload.commit.sha;
}
export class RoadmapCiHeadObserver{
  constructor({targets=()=>[],read=fetchGitHubBranchHead,
    now=()=>Date.now(),pollMs=POLL_MS}={}){
    this.targets=targets;this.read=read;this.now=now;this.pollMs=pollMs;
    this.heads=new Map();this.lastStarted=null;this.refreshing=null;
  }
  state(repository,branch){
    const value=this.heads.get(repository+"@"+branch);
    if(!value||value.checkedAt>this.now()||
      this.now()-value.checkedAt>MAX_AGE_MS)return {status:"unknown"};
    return value;
  }
  async refresh({force=false}={}){
    if(this.refreshing)return this.refreshing;
    const at=this.now();
    if(!force&&this.lastStarted!==null&&at-this.lastStarted<this.pollMs)
      return this.heads.size;
    const targets=new Map();
    for(const row of this.targets()){
      try{
        const repo=normalizeRepository(row.repository);
        if(!validCiBranch(row.branch))continue;
        targets.set(repo+"@"+row.branch,{repository:repo,branch:row.branch});
      }catch{}
    }
    this.lastStarted=at;
    this.refreshing=(async()=>{
      const next=new Map();
      for(const [key,target] of [...targets].slice(0,20)){
        try{
          const headSha=await this.read(target.repository,target.branch);
          next.set(key,SHA40.test(headSha||"")?{
            status:"observed",headSha,checkedAt:this.now()}:{status:"unknown"});
        }catch{next.set(key,{status:"unknown",checkedAt:this.now()});}
      }
      this.heads=next;
      return next.size;
    })().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
}
// Completion is scoped to a registered chat and its approved repository.
// A model statement is advisory. Only an independently observed latest
// GitHub CI HEAD with every required run green can satisfy the CI gate.
const SHA40=/^[a-f0-9]{40}$/;
const SHA64=/^[a-f0-9]{64}$/;
export const ROADMAP_AUDIT_PROMPT=[
  "현재 승인된 프로젝트 지침과 로드맵의 범위만 대상으로 최종 완료 감사를 1회 수행하세요.",
  "프로젝트 지침, 로드맵 필수 항목, 실제 코드·테스트·문서·인수인계와 최신 CI를 대조하세요.",
  "새 기능이나 새 로드맵을 임의로 추가하지 마세요. 누락된 필수 작업이 있다면 구체적으로 보고하세요.",
  "항목별 증거와 출처를 본문에 제시하고, 마지막에 다음 형식의 독립된 문단을 정확히 출력하세요.",
  "ROADMAP_AUDIT: COMPLETE 또는 ROADMAP_AUDIT: INCOMPLETE 또는 ROADMAP_AUDIT: BLOCKED",
  "ROADMAP_AUDIT_SCOPE: 실제 확인한 승인 로드맵의 이름과 버전",
  "ROADMAP_AUDIT_CI_SHA: 검증한 최신 Git 커밋 SHA(40자 소문자, 없으면 NONE)",
  "COMPLETE는 필수 작업·검증·문서·승인 항목이 모두 충족되고 동일 SHA의 CI가 그린일 때만 사용하세요.",
  "모르는 항목은 완료라고 추측하지 말고 BLOCKED로 표시하세요."
].join("\n");

export function completionCiEvidence(ciState,repository,branch=null){
  if(!repository||!branch||ciState?.status!=="observed"||
    ciState?.ciState!=="SUCCESS"||ciState.repository!==repository||
    ciState.branch!==branch||
    !Array.isArray(ciState.runs)||ciState.runs.length===0)return null;
  if(ciState.runs.some(x=>x.ciState!=="SUCCESS"||!SHA40.test(x.headSha||"")||
    !Number.isSafeInteger(x.runId)||x.runId<1||
    !Number.isSafeInteger(x.runAttempt)||x.runAttempt<1))return null;
  const heads=[...new Set(ciState.runs.map(x=>x.headSha))];
  if(heads.length!==1||ciState.verifiedBranchHead!==heads[0])return null;
  return {headSha:heads[0],
    runCount:ciState.runs.length,
    runIdentity:ciState.runs.map(x=>x.runId+":"+x.runAttempt).sort().join(",")};
}
export function completionOutcome(observation,{expectedHead,ciEvidence}={}){
  if(observation?.roadmapAuditResult==="INCOMPLETE")
    return {status:"incomplete",reason:"ROADMAP_AUDIT_INCOMPLETE"};
  if(observation?.roadmapAuditResult==="BLOCKED")
    return {status:"attention",reason:"ROADMAP_AUDIT_BLOCKED"};
  if(observation?.roadmapAuditResult!=="COMPLETE")
    return {status:"attention",reason:"ROADMAP_AUDIT_RESULT_MISSING"};
  if(observation.roadmapAuditScopeProvided!==true)
    return {status:"attention",reason:"ROADMAP_AUDIT_SCOPE_MISSING"};
  if(!SHA40.test(expectedHead||"")||!ciEvidence||
    expectedHead!==ciEvidence.headSha||
    observation.roadmapAuditHeadSha!==expectedHead)
    return {status:"attention",reason:"ROADMAP_AUDIT_CI_UNVERIFIED"};
  if(!SHA64.test(observation.replyFingerprint||""))
    return {status:"attention",reason:"ROADMAP_AUDIT_REPLY_UNVERIFIED"};
  return {status:"completed",reason:"ROADMAP_COMPLETE_VERIFIED",
    headSha:expectedHead,runIdentity:ciEvidence.runIdentity};
}
