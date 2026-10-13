import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync=promisify(execFile);
export const WATCHTOWER_URL="http://127.0.0.1:48765/v1";
const credentialScript=fileURLToPath(new URL("./watchtower-credential.ps1",import.meta.url));

export class WatchtowerError extends Error {
  constructor(code,message=code){
    super(message);
    this.name="WatchtowerError";
    this.code=code;
  }
}
export async function getWindowsBridgeCredential(){
  if(process.platform!=="win32")throw new WatchtowerError("CREDENTIAL_UNAVAILABLE",
    "Watchtower Bridge 자격 증명은 Windows 사용자 계정에서만 읽을 수 있습니다.");
  try {
    const {stdout}=await execFileAsync("powershell.exe",[
      "-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",credentialScript
    ],{windowsHide:true,timeout:5000,maxBuffer:8192});
    const credential=stdout.trim();
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(credential)){
      throw new Error("No valid bridge credential");
    }
    return credential;
  } catch {
    // Never include child process stderr, credential target contents or token in logs.
    throw new WatchtowerError("CREDENTIAL_UNAVAILABLE",
      "현재 Windows 사용자 Credential Manager에서 Watchtower 브리지 키를 읽지 못했습니다.");
  }
}

export function safePositiveInteger(v,label){
  if(!Number.isSafeInteger(v)||v<1)throw new WatchtowerError("INVALID_TARGET",label+"은 양의 정수여야 합니다.");
  return v;
}
export function safeSha(v){
  if(typeof v!=="string"||!/^[a-fA-F0-9]{40}$/.test(v)){
    throw new WatchtowerError("INVALID_TARGET","GitHub Head SHA는 40자리여야 합니다.");
  }
  return v.toLowerCase();
}
export function safeTrack(v){
  if(typeof v!=="string"||!/^[a-z0-9-]{1,100}$/.test(v)){
    throw new WatchtowerError("INVALID_TARGET","Track은 Watchtower canonical key여야 합니다.");
  }
  return v;
}
function requireEnvelope(response){
  if(!response || response.contractVersion!=="1.0"||!response.data||typeof response.data!=="object"){
    throw new WatchtowerError("CONTRACT_MISMATCH","Watchtower v1.0 계약을 확인하지 못했습니다.");
  }
  return response.data;
}
export class WatchtowerClient {
  constructor({fetchImpl=fetch,getToken=getWindowsBridgeCredential,baseUrl=WATCHTOWER_URL,timeoutMs=2500}={}){
    this.fetchImpl=fetchImpl;
    this.getToken=getToken;
    this.baseUrl=baseUrl;
    this.timeoutMs=timeoutMs;
    this.cachedCredential=null;
    this.credentialExpiresAt=0;
    this.credentialPromise=null;
  }
  async credential(){
    if(this.cachedCredential && Date.now()<this.credentialExpiresAt)return this.cachedCredential;
    if(this.credentialPromise)return this.credentialPromise;
    this.credentialPromise=(async()=>{
      try{
        const token=await this.getToken();
        if(typeof token!=="string"||token.length<32)throw new Error("Invalid token");
        this.cachedCredential=token;
        this.credentialExpiresAt=Date.now()+5*60_000;
        return token;
      }catch(error){
        if(error instanceof WatchtowerError)throw error;
        throw new WatchtowerError("CREDENTIAL_UNAVAILABLE","Watchtower 전용 Windows 자격 증명을 읽을 수 없습니다.");
      }
    })().finally(()=>{this.credentialPromise=null;});
    return this.credentialPromise;
  }
  async request(path,params={}){
    const url=new URL(this.baseUrl+path);
    for(const [key,value] of Object.entries(params)){
      if(value!==null && value!==undefined)url.searchParams.set(key,String(value));
    }
    let token=await this.credential();
    let response;
    try{
      response=await this.fetchImpl(url.toString(),{
        method:"GET",
        headers:{"Authorization":"Bearer "+token,"Accept":"application/json"},
        redirect:"error",
        cache:"no-store",
        signal:AbortSignal.timeout(this.timeoutMs)
      });
    }catch{
      throw new WatchtowerError("WATCHTOWER_UNAVAILABLE",
        "Watchtower가 종료되었거나 로컬 브리지를 사용할 수 없습니다.");
    }finally{token=null;}
    if(response.status===401){
      this.cachedCredential=null;
      this.credentialExpiresAt=0;
      throw new WatchtowerError("UNAUTHORIZED","Watchtower 브리지 인증에 실패했습니다.");
    }
    if(response.status===403)throw new WatchtowerError("LOCAL_CLIENT_ONLY");
    if(response.status===404)throw new WatchtowerError("RUN_NOT_FOUND");
    if(response.status===409){
      const payload=await response.json().catch(()=>null);
      const code=payload?.error?.code;
      throw new WatchtowerError(["HEAD_SHA_MISMATCH","RUN_ATTEMPT_MISMATCH"].includes(code)
        ? code:"TARGET_MISMATCH");
    }
    if(response.status===503)throw new WatchtowerError("DATABASE_UNAVAILABLE");
    if(!response.ok)throw new WatchtowerError("WATCHTOWER_ERROR","Watchtower 상태 요청 실패");
    const length=Number(response.headers?.get?.("content-length") || 0);
    if(length>1_000_000)throw new WatchtowerError("INVALID_RESPONSE");
    let payload;
    try{payload=await response.json();}
    catch{throw new WatchtowerError("INVALID_RESPONSE");}
    return requireEnvelope(payload);
  }
  async health(){
    const data=await this.request("/health");
    if(data.bridge!=="connected"||data.version!=="1.0")
      throw new WatchtowerError("CONTRACT_MISMATCH");
    return {connected:true,contractVersion:"1.0"};
  }
  async registry(){
    const data=await this.request("/registry");
    if(!Array.isArray(data.projects)||!Array.isArray(data.repositories)||!Array.isArray(data.tracks))
      throw new WatchtowerError("INVALID_RESPONSE");
    return data;
  }
  async runs({repositoryId,projectId,trackKey,headSha,limit=30}){
    safePositiveInteger(repositoryId,"Repository ID");
    if(projectId!==undefined&&projectId!==null)safePositiveInteger(projectId,"Project ID");
    if(trackKey!==undefined&&trackKey!==null)safeTrack(trackKey);
    if(headSha!==undefined&&headSha!==null)safeSha(headSha);
    const data=await this.request("/runs",{
      repository_id:repositoryId,project_id:projectId,
      track_key:trackKey,head_sha:headSha,limit
    });
    if(!Array.isArray(data.runs)||data.completeCoverage!==false)
      throw new WatchtowerError("INVALID_RESPONSE");
    return data;
  }
  async run({runId,repositoryId,headSha,attempt}){
    safePositiveInteger(runId,"Run ID");
    safePositiveInteger(repositoryId,"Repository ID");
    safeSha(headSha);
    safePositiveInteger(attempt,"Attempt");
    const data=await this.request("/runs/"+runId,{
      repository_id:repositoryId,head_sha:headSha,attempt
    });
    if(!data.run||typeof data.run!=="object")throw new WatchtowerError("INVALID_RESPONSE");
    return data.run;
  }
}

