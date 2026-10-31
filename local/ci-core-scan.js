// Advisory latest-actions observation when WatchTower Tauri is stopped.
// Not a CI gate, a writer, a PR verifier, or authorization to resume.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {dirname,join,isAbsolute} from "node:path";

const runFile=promisify(execFile);
const CONTRACT="ci-core-scan/0.1";
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA=/^[a-f0-9]{40}$/i;
const ERRORS=new Set(["INVALID_TARGET","CREDENTIAL_UNAVAILABLE","GITHUB_UNAVAILABLE",
  "GITHUB_UNAUTHORIZED","GITHUB_FORBIDDEN","GITHUB_RATE_LIMITED","GITHUB_THROTTLED",
  "GITHUB_NOT_FOUND","GITHUB_TRANSPORT_UNAVAILABLE","GITHUB_RESPONSE_INVALID"]);
const STOP_CODES=new Set(["GITHUB_UNAUTHORIZED","GITHUB_FORBIDDEN",
  "GITHUB_RATE_LIMITED","GITHUB_THROTTLED"]);
const STATES=new Set(["QUEUED","RUNNING","SUCCESS","FAILURE","OTHER_TERMINAL","UNKNOWN"]);
const MAX_REPOS=2,AUTH_BACKOFF_MS=15*60_000;

