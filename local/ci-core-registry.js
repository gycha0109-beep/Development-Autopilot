// Read-only local registry from the UI-independent CI Core Rust executable.
// Never use this snapshot to approve CI, a merge, a prompt or an automatic resume.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {dirname,join,isAbsolute} from "node:path";

const runFile=promisify(execFile);
const CONTRACT="ci-core-registry/0.1";
const ERRORS=new Set(["INVALID_TARGET","DATABASE_UNAVAILABLE","DATABASE_SCHEMA_UNSUPPORTED"]);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const repo=v=>typeof v==="string"&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v);
const validProject=p=>p&&positive(p.id)&&typeof p.key==="string"&&p.key.length>0&&
  typeof p.name==="string"&&typeof p.active==="boolean";
const validRepo=r=>r&&positive(r.id)&&(r.projectId===null||positive(r.projectId))&&
  repo(r.name)&&typeof r.enabled==="boolean"&&
  (r.pollErrorCode===null||r.pollErrorCode==="POLL_ERROR");
const validTrack=t=>t&&positive(t.id)&&positive(t.projectId)&&
  typeof t.canonicalTrackKey==="string"&&t.canonicalTrackKey.length>0&&
  typeof t.name==="string"&&typeof t.active==="boolean";

export class CoreRegistryError extends Error{
  constructor(code){super(code);this.name="CoreRegistryError";this.code=code;}
}
export function validateCoreRegistry(value,now=Date.now()){
  if(!value||value.source!=="watchtower_existing_sqlite"||
     value.readOnly!==true||value.safeToAdvance!==false||value.completeCoverage!==false||
     !Array.isArray(value.projects)||!Array.isArray(value.repositories)||
     !Array.isArray(value.tracks))
    throw new CoreRegistryError("CORE_REGISTRY_CONTRACT_MISMATCH");
  const at=Date.parse(value.observedAt);
  if(!Number.isFinite(at)||at>now+5000||now-at>90000)
    throw new CoreRegistryError("CORE_REGISTRY_STALE");
  if(!value.projects.every(validProject)||!value.repositories.every(validRepo)||
     !value.tracks.every(validTrack))
    throw new CoreRegistryError("CORE_REGISTRY_INVALID_IDENTITY");
  const projects=new Set(value.projects.map(x=>x.id));
  if(projects.size!==value.projects.length||
     new Set(value.repositories.map(x=>x.id)).size!==value.repositories.length||
     new Set(value.tracks.map(x=>x.id)).size!==value.tracks.length||
     !value.repositories.every(x=>x.projectId===null||projects.has(x.projectId))||
     !value.tracks.every(x=>projects.has(x.projectId)))
    throw new CoreRegistryError("CORE_REGISTRY_IDENTITY_CONFLICT");
  return {...value,completeCoverage:false,safeToAdvance:false};
}

export class CoreRegistryClient{
  constructor({binaryPath=process.env.CI_CORE_REGISTRY_EXE||
    (process.env.CI_CORE_INSPECT_EXE?
      join(dirname(process.env.CI_CORE_INSPECT_EXE),"ci-core-registry.exe"):""),
    dbPath=process.env.CI_WATCHTOWER_DB||
      (process.env.APPDATA?join(process.env.APPDATA,"com.gycha.ciwatchtower","ci-watchtower.sqlite3"):""),
    platform=process.platform,exec=runFile,timeoutMs=8000,now=()=>Date.now()}={}){
    this.binaryPath=binaryPath;this.dbPath=dbPath;
    this.platform=platform;this.exec=exec;this.timeoutMs=timeoutMs;this.now=now;
  }
  get configured(){
    return this.platform==="win32"&&this.binaryPath.endsWith(".exe")&&
      isAbsolute(this.binaryPath)&&isAbsolute(this.dbPath);
  }
  async read(){
    if(!this.configured)throw new CoreRegistryError("CORE_REGISTRY_NOT_CONFIGURED");
    let out;
    try{
      out=await this.exec(this.binaryPath,["--db",this.dbPath],
        {shell:false,windowsHide:true,timeout:this.timeoutMs,maxBuffer:524288,encoding:"utf8"});
    }catch(error){
      let code=null;
      try{const value=JSON.parse(error?.stdout||"");
        if(value?.contractVersion===CONTRACT&&ERRORS.has(value?.error?.code))
          code=value.error.code;
      }catch{}
      throw new CoreRegistryError(code||"CORE_REGISTRY_UNAVAILABLE");
    }
    let value;
    try{value=JSON.parse(out?.stdout||"");}
    catch{throw new CoreRegistryError("CORE_REGISTRY_INVALID_RESPONSE");}
    if(value?.contractVersion!==CONTRACT||!value.data||value.error)
      throw new CoreRegistryError("CORE_REGISTRY_CONTRACT_MISMATCH");
    return validateCoreRegistry(value.data,this.now());
  }
}

export class CoreRegistryObserver{
  constructor({client=new CoreRegistryClient(),now=()=>Date.now(),minIntervalMs=120000}={}){
    this.client=client;this.now=now;this.minIntervalMs=minIntervalMs;
    this.pending=null;
    this.snapshot={status:client.configured?"not_checked":"disabled",checkedAt:null,
      errorCode:client.configured?null:"CORE_REGISTRY_NOT_CONFIGURED",
      projects:[],repositories:[],tracks:[],completeCoverage:false,safeToAdvance:false};
  }
  current(){return this.snapshot;}
  async refresh(){
    if(!this.client.configured)return this.current();
    if(this.pending)return this.pending;
    if(this.snapshot.checkedAt!==null&&this.now()-this.snapshot.checkedAt<this.minIntervalMs)
      return this.current();
    this.pending=(async()=>{
      const checkedAt=this.now();
      try{
        const value=await this.client.read();
        this.snapshot={status:"observed",checkedAt,errorCode:null,
          projects:value.projects,repositories:value.repositories,tracks:value.tracks,
          completeCoverage:false,safeToAdvance:false};
      }catch(error){
        this.snapshot={status:"unavailable",checkedAt,
          errorCode:error instanceof CoreRegistryError?error.code:"CORE_REGISTRY_UNAVAILABLE",
          projects:[],repositories:[],tracks:[],completeCoverage:false,safeToAdvance:false};
      }
      return this.current();
    })().finally(()=>{this.pending=null;});
    return this.pending;
  }
}
