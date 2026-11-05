import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {normalizeRepository} from "./repository-directory.js";

const runFile=promisify(execFile);
const SHA=/^[a-f0-9]{40}$/;
const ACTIVE=new Set(["queued","in_progress","waiting","requested","pending"]);
const FAIL=new Set(["failure","timed_out","action_required"]);
const POLL_MS=60_000;
const MAX_AGE_MS=5*60_000;
const RECENT_MS=3*60*60_000;
export const validCiBranch=x=>typeof x==="string"&&x.length<=160&&
  /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(x)&&!x.includes("..")&&
  !x.includes("//")&&!x.endsWith("/")&&!x.includes("@{");
const toIso=x=>typeof x==="string"&&Number.isFinite(Date.parse(x))?
  new Date(x).toISOString():null;

export async function fetchGitHubBranchHead(repository,branch,{run=runFile}={}){
  const name=normalizeRepository(repository);
  if(!validCiBranch(branch))throw Error("CI_BRANCH_INVALID");
  let stdout;
  try{
    ({stdout}=await run("gh",[
      "api","/repos/"+name+"/branches/"+encodeURIComponent(branch),
      "-H","Accept: application/vnd.github+json"
    ],{timeout:15_000,maxBuffer:1024*1024,windowsHide:true}));
  }catch(error){
    // Only the exact GitHub missing-branch response is a confirmed dead target.
    // Authentication, API limits, network errors and generic 404s remain unknown.
    const stderr=String(error?.stderr||"");
    if(/Branch not found\s*\(HTTP 404\)/i.test(stderr))
      throw Error("GITHUB_BRANCH_NOT_FOUND");
    throw Error("GITHUB_BRANCH_HEAD_UNAVAILABLE");
  }
  let payload;
  try{payload=JSON.parse(stdout);}catch{throw Error("GITHUB_BRANCH_INVALID_JSON");}
  if(!SHA.test(payload?.commit?.sha||""))throw Error("GITHUB_BRANCH_HEAD_UNVERIFIED");
  return payload.commit.sha;
}

export async function fetchGitHubActionsRuns(repository,{branch=null,headSha=null,run=runFile}={}){
  const name=normalizeRepository(repository);
  if(branch!==null&&!validCiBranch(branch))throw Error("CI_BRANCH_INVALID");
  if(headSha!==null&&!SHA.test(headSha))throw Error("CI_HEAD_SHA_INVALID");
  const uri="/repos/"+name+"/actions/runs?per_page=60"+
    (branch?"&branch="+encodeURIComponent(branch):"")+
    (headSha?"&head_sha="+headSha:"");
  const {stdout}=await run("gh",["api",uri,
    "-H","Accept: application/vnd.github+json"],{
      timeout:15_000,maxBuffer:5*1024*1024,windowsHide:true
    });
  let payload;
  try{payload=JSON.parse(stdout);}catch{throw Error("GITHUB_CI_INVALID_JSON");}
  if(!Array.isArray(payload?.workflow_runs))
    throw Error("GITHUB_CI_INVALID_RESPONSE");
  const rows=payload.workflow_runs.map(x=>({
    runId:x.id,runAttempt:x.run_attempt,headSha:x.head_sha,
    headBranch:x.head_branch,workflowName:x.name,status:x.status,
    conclusion:x.conclusion,createdAt:x.created_at,updatedAt:x.updated_at
  }));
  rows.truncated=Number.isSafeInteger(payload.total_count)&&
    payload.total_count>rows.length;
  return rows;
}

export async function fetchGitHubRunJobs(repository,runId,{run=runFile}={}){
  const name=normalizeRepository(repository);
  if(!Number.isSafeInteger(runId)||runId<1)throw Error("CI_RUN_ID_INVALID");
  const {stdout}=await run("gh",["api",
    "/repos/"+name+"/actions/runs/"+runId+"/jobs?per_page=100&filter=latest",
    "-H","Accept: application/vnd.github+json"],{
      timeout:15_000,maxBuffer:5*1024*1024,windowsHide:true
    });
  let data;
  try{data=JSON.parse(stdout);}catch{throw Error("GITHUB_CI_JOBS_INVALID_JSON");}
  if(!Array.isArray(data?.jobs)||!Number.isSafeInteger(data.total_count)||
    data.total_count>100||data.jobs.length!==data.total_count)
    throw Error("GITHUB_CI_JOBS_INCOMPLETE");
  return data.jobs.map(x=>({runId:x.run_id,status:x.status,
    conclusion:x.conclusion,headSha:x.head_sha,
    name:x.name}));
}

