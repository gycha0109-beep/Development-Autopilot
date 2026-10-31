// Opt-in direct CI Core observation, independent of the WatchTower Tauri process.
// This is informational and is deliberately NOT a DecisionGate / CI progress source.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {isAbsolute} from "node:path";

const runFile=promisify(execFile);
const CONTRACT="ci-core-inspect/0.1";
const SHA=/^[a-f0-9]{40}$/i;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATES=new Set(["QUEUED","RUNNING","SUCCESS","FAILURE","OTHER_TERMINAL","UNKNOWN"]);
const ERRORS=new Set(["INVALID_TARGET","CREDENTIAL_UNAVAILABLE","GITHUB_UNAVAILABLE"]);
const MAX_PER_CYCLE=8;

export class CoreDirectError extends Error {
  constructor(code){super(code);this.name="CoreDirectError";this.code=code;}
}
function positive(value){return Number.isSafeInteger(value)&&value>0;}
function validTarget(t){
  return t&&REPO.test(t.repository||"")&&positive(t.prNumber)&&SHA.test(t.headSha||"")&&
    positive(t.runId)&&positive(t.attempt);
}
function unknown(workstreamId,reason){
  return {workstreamId,decision:"UNKNOWN",reason,safeToAdvance:false};
}
export function decideDirectCore(data,target,now=Date.now()){
  const fail=reason=>unknown(target?.workstreamId||null,reason);
  if(!validTarget(target)||!data||typeof data!=="object")return fail("INVALID_DIRECT_EVIDENCE");
  if(data.source!=="github_actions_direct"||data.repository!==target.repository||
     data.prNumber!==target.prNumber||
     data.expectedHeadSha?.toLowerCase()!==target.headSha.toLowerCase()||
     data.currentPrHeadSha?.toLowerCase()!==target.headSha.toLowerCase()||
     data.runId!==target.runId||data.runAttempt!==target.attempt||
     data.safeToAdvance!==false||data.completeCoverage!==false||
     data.requiredChecksVerified!==false||!STATES.has(data.ciState)||
     !STATES.has(data.decisionState)||typeof data.targetIdentityState!=="string")
    return fail("DIRECT_CONTRACT_OR_IDENTITY_MISMATCH");
  const at=Date.parse(data.observedAt);
  if(!Number.isFinite(at)||at>now+5000||now-at>90000)
    return fail("DIRECT_OBSERVATION_STALE");
  if(data.targetIdentityState!=="MATCH")
    return fail(data.targetIdentityState==="RUN_ID_OR_ATTEMPT_MISMATCH"?
      "DIRECT_ATTEMPT_CHANGED":"DIRECT_TARGET_UNVERIFIED");
  if(data.ciKind==="integration"||data.integrationBaselineVerified!==false)
    return fail("INTEGRATION_BASELINE_UNVERIFIED");
  if(data.targetVerified!==true||data.prIdentitySource!=="github_pull_requests"||
     data.workflowRunHeadSha?.toLowerCase()!==target.headSha.toLowerCase())
    return fail("DIRECT_RUN_PR_UNVERIFIED");
  if(data.decisionState!==data.ciState)return fail("DIRECT_STATE_CONFLICT");
  const decision=data.ciState==="SUCCESS"?"VERIFY_GITHUB":
    ["QUEUED","RUNNING"].includes(data.ciState)?"WAIT_EXTERNAL":
    ["FAILURE","OTHER_TERMINAL"].includes(data.ciState)?"BLOCKED":"UNKNOWN";
  return {
    workstreamId:target.workstreamId,repository:target.repository,
    runId:target.runId,attempt:target.attempt,headSha:target.headSha,
    prNumber:target.prNumber,source:"github_actions_direct",
    observedAt:data.observedAt,ciState:data.ciState,
    decision,reason:decision==="VERIFY_GITHUB"?"PR_CHECKS_AND_APPROVALS_STILL_REQUIRED":
      decision==="WAIT_EXTERNAL"?"CI_IN_PROGRESS":
      decision==="BLOCKED"?"CI_NOT_SUCCESSFUL":"CI_UNKNOWN",
    safeToAdvance:false
  };
}

