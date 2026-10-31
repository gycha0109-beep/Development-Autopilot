// Bounded, read-only history of previously stored WatchTower CI runs.
// Historical success is never used as live PR evidence or an execution permission.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {dirname,join,isAbsolute} from "node:path";

const runFile=promisify(execFile);
const CONTRACT="ci-core-history/0.1";
const SHA=/^[a-f0-9]{40}$/i;
const VALID_STATES=new Set(["RUNNING","QUEUED","SUCCESS","FAILURE","OTHER_TERMINAL","UNKNOWN"]);
const KNOWN_ERRORS=new Set(["INVALID_TARGET","DATABASE_UNAVAILABLE","DATABASE_SCHEMA_UNSUPPORTED"]);
const MAX_REPOSITORIES_PER_CYCLE=4;

export class CoreHistoryError extends Error {
  constructor(code){super(code);this.name="CoreHistoryError";this.code=code;}
}
function positive(n){return Number.isSafeInteger(n)&&n>0;}
function isTrack(v){return v===null||(typeof v==="string"&&/^[a-z0-9-]{1,100}$/.test(v));}
export function validateHistorySnapshot(data,repository,limit=20,now=Date.now()){
  const fail=code=>{throw new CoreHistoryError(code);};
  if(!repository||!positive(repository.id)||!positive(repository.projectId)||
     !data||data.source!=="watchtower_sqlite_history"||
     data.repositoryId!==repository.id||data.historicalOnly!==true||
     data.completeCoverage!==false||data.safeToAdvance!==false||
     !Array.isArray(data.runs)||data.runs.length>limit)
    fail("CORE_HISTORY_CONTRACT_MISMATCH");
  const at=Date.parse(data.observedAt);
  if(!Number.isFinite(at)||at>now+5000||now-at>90000)
    fail("CORE_HISTORY_STALE");
  const ids=new Set();
  for(const run of data.runs){
    if(!positive(run.runId)||ids.has(run.runId)||
       run.repositoryId!==repository.id||run.repository!==repository.name||
       run.projectId!==repository.projectId||
       !SHA.test(run.headSha||"")||!positive(run.runAttempt)||
       !positive(run.latestKnownAttempt)||run.latestKnownAttempt<run.runAttempt||
       !VALID_STATES.has(run.ciState)||!isTrack(run.workTrackKey)||
       run.historicalOnly!==true||run.safeToAdvance!==false||
       run.source!=="watchtower_sqlite_history"||
       typeof run.createdAt!=="string"||typeof run.updatedAt!=="string")
      fail("CORE_HISTORY_IDENTITY_MISMATCH");
    ids.add(run.runId);
  }
  return data;
}

export class CoreHistoryClient {
  constructor({binaryPath=process.env.CI_CORE_HISTORY_EXE||
    (process.env.CI_CORE_INSPECT_EXE?
      join(dirname(process.env.CI_CORE_INSPECT_EXE),"ci-core-history.exe"):""),
    dbPath=process.env.CI_WATCHTOWER_DB||
      (process.env.APPDATA?join(process.env.APPDATA,
        "com.gycha.ciwatchtower","ci-watchtower.sqlite3"):""),
    platform=process.platform,exec=runFile,timeoutMs=10000,limit=20,
    now=()=>Date.now()}={}){
    this.binaryPath=binaryPath;this.dbPath=dbPath;this.platform=platform;
    this.exec=exec;this.timeoutMs=timeoutMs;this.limit=limit;this.now=now;
  }
  get configured(){
    return this.platform==="win32"&&this.binaryPath.endsWith(".exe")&&
      isAbsolute(this.binaryPath)&&isAbsolute(this.dbPath);
  }
  async read(repository){
    if(!this.configured)throw new CoreHistoryError("CORE_HISTORY_NOT_CONFIGURED");
    if(!repository||!positive(repository.id)||!positive(repository.projectId)||
       !Number.isSafeInteger(this.limit)||this.limit<1||this.limit>100)
      throw new CoreHistoryError("INVALID_TARGET");
    const args=["--db",this.dbPath,"--repository-id",String(repository.id),
      "--limit",String(this.limit)];
    let result;
    try{
      result=await this.exec(this.binaryPath,args,{
        shell:false,windowsHide:true,timeout:this.timeoutMs,maxBuffer:900_000,encoding:"utf8"
      });
    }catch(error){
      let code=null;
      try{
        const value=JSON.parse(error?.stdout||"");
        if(value?.contractVersion===CONTRACT&&KNOWN_ERRORS.has(value?.error?.code))
          code=value.error.code;
      }catch{}
      throw new CoreHistoryError(code||"CORE_HISTORY_UNAVAILABLE");
    }
    let payload;
    try{payload=JSON.parse(result?.stdout||"");}
    catch{throw new CoreHistoryError("CORE_HISTORY_INVALID_RESPONSE");}
    if(payload?.contractVersion!==CONTRACT||!payload.data||payload.error)
      throw new CoreHistoryError("CORE_HISTORY_CONTRACT_MISMATCH");
    return validateHistorySnapshot(payload.data,repository,this.limit,this.now());
  }
}