export class GitHubChatCiObserver {
  constructor({targets=()=>[],read=fetchGitHubActionsRuns,
    readJobs=fetchGitHubRunJobs,readBranchHead=fetchGitHubBranchHead,
    now=()=>Date.now(),pollMs=POLL_MS}={}){
    this.targets=targets;this.read=read;this.readJobs=readJobs;
    this.readBranchHead=readBranchHead;
    this.now=now;this.pollMs=pollMs;
    this.checkedAt=null;this.status="not_checked";
    this.errorCode=null;this.repositories=[];this.refreshing=null;
    this.lastStarted=0;
  }
  current(){
    return {status:this.status,checkedAt:this.checkedAt,
      errorCode:this.errorCode,repositories:this.repositories,
      source:"github_authenticated_read_only"};
  }
  provider(){
    const at=this.now(),fresh=this.checkedAt!==null&&
      at-this.checkedAt>=0&&at-this.checkedAt<=MAX_AGE_MS;
    if(!fresh||this.status!=="observed")return {
      registry:{status:"disabled",repositories:[]},
      scan:{status:"unavailable",checkedAt:this.checkedAt,repositories:[]},
      incidents:[]
    };
    const entries=this.repositories.filter(x=>x.status==="observed");
    return {
      registry:{status:"observed",
        repositories:[...new Set(entries.map(x=>x.repository))].map(name=>({name}))},
      scan:{status:"observed",checkedAt:this.checkedAt,repositories:entries.map(x=>({
        repository:x.repository,branch:x.branch,headSha:x.headSha,
        status:"observed",observedAt:x.observedAt,runs:x.runs
      }))},incidents:entries.flatMap(x=>x.incidents)
    };
  }
  state(repository,branch=undefined,workflows=null){
    const matches=this.repositories.filter(x=>x.repository===repository&&
      (branch===undefined||x.branch===branch));
    if(matches.length>1)return {status:"ambiguous",ciState:"AMBIGUOUS",repository};
    const item=matches.length===1?matches[0]:null;
    const fresh=item&&this.status==="observed"&&this.checkedAt!==null&&
      this.now()-this.checkedAt>=0&&this.now()-this.checkedAt<=MAX_AGE_MS;
    if(!fresh)return {status:"unknown",ciState:"UNKNOWN",repository,branch:branch??null};
    if(workflows===null||item.status!=="observed")return item;
    if(!Array.isArray(workflows)||workflows.length===0)
      return {status:"unknown",ciState:"UNKNOWN",repository,branch:branch??null};
    const runs=item.runs.filter(r=>workflows.includes(r.workflowName));
    // A missing required workflow must NOT be silently considered green.
    const present=new Set(runs.map(r=>r.workflowName));
    const complete=workflows.every(w=>present.has(w));
    const ciState=!complete?"UNKNOWN":
      runs.some(r=>r.ciState==="RUNNING")?"RUNNING":
      runs.some(r=>r.ciState==="FAILURE")?"FAILURE":
      runs.every(r=>r.ciState==="SUCCESS")?"SUCCESS":"UNKNOWN";
    const ids=new Set(runs.map(r=>r.runId));
    return {...item,runs,ciState,incidents:item.incidents.filter(x=>
      [...ids].some(id=>x.scope.includes(":"+id+":")))};

  }
  async refresh({force=false}={}){
    if(this.refreshing)return this.refreshing;
    const at=this.now();
    if(!force&&at-this.lastStarted<this.pollMs)return this.current();
    const requested=[];
    for(const x of this.targets()){
      try{
        const repository=normalizeRepository(x.repository);
        const branch=x.branch??null;
        if(branch!==null&&!validCiBranch(branch))continue;
        if(!requested.some(y=>y.repository===repository&&y.branch===branch))
          requested.push({repository,branch});
      }catch{}
    }
    this.lastStarted=at;
    if(!requested.length){
      this.repositories=[];this.status="not_configured";
      this.checkedAt=at;this.errorCode=null;
      return this.current();
    }
    this.refreshing=(async()=>{
      const out=[];
      for(const target of requested.slice(0,20)){
        const item={repository:target.repository,branch:target.branch,headSha:null,
          status:"unknown",ciState:"UNKNOWN",runs:[],incidents:[],
          observedAt:new Date(at).toISOString(),errorCode:null};
        try{
          const headSha=target.branch?
            await this.readBranchHead(target.repository,target.branch):null;
          if(target.branch&&!SHA.test(headSha||""))
            throw Error("GITHUB_BRANCH_HEAD_UNVERIFIED");
          item.headSha=headSha;
          const fetched=await this.read(target.repository,{branch:target.branch,headSha});
          if(!Array.isArray(fetched))throw Error("GITHUB_CI_INVALID_RESPONSE");
          const runs=fetched.filter(x=>
            Number.isSafeInteger(x.runId)&&x.runId>0&&
            Number.isSafeInteger(x.runAttempt)&&x.runAttempt>=1&&
            SHA.test(x.headSha||"")&&toIso(x.createdAt))
            .map(x=>({...x,createdAt:toIso(x.createdAt)}))
            .sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
          // Without an explicit branch, a repository with multiple recent
          // branch heads is ambiguous. Never attribute one branch's RED to
          // another chat.
          const recent=runs.filter(x=>at-Date.parse(x.createdAt)>=0&&
            at-Date.parse(x.createdAt)<=RECENT_MS);
          const incompleteLatestHead=fetched.truncated===true;
          const heads=new Set(recent.map(x=>x.headSha));
          const ambiguous=!target.branch&&heads.size>1;
          // A branch-scoped check must match the live GitHub branch HEAD.
          // The same unchanged HEAD remains authoritative beyond three hours.
          // An unscoped repository still fails closed on conflicting recent heads.
          const currentHead=item.headSha||recent[0]?.headSha||null;
          const selected=ambiguous?[]:
            target.branch?runs.filter(x=>x.headSha===currentHead&&
              x.headBranch===target.branch):
            recent.filter(x=>x.headSha===currentHead);
          const latestAttempts=new Map();
          for(const x of selected){
            const key=x.workflowName||String(x.runId);
            const old=latestAttempts.get(key);
            if(!old||Date.parse(x.createdAt)>Date.parse(old.createdAt)||
              x.runId===old.runId&&x.runAttempt>old.runAttempt)
              latestAttempts.set(key,x);
          }
          const latest=[...latestAttempts.values()];
          item.status=ambiguous?"ambiguous":"observed";
          item.ciState=ambiguous?"AMBIGUOUS":
            incompleteLatestHead?"UNKNOWN":
            !latest.length?"UNKNOWN":
            latest.some(x=>ACTIVE.has(x.status))?"RUNNING":
            latest.some(x=>x.status==="completed"&&FAIL.has(x.conclusion))?"FAILURE":
            latest.every(x=>x.status==="completed"&&
              ["success","skipped","neutral"].includes(x.conclusion))?"SUCCESS":"UNKNOWN";
          item.runs=latest.map(x=>({
            runId:x.runId,runAttempt:x.runAttempt,headSha:x.headSha,
            workflowName:String(x.workflowName||"").slice(0,100),
            createdAt:x.createdAt,
            ciState:x.status==="completed"&&FAIL.has(x.conclusion)?
              "FAILURE":x.status==="completed"&&x.conclusion==="success"?
              "SUCCESS":ACTIVE.has(x.status)?"RUNNING":"UNKNOWN"
          }));
          // Independent read-only job evidence is mandatory for a RED
          // prompt. The run summary alone cannot create its own incident.
          if(item.ciState==="FAILURE"){
            const failures=item.runs.filter(x=>x.ciState==="FAILURE").slice(0,3);
            for(const failure of failures){
              try{
                const jobs=await this.readJobs(target.repository,failure.runId);
                const confirmed=jobs.some(j=>j.runId===failure.runId&&
                  j.status==="completed"&&
                  j.headSha?.toLowerCase()===failure.headSha.toLowerCase()&&
                  FAIL.has(j.conclusion));
                if(confirmed)item.incidents.push({
                  state:"open",code:"CI_FAILED",
                  scope:"repo:"+target.repository+":"+failure.runId+
                    ":"+failure.runAttempt
                });
              }catch{/* A missing/unreadable job must not authorize RED. */}
            }
            if(!item.incidents.length)item.ciState="UNKNOWN";
          }
        }catch(error){
          item.errorCode=error?.message==="GITHUB_BRANCH_NOT_FOUND"?
            "GITHUB_BRANCH_NOT_FOUND":"GITHUB_CI_UNAVAILABLE";
        }
        out.push(item);
      }
      // Fail closed if some checked repository could not be read.
      this.repositories=out;this.checkedAt=this.now();
      this.status="observed";
      this.errorCode=out.some(x=>x.errorCode)?"GITHUB_CI_PARTIAL":null;
      return this.current();
    })().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
}