export class CoreScanError extends Error {
  constructor(code){super(code);this.name="CoreScanError";this.code=code;}
}
export function validateScan(data,repo,limit=30,now=Date.now()){
  const fail=code=>{throw new CoreScanError(code);};
  if(!REPO.test(repo||"")||!data||data.source!=="github_actions_recent"||
     data.repository!==repo||data.safeToAdvance!==false||
     data.completeCoverage!==false||data.targetVerified!==false||
     data.requiredChecksVerified!==false||data.apiRequests>6||
     !Number.isSafeInteger(data.apiRequests)||data.apiRequests<1||
     data.maxApiRequests!==6||data.sampleLimit!==limit||
     !Array.isArray(data.runs)||data.runs.length>limit)
    fail("CORE_SCAN_CONTRACT_MISMATCH");
  const at=Date.parse(data.observedAt);
  if(!Number.isFinite(at)||at>now+5000||now-at>90000)
    fail("CORE_SCAN_STALE");
  const ids=new Set();
  for(const r of data.runs){
    if(!Number.isSafeInteger(r.runId)||r.runId<=0||ids.has(r.runId)||
       !Number.isSafeInteger(r.runAttempt)||r.runAttempt<1||
       !SHA.test(r.headSha||"")||!STATES.has(r.ciState)||
       r.targetVerified!==false||r.requiredChecksVerified!==false||
       r.safeToAdvance!==false||!Array.isArray(r.prNumbers)||
       !r.prNumbers.every(n=>Number.isSafeInteger(n)&&n>0))
      fail("CORE_SCAN_RUN_IDENTITY_INVALID");
    ids.add(r.runId);
  }
  return data;
}
export class CoreScanClient{
  constructor({binaryPath=process.env.CI_CORE_SCAN_EXE||
    (process.env.CI_CORE_INSPECT_EXE?
      join(dirname(process.env.CI_CORE_INSPECT_EXE),"ci-core-scan.exe"):""),
    platform=process.platform,exec=runFile,timeoutMs=135000,limit=30,
    now=()=>Date.now()}={}){
    this.binaryPath=binaryPath;this.platform=platform;
    this.exec=exec;this.timeoutMs=timeoutMs;this.limit=limit;this.now=now;
  }
  get configured(){
    return this.platform==="win32"&&this.binaryPath.endsWith(".exe")&&
      isAbsolute(this.binaryPath);
  }
  async read(repository){
    if(!this.configured)throw new CoreScanError("CORE_SCAN_NOT_CONFIGURED");
    if(!REPO.test(repository||"")||!Number.isSafeInteger(this.limit)||
       this.limit<1||this.limit>50)
      throw new CoreScanError("INVALID_TARGET");
    const args=["--repository",repository,"--limit",String(this.limit)];
    let result;
    try{
      result=await this.exec(this.binaryPath,args,{
        shell:false,windowsHide:true,timeout:this.timeoutMs,maxBuffer:1024*1024,encoding:"utf8"
      });
    }catch(error){
      let code=null;
      try{
        const value=JSON.parse(error?.stdout||"");
        if(value?.contractVersion===CONTRACT&&ERRORS.has(value?.error?.code))
          code=value.error.code;
      }catch{}
      throw new CoreScanError(code||"CORE_SCAN_UNAVAILABLE");
    }
    let value;
    try{value=JSON.parse(result?.stdout||"");}
    catch{throw new CoreScanError("CORE_SCAN_INVALID_RESPONSE");}
    if(value?.contractVersion!==CONTRACT||!value.data||value.error)
      throw new CoreScanError("CORE_SCAN_CONTRACT_MISMATCH");
    return validateScan(value.data,repository,this.limit,this.now());
  }
}
export class CoreScanObserver{
  constructor({registry,client=new CoreScanClient(),now=()=>Date.now(),
    minIntervalMs=120_000}={}){
    this.registry=registry;this.client=client;this.now=now;this.minIntervalMs=minIntervalMs;
    this.pending=null;this.signature=null;this.cursor=0;this.cooldownUntil=0;
    this.snapshot={status:client.configured?"not_checked":"disabled",checkedAt:null,
      errorCode:client.configured?null:"CORE_SCAN_NOT_CONFIGURED",
      repositories:[],completeCoverage:false,safeToAdvance:false};
  }
  current(){return this.snapshot;}
  async refresh(){
    if(!this.client.configured)return this.current();
    if(this.pending)return this.pending;
    const source=this.registry?.current();
    if(source?.status!=="observed"){
      this.snapshot={status:"unavailable",checkedAt:this.now(),
        errorCode:"CORE_REGISTRY_UNAVAILABLE",repositories:[],
        completeCoverage:false,safeToAdvance:false};
      return this.current();
    }
    const repos=source.repositories.filter(r=>r.enabled===true);
    const signature=JSON.stringify(repos.map(r=>[r.id,r.name]));
    if(signature===this.signature&&this.snapshot.checkedAt!==null&&
       this.now()-this.snapshot.checkedAt<this.minIntervalMs)return this.current();
    this.pending=this._refresh(repos,signature).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async _refresh(repos,signature){
    const checkedAt=this.now(),result=[];
    const start=repos.length?this.cursor%repos.length:0;
    const take=Math.min(MAX_REPOS,repos.length);
    const picked=new Set(Array.from({length:take},(_,i)=>(start+i)%repos.length));
    this.cursor=repos.length?(start+take)%repos.length:0;
    let launched=0;
    for(let i=0;i<repos.length;i++){
      const r=repos[i];
      if(!picked.has(i)){
        result.push({repositoryId:r.id,repository:r.name,status:"not_checked",
          reason:"SCAN_RATE_BUDGET",runs:[],safeToAdvance:false});continue;
      }
      if(this.now()<this.cooldownUntil){
        result.push({repositoryId:r.id,repository:r.name,status:"unavailable",
          reason:"SCAN_AUTH_BACKOFF",runs:[],safeToAdvance:false});continue;
      }
      try{
        launched++;
        const value=await this.client.read(r.name);
        result.push({repositoryId:r.id,repository:r.name,status:"observed",
          observedAt:value.observedAt,runs:value.runs,safeToAdvance:false});
      }catch(error){
        const reason=error instanceof CoreScanError?error.code:"CORE_SCAN_UNAVAILABLE";
        if(STOP_CODES.has(reason))this.cooldownUntil=this.now()+AUTH_BACKOFF_MS;
        result.push({repositoryId:r.id,repository:r.name,status:"unavailable",
          reason,runs:[],safeToAdvance:false});
      }
    }
    this.signature=signature;
    const anyObserved=result.some(r=>r.status==="observed");
    const failure=result.find(r=>r.status==="unavailable");
    this.snapshot={status:anyObserved?"observed":failure?"unavailable":"not_checked",
      checkedAt,launched,errorCode:!anyObserved&&failure?failure.reason:null,
      repositories:result,authBackoffUntil:this.cooldownUntil>this.now()?this.cooldownUntil:null,
      completeCoverage:false,safeToAdvance:false};
    return this.current();
  }
}