export function matchingRepository(registry,repository,projectKey=null){
  const projects=new Map(registry.projects.map(p=>[p.id,p]));
  const matches=registry.repositories.filter(r=>r.name===repository &&
    r.enabled===true && (!projectKey||projects.get(r.projectId)?.key===projectKey));
  if(matches.length!==1)return {matched:false,reason:matches.length===0?
    "REPOSITORY_NOT_REGISTERED":"AMBIGUOUS_REPOSITORY"};
  return {matched:true,repository:matches[0],project:projects.get(matches[0].projectId)};
}

// Watchtower is observational and never authorizes an executor.
export function decideWatchtowerRun(run,{repositoryId,repository,trackKey,headSha,attempt,runId},now=Date.now()){
  const blocked=(decision,reason)=>({decision,reason,safeToAdvance:false});
  if(!run||typeof run!=="object")return blocked("UNKNOWN","NO_RUN");
  if(run.repositoryId!==repositoryId||run.repository!==repository||run.runId!==runId)
    return blocked("UNKNOWN","TARGET_IDENTITY_MISMATCH");
  if(typeof headSha!=="string"||run.headSha?.toLowerCase()!==headSha.toLowerCase()||
     run.runAttempt!==attempt||run.latestKnownAttempt!==attempt||run.targetVerified!==true)
    return blocked("UNKNOWN","HEAD_OR_ATTEMPT_UNVERIFIED");
  if(trackKey && run.workTrackKey!==trackKey)
    return blocked("UNKNOWN","WORK_TRACK_MISMATCH");
  if(trackKey && run.workTrackActive!==true)return blocked("UNKNOWN","INACTIVE_WORK_TRACK");
  if(run.attributionConflict||run.decisionState==="CONFLICT")
    return blocked("UNKNOWN","TRACK_CONFLICT");
  if(run.repositoryEnabled!==true ||run.evidenceState!=="FRESH"||
     run.decisionState==="STALE"||run.decisionState==="POLL_ERROR"||
     run.decisionState==="UNKNOWN")
    return blocked("UNKNOWN","UNTRUSTED_EVIDENCE");
  const observed=Date.parse(run.observedAt);
  if(!Number.isFinite(observed)||Math.abs(now-observed)>60_000)
    return blocked("UNKNOWN","RESPONSE_OBSERVATION_STALE");
  if(run.safeToAdvance!==false)return blocked("UNKNOWN","BRIDGE_CONTRACT_VIOLATION");
  if(run.pollErrorCode) return blocked("UNKNOWN","POLL_ERROR");
  if(run.decisionState!==run.ciState)return blocked("UNKNOWN","INCONSISTENT_CI_STATE");
  if(run.decisionState==="QUEUED"||run.decisionState==="RUNNING")
    return blocked("WAIT_EXTERNAL",run.decisionState);
  if(run.decisionState==="FAILURE")return blocked("BLOCKED","REQUIRED_CI_FAILURE");
  if(run.decisionState==="OTHER_TERMINAL")return blocked("BLOCKED","OTHER_TERMINAL");
  if(run.decisionState==="SUCCESS")
    return blocked("VERIFY_GITHUB","CI_SUCCESS_REQUIRES_PR_CHECKS_AND_APPROVALS");
  return blocked("UNKNOWN","UNRECOGNIZED_CI_STATE");
}
