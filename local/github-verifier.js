import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);
const SHA=/^[a-f0-9]{40}$/i;
const REPO=/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export class GitHubFactError extends Error {
  constructor(code,message=code){
    super(message);this.name="GitHubFactError";this.code=code;
  }
}
export function checkGitHubTarget({repository,prNumber,headSha,runId,attempt}){
  if(typeof repository!=="string"||!REPO.test(repository))
    throw new GitHubFactError("INVALID_TARGET","Repository는 owner/repo 형식이어야 합니다.");
  if(!Number.isSafeInteger(prNumber)||prNumber<1)
    throw new GitHubFactError("INVALID_TARGET","PR 번호가 올바르지 않습니다.");
  if(typeof headSha!=="string"||!SHA.test(headSha))
    throw new GitHubFactError("INVALID_TARGET","Head SHA는 40자리입니다.");
  if ((runId!==undefined || attempt!==undefined) &&
      (!Number.isSafeInteger(runId)||runId<1||!Number.isSafeInteger(attempt)||attempt<1))
    throw new GitHubFactError("INVALID_TARGET","Run ID와 Attempt를 함께 지정해야 합니다.");
  return {repository,prNumber,headSha:headSha.toLowerCase(),
    ...(runId===undefined?{}:{runId,attempt})};
}