export class CoreDirectClient {
  constructor({binaryPath=process.env.CI_CORE_INSPECT_EXE||"",exec=runFile,
    platform=process.platform,timeoutMs=15000}={}){
    this.binaryPath=binaryPath;
    this.exec=exec;
    this.platform=platform;
    this.timeoutMs=timeoutMs;
  }
  get configured(){return this.platform==="win32"&&this.binaryPath.endsWith(".exe")&&
    isAbsolute(this.binaryPath);}
  async inspect(target){
    if(!this.configured)throw new CoreDirectError("CORE_NOT_CONFIGURED");
    if(!validTarget(target))throw new CoreDirectError("INVALID_TARGET");
    const args=["--repository",target.repository,"--pr",String(target.prNumber),
      "--head-sha",target.headSha.toLowerCase(),"--run-id",String(target.runId),
      "--attempt",String(target.attempt)];
    let result;
    try{
      result=await this.exec(this.binaryPath,args,{
        timeout:this.timeoutMs,windowsHide:true,maxBuffer:16384,
        shell:false,encoding:"utf8"
      });
    }catch(error){
      // Do not propagate stderr, PATH, OS credential contents or GitHub responses.
      let code=null;
      try{
        const payload=JSON.parse(error?.stdout||"");
        if(ERRORS.has(payload?.error?.code))code=payload.error.code;
      }catch{}
      throw new CoreDirectError(code||"CORE_INSPECT_UNAVAILABLE");
    }
    let payload;
    try{payload=JSON.parse(result?.stdout||"");}
    catch{throw new CoreDirectError("CORE_INVALID_RESPONSE");}
    if(payload?.contractVersion!==CONTRACT||!payload.data||
      typeof payload.data!=="object"||payload.error)
      throw new CoreDirectError("CORE_CONTRACT_MISMATCH");
    return payload.data;
  }
}

// Uses existing operator-bound PR and Run targets; does not create a new DB or
// re-bind repository/track identities when WatchTower is stopped.
export class CoreDirectObserver {
  constructor(store,{watchtower,github,client=new CoreDirectClient(),
    now=()=>Date.now(),minIntervalMs=120000}={}){
    this.store=store;this.watchtower=watchtower;this.github=github;
    this.client=client;this.now=now;this.minIntervalMs=minIntervalMs;
    this.pending=null;this.signature=null;this.cursor=0;
    this.snapshot={status:client.configured?"not_checked":"disabled",
      checkedAt:null,results:[],errorCode:client.configured?null:"CORE_NOT_CONFIGURED",
      completeCoverage:false,safeToAdvance:false};
  }
  current(){return this.snapshot;}
  async refresh({force=false}={}){
    if(!this.client.configured)return this.current();
    if(this.pending)return this.pending;
    const targets=this.watchtower.targets.list();
    const ghTargets=this.github.targets.list();
    const signature=JSON.stringify([targets,ghTargets,this.store.list().map(x=>[x.id,x.repository])]);
    if(!force&&signature===this.signature&&this.snapshot.checkedAt!==null&&
       this.now()-this.snapshot.checkedAt<this.minIntervalMs)return this.current();
    this.pending=this.runRefresh(targets,ghTargets,signature)
      .finally(()=>{this.pending=null;});
    return this.pending;
  }
  async runRefresh(wtTargets,ghTargets,signature){
    const at=this.now(),streams=new Map(this.store.list().map(x=>[x.id,x]));
    const gh=new Map(ghTargets.map(x=>[x.workstreamId,x]));
    const eligible=wtTargets.map(w=>{
      const stream=streams.get(w.workstreamId),target=gh.get(w.workstreamId);
      return {workstreamId:w.workstreamId,repository:stream?.repository,
        prNumber:target?.prNumber,headSha:target?.headSha,
        runId:w.runId,attempt:w.attempt,
        bindSha:w.headSha,repositoryId:w.repositoryId};
    });
    const results=[];
    const total=eligible.length;
    const start=total?this.cursor%total:0;
    const selected=new Set(Array.from({length:Math.min(total,MAX_PER_CYCLE)},
      (_,n)=>(start+n)%total));
    this.cursor=total?(start+selected.size)%total:0;
    for(let i=0;i<total;i++){
      const t=eligible[i];
      if(!selected.has(i)){results.push(unknown(t.workstreamId,"DIRECT_RATE_BUDGET"));continue;}
      if(!validTarget(t)||t.bindSha?.toLowerCase()!==t.headSha?.toLowerCase()){
        results.push(unknown(t.workstreamId,"DIRECT_TARGET_BINDING_MISMATCH"));continue;
      }
      try{
        const data=await this.client.inspect(t);
        results.push(decideDirectCore(data,t,this.now()));
      }catch(error){
        results.push(unknown(t.workstreamId,error instanceof CoreDirectError?
          error.code:"CORE_INSPECT_UNAVAILABLE"));
      }
    }
    this.signature=signature;
    this.snapshot={status:"observed",checkedAt:at,results,
      errorCode:null,completeCoverage:false,safeToAdvance:false,
      rateBudget:{attempted:selected.size,targetCount:total}};
    return this.current();
  }
}