export class CoreHistoryObserver {
  constructor({client=new CoreHistoryClient(),registry,
    now=()=>Date.now(),minIntervalMs=120_000}={}){
    this.client=client;this.registry=registry;this.now=now;this.minIntervalMs=minIntervalMs;
    this.pending=null;this.cursor=0;this.signature=null;
    this.snapshot={status:client.configured?"not_checked":"disabled",checkedAt:null,
      errorCode:client.configured?null:"CORE_HISTORY_NOT_CONFIGURED",
      repositories:[],completeCoverage:false,safeToAdvance:false,historicalOnly:true};
  }
  current(){return this.snapshot;}
  async refresh(){
    if(!this.client.configured)return this.current();
    if(this.pending)return this.pending;
    const source=this.registry?.current();
    if(source?.status!=="observed"){
      this.snapshot={status:"unavailable",checkedAt:this.now(),
        errorCode:"CORE_REGISTRY_UNAVAILABLE",repositories:[],
        completeCoverage:false,safeToAdvance:false,historicalOnly:true};
      return this.current();
    }
    const repos=source.repositories.filter(r=>r.enabled===true);
    const signature=JSON.stringify(repos.map(r=>[r.id,r.projectId,r.name]));
    if(this.signature===signature&&this.snapshot.status==="observed"&&
       this.now()-this.snapshot.checkedAt<this.minIntervalMs)return this.current();
    this.pending=this._refresh(repos,signature).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async _refresh(repos,signature){
    const checkedAt=this.now(),results=[];
    const start=repos.length?this.cursor%repos.length:0;
    const take=Math.min(MAX_REPOSITORIES_PER_CYCLE,repos.length);
    const selected=new Set(Array.from({length:take},(_,i)=>(start+i)%repos.length));
    this.cursor=repos.length?(start+take)%repos.length:0;
    let attempts=0;
    for(let i=0;i<repos.length;i++){
      const repo=repos[i];
      if(!selected.has(i)){
        results.push({repositoryId:repo.id,repository:repo.name,status:"not_checked",
          reason:"HISTORY_RATE_BUDGET",runs:[],historicalOnly:true,safeToAdvance:false});
        continue;
      }
      attempts++;
      try{
        const data=await this.client.read(repo);
        results.push({repositoryId:repo.id,repository:repo.name,status:"observed",
          runs:data.runs,historicalOnly:true,safeToAdvance:false});
      }catch(error){
        results.push({repositoryId:repo.id,repository:repo.name,status:"unavailable",
          reason:error instanceof CoreHistoryError?error.code:"CORE_HISTORY_UNAVAILABLE",
          runs:[],historicalOnly:true,safeToAdvance:false});
      }
    }
    this.signature=signature;
    this.snapshot={status:"observed",checkedAt,errorCode:null,repositories:results,
      checkedCount:attempts,completeCoverage:false,safeToAdvance:false,historicalOnly:true};
    return this.current();
  }
}