// A green commit check is not proof that the configured Run/Attempt belongs to this PR.
export function verifyGitHubRun(target,before,after,{prBefore,prAfter,commitPulls}={}){
  const unknown=reason=>({runVerified:false,runReason:reason});
  let associationSource="run_pull_requests";
  for(const run of [before,after]){
    if(run?.id!==target.runId||run.repository?.full_name!==target.repository||
       run.head_sha?.toLowerCase()!==target.headSha)
      return unknown("GITHUB_RUN_IDENTITY_MISMATCH");
    if(run.run_attempt!==target.attempt)return unknown("GITHUB_RUN_ATTEMPT_CHANGED");
    if(!Array.isArray(run.pull_requests))return unknown("GITHUB_RUN_PR_UNVERIFIED");
    if(!run.pull_requests.some(pr=>pr.number===target.prNumber&&pr.head?.sha?.toLowerCase()===target.headSha)){
      // GitHub may remove closed PRs from a historical Run's pull_requests array.
      // Corroborate an empty array via the official commit -> PR endpoint and
      // unchanged PR head branch, never by assuming a same-SHA Run is related.
      if(run.pull_requests.length!==0||!Array.isArray(commitPulls))return unknown("GITHUB_RUN_PR_UNVERIFIED");
      const matches=commitPulls.filter(pr=>pr.number===target.prNumber&&
        pr.base?.repo?.full_name===target.repository&&pr.head?.sha?.toLowerCase()===target.headSha);
      if(matches.length!==1)return unknown("GITHUB_RUN_PR_UNVERIFIED");
      const linked=matches[0];
      for(const pr of [prBefore,prAfter]){
        if(pr?.number!==target.prNumber||pr.base?.repo?.full_name!==target.repository||
          pr.head?.sha?.toLowerCase()!==target.headSha||!pr.head.ref||pr.head.ref!==linked.head.ref)
          return unknown("GITHUB_RUN_PR_UNVERIFIED");
      }
      const headBranch=run.head_branch===prBefore.head.ref;
      const mergedBase=prBefore.merged===true&&prAfter.merged===true&&
        prBefore.base.ref===prAfter.base.ref&&run.head_branch===prAfter.base.ref&&
        prBefore.merge_commit_sha===target.headSha&&prAfter.merge_commit_sha===target.headSha;
      if(!headBranch&&!mergedBase)return unknown("GITHUB_RUN_PR_BRANCH_MISMATCH");
      associationSource="commit_pull_association";
    }
  }
  if(before.status!==after.status||before.conclusion!==after.conclusion)
    return unknown("GITHUB_RUN_CHANGED_DURING_VERIFICATION");
  const state=after.status==="queued"?"QUEUED":
    after.status==="in_progress"?"RUNNING":after.status==="completed"?
      (after.conclusion==="success"?"SUCCESS":
        ["failure","timed_out"].includes(after.conclusion)?"FAILURE":"OTHER_TERMINAL"):null;
  if(!state)return unknown("GITHUB_RUN_STATE_UNKNOWN");
  return {runVerified:true,runId:target.runId,attempt:target.attempt,runCiState:state,runPrSource:associationSource};
}
export class GitHubCLI {
  constructor({command="gh",exec=execFileAsync}={}){
    this.command=command;this.exec=exec;
  }
  async get(path){
    // Call GitHub CLI only for read-only REST requests; never output tokens or stderr.
    if(!/^\/repos\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9/_?.=&%-]+$/.test(path))
      throw new GitHubFactError("INVALID_API_PATH");
    try{
      const {stdout}=await this.exec(this.command,[
        "api","--method","GET",path,
        "--header","Accept: application/vnd.github+json"
      ],{timeout:12000,maxBuffer:2_000_000,windowsHide:true,
        env:{...process.env,GH_PROMPT_DISABLED:"1",GH_HOST:"github.com"}});
      return JSON.parse(stdout);
    }catch{
      throw new GitHubFactError("GITHUB_UNAVAILABLE",
        "GitHub CLI 로그인이 없거나, 읽기 권한 또는 네트워크 연결이 필요합니다.");
    }
  }
}
function getRequiredChecks(protection,rules){
  if(!protection||!Array.isArray(rules))return null;
  if(rules.some(rule=>rule?.type==="required_workflows"))return null;
  const required=new Map();
  const add=(name,appId)=>{
    if(typeof name!=="string"||!name)return;
    const id=Number.isInteger(appId)?appId:null;
    required.set(name+"#"+String(id),{name,appId:id});
  };
  for(const context of protection.contexts||[])add(context,null);
  for(const item of protection.checks||[])add(item.context,item.app_id);
  for(const rule of rules){
    if(rule?.type==="required_status_checks"){
      for(const check of rule.parameters?.required_status_checks||[]){
        add(check.context,check.integration_id??null);
      }
    }
  }
  return [...required.values()];
}
function checkRequired(required,checks,statuses){
  if(!Array.isArray(required))return {state:"UNKNOWN",reason:"REQUIRED_CHECKS_UNVERIFIED"};
  if(!Array.isArray(checks.check_runs)||!Number.isInteger(checks.total_count) ||
    checks.total_count>checks.check_runs.length)return {state:"UNKNOWN",reason:"INCOMPLETE_CHECK_COVERAGE"};
  if(!Array.isArray(statuses.statuses))return {state:"UNKNOWN",reason:"INVALID_STATUS_COVERAGE"};
  const result=[];
  for(const item of required){
    const matchedChecks=checks.check_runs.filter(c=>c.name===item.name &&
      (item.appId===null||item.appId===c.app?.id));
    const matchedStatuses=statuses.statuses.filter(s=>s.context===item.name);
    // Repeated check names across app integrations are ambiguous without exact app ID.
    const appIds=new Set(matchedChecks.map(c=>c.app?.id));
    if(item.appId===null && appIds.size>1)
      return {state:"UNKNOWN",reason:"AMBIGUOUS_CHECK_PROVIDERS"};
    const latest=matchedChecks.slice().sort((a,b)=>(b.id||0)-(a.id||0))[0];
    const status=matchedStatuses[0];
    const success=latest?.status==="completed"&&latest?.conclusion==="success" ||
      (!latest&&status?.state==="success");
    const pending=latest && latest.status!=="completed" ||
      (!latest&&(!status||status.state==="pending"));
    const failed=latest?.status==="completed" && ["failure","timed_out","action_required","cancelled"]
      .includes(latest.conclusion) || (!latest&&["failure","error"].includes(status?.state));
    result.push({name:item.name,state:success?"SUCCESS":failed?"FAILURE":pending?"PENDING":"UNKNOWN"});
  }
  if(result.some(s=>s.state==="FAILURE"))return {state:"FAILURE",reason:"REQUIRED_CHECK_FAILED",checks:result};
  if(result.some(s=>s.state==="UNKNOWN"))return {state:"UNKNOWN",reason:"REQUIRED_CHECK_INDETERMINATE",checks:result};
  if(result.some(s=>s.state==="PENDING"))return {state:"WAIT_EXTERNAL",reason:"REQUIRED_CHECK_PENDING",checks:result};
  return {state:"SUCCESS",reason:required.length?"REQUIRED_CHECKS_PASSED":"NO_REQUIRED_CHECKS",checks:result};
}
export function decideGitHubFacts(target,prBefore,prAfter,checks,statuses,protection,rules){
  const blocked=(state,reason,extras={})=>({
    state,reason,safeToAdvance:false,requiredChecksVerified:false,merged:false,...extras
  });
  if(!prBefore||!prAfter||typeof prBefore!=="object"||typeof prAfter!=="object")
    return blocked("UNKNOWN","PR_RESPONSE_INVALID");
  if(prBefore.number!==target.prNumber||prAfter.number!==target.prNumber ||
    prBefore.base?.repo?.full_name!==target.repository||
    prAfter.base?.repo?.full_name!==target.repository)
    return blocked("UNKNOWN","PR_IDENTITY_MISMATCH");
  if(prBefore.head?.sha?.toLowerCase()!==target.headSha||
    prAfter.head?.sha?.toLowerCase()!==target.headSha)
    return blocked("UNKNOWN","PR_HEAD_SHA_DRIFT",{
      observedHeadSha:prAfter.head?.sha||null
    });
  if(prBefore.base.ref!==prAfter.base.ref||
    prBefore.merged!==prAfter.merged)
    return blocked("UNKNOWN","PR_CHANGED_DURING_VERIFICATION");
  const merged=prAfter.merged===true;
  if(merged && prAfter.state!=="closed")return blocked("UNKNOWN","INCONSISTENT_PR_MERGE_STATE");
  const required=getRequiredChecks(protection,rules);
  const checksStatus=checkRequired(required,checks,statuses);
  return {
    state:checksStatus.state==="SUCCESS"?
      (merged?"MERGED_CONFIRMED":"CHECKS_PASSED_NOT_MERGED"):
      checksStatus.state,
    reason:checksStatus.reason,
    safeToAdvance:false,
    merged,
    headSha:target.headSha,
    prNumber:target.prNumber,
    baseBranch:prAfter.base.ref,
    requiredChecksVerified:checksStatus.state==="SUCCESS",
    checks:checksStatus.checks||[]
  };
}
export class GitHubVerifier {
  constructor({client=new GitHubCLI()}={}){this.client=client;}
  async verify(input){
    const target=checkGitHubTarget(input);
    const prefix="/repos/"+target.repository;
    const path=prefix+"/pulls/"+target.prNumber;
    const before=await this.client.get(path);
    if(before.head?.sha?.toLowerCase()!==target.headSha)
      return decideGitHubFacts(target,before,before,{check_runs:[],total_count:0},
        {statuses:[]},null,null);
    const runPath=target.runId===undefined?null:prefix+"/actions/runs/"+target.runId;
    const runBefore=runPath?await this.client.get(runPath):null;
    const branch=before.base?.ref;
    if(typeof branch!=="string"||!branch)
      throw new GitHubFactError("INVALID_PR_RESPONSE");
    // A missing ruleset/protection permission is NOT interpreted as "no requirements".
    const [checks,statuses,protection,rules]=await Promise.all([
      this.client.get(prefix+"/commits/"+target.headSha+"/check-runs?per_page=100&filter=latest"),
      this.client.get(prefix+"/commits/"+target.headSha+"/status"),
      this.client.get(prefix+"/branches/"+encodeURIComponent(branch)+"/protection/required_status_checks")
        .catch(()=>null),
      this.client.get(prefix+"/rules/branches/"+encodeURIComponent(branch))
        .catch(()=>null)
    ]);
    const after=await this.client.get(path);
    const facts=decideGitHubFacts(target,before,after,checks,statuses,protection,rules);
    if(!runPath)return facts;
    const runAfter=await this.client.get(runPath);
    const commitPulls=runBefore.pull_requests?.length===0||runAfter.pull_requests?.length===0?
      await this.client.get(prefix+"/commits/"+target.headSha+"/pulls?per_page=100"):null;
    const run=verifyGitHubRun(target,runBefore,runAfter,{prBefore:before,prAfter:after,commitPulls});
    return run.runVerified?{...facts,...run}:{...facts,...run,state:"UNKNOWN",reason:run.runReason,
      requiredChecksVerified:false,safeToAdvance:false};
  }
}
