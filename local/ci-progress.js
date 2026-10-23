// Read-only PR-scoped CI assessment. It never authorizes a merge, roadmap
// advance, prompt submission or the execution of a repair.
import {createHash} from "node:crypto";
import {CiPrEvidenceObserver} from "./ci-pr-evidence.js";

const sha=value=>typeof value==="string"&&/^[a-f0-9]{40}$/i.test(value);
const fresh=(at,now,maxAge)=>Number.isSafeInteger(at)&&at<=now+5000&&now-at<=maxAge;
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const activeStates=new Set(["PENDING","RUNNING","QUEUED"]);
const allowedStage=new Set(["preflight","integration"]);
const integrationName=name=>typeof name==="string"&&name.length>0&&name.length<=128&&
  /^[A-Za-z0-9][A-Za-z0-9 ._:/()\u00b7-]*$/.test(name);

export function projectChecks(checks){
  if(!checks||!Array.isArray(checks.check_runs)||!Number.isSafeInteger(checks.total_count)||
    checks.total_count>checks.check_runs.length)return {complete:false,checks:[]};
  const seen=new Map();
  for(const c of checks.check_runs){
    if(!Number.isSafeInteger(c.id)||typeof c.name!=="string"||!c.name||
       !Number.isSafeInteger(c.app?.id))return {complete:false,checks:[]};
    const key=c.name+"#"+c.app.id;
    const old=seen.get(key);
    if(!old||old.id<c.id)seen.set(key,c);
  }
  const normalized=[...seen.values()].map(c=>({
    name:c.name,appId:c.app.id,id:c.id,
    state:c.status!=="completed"?"PENDING":
      c.conclusion==="success"?"SUCCESS":
      ["failure","timed_out","action_required"].includes(c.conclusion)?"FAILURE":
      c.conclusion==="cancelled"?"CANCELLED":"UNKNOWN"
  }));
  return {complete:true,checks:normalized};
}

function phaseState(checks){
  if(!checks.length)return "UNKNOWN";
  if(checks.some(c=>c.state==="FAILURE"))return "RED";
  if(checks.some(c=>c.state==="CANCELLED"))return "UNKNOWN";
  if(checks.some(c=>c.state==="UNKNOWN"))return "UNKNOWN";
  if(checks.some(c=>activeStates.has(c.state)))return "PENDING";
  return checks.every(c=>c.state==="SUCCESS")?"GREEN":"UNKNOWN";
}

export function assessCiProgress({workstream,watchtower,github,prEvidence=null,stage="preflight",
  integrationCheck="CI Integration Verify",now=Date.now()}={}){
  const id=workstream?.id??null;
  const fail=(reason,details={})=>({workstreamId:id,stage,state:"UNKNOWN",action:"INSPECT",
    reason,verified:false,safeToAdvance:false,...details});
  if(!id||!allowedStage.has(stage)||!integrationName(integrationCheck))
    return fail("INVALID_CI_PROGRESS_CONFIGURATION");
  const wtTarget=watchtower?.targets?.filter(t=>t.workstreamId===id)||[];
  const ghTarget=github?.targets?.filter(t=>t.workstreamId===id)||[];
  if(ghTarget.length!==1)return fail("EXACT_PR_TARGET_REQUIRED");
  const target=ghTarget[0];
  if(target.headSha?.toLowerCase()!==target.headSha||!sha(target.headSha)||
     !Number.isSafeInteger(target.prNumber)||target.prNumber<1)
    return fail("INVALID_PR_TARGET");
  const result=github?.results?.filter(r=>r.workstreamId===id)||[];
  if(github.status!=="observed"||github.errorCode||!fresh(github.checkedAt,now,180000)||
    github.checkedAt<target.configuredAt||result.length!==1)
    return fail("GITHUB_EVIDENCE_UNAVAILABLE");
  const gh=result[0];
  if(gh.repository!==workstream.repository||gh.headSha!==target.headSha||gh.prNumber!==target.prNumber)
    return fail("PR_IDENTITY_MISMATCH");
  if(wtTarget.length!==1)return fail("WATCHTOWER_RUN_BINDING_REQUIRED");
  const wt=wtTarget[0];
  if(!sha(wt.headSha)||wt.headSha.toLowerCase()!==target.headSha)
    return fail("WATCHTOWER_HEAD_MISMATCH");
  const wr=watchtower?.results?.filter(r=>r.workstreamId===id)||[];
  if(watchtower.status!=="connected"||watchtower.contractVersion!=="1.0"||
     watchtower.errorCode||!fresh(watchtower.checkedAt,now,90000)||
     watchtower.checkedAt<wt.configuredAt||wr.length!==1)
    return fail("WATCHTOWER_EVIDENCE_UNAVAILABLE");
  const observed=wr[0];
  if(observed.repository!==workstream.repository||observed.runId!==wt.runId||
     observed.attempt!==wt.attempt||observed.headSha!==target.headSha||
     observed.repositoryId!==wt.repositoryId||
     (workstream.track_key&&observed.workTrackKey!==workstream.track_key))
    return fail("WATCHTOWER_RUN_IDENTITY_MISMATCH");
  if(observed.decision==="UNKNOWN"||observed.evidenceState!=="FRESH"||
     observed.safeToAdvance!==false)
    return fail("WATCHTOWER_UNTRUSTED_EVIDENCE");
  if(gh.runVerified!==true||gh.runId!==wt.runId||gh.attempt!==wt.attempt||
     gh.runCiState!==observed.ciState)
    return fail("GITHUB_RUN_CORROBORATION_MISSING");
  if(gh.state==="UNKNOWN"||!Array.isArray(gh.checks)||!Array.isArray(gh.observedChecks)||
     gh.checkCoverageComplete!==true)return fail("CHECK_COVERAGE_UNVERIFIED");
  if(!gh.checks.every(c=>typeof c.name==="string"&&
    ["SUCCESS","FAILURE","PENDING","UNKNOWN"].includes(c.state)))
    return fail("INVALID_REQUIRED_CHECKS");

  const ordinary=gh.checks.filter(c=>c.name!==integrationCheck);
  const integration=gh.observedChecks.filter(c=>c.name===integrationCheck);
  // Once a matching integration check starts, its outcome must not be hidden
  // behind an earlier ordinary GREEN even if the stage was not toggled yet.
  const matchingPr=prEvidence?.results?.filter(r=>r.workstreamId===id)||[];
  if(prEvidence && matchingPr.length!==1)
    return fail("PR_SCOPED_EVIDENCE_MISSING");
  const prResult=matchingPr[0]||null;
  if(prResult&&(prResult.prNumber!==target.prNumber||prResult.headSha!==target.headSha||
      prResult.repository!==workstream.repository))
    return fail("PR_SCOPED_EVIDENCE_IDENTITY_MISMATCH");
  const bridgeIntegration=prResult?.runs?.filter(r=>r.kind==="integration")||[];
  const bridgeGeneral=prResult?.runs?.filter(r=>r.kind==="general")||[];
  if(bridgeIntegration.length>1||bridgeGeneral.length>1)
    return fail("AMBIGUOUS_PR_CI_EVIDENCE");
  const integrationRequired=stage==="integration"||integration.length>0||
    bridgeIntegration.length>0||gh.checks.some(c=>c.name===integrationCheck);
  const ordinaryState=phaseState(ordinary);
  let integrationState=integration.length===0?(integrationRequired?"NOT_STARTED":"NOT_REQUESTED"):
    integration.length===1?phaseState(integration):"UNKNOWN";
  let phase=integrationRequired?
    (ordinaryState==="RED"||integrationState==="RED"?"RED":
      ordinaryState==="GREEN"&&integrationState==="GREEN"?"GREEN":
      ["PENDING","NOT_STARTED"].includes(integrationState)||ordinaryState==="PENDING"?"PENDING":"UNKNOWN"):
    ordinaryState;
  let specialReason=null;
  // An integration workflow_dispatch Run can be attached to this PR but have a
  // *different workflow-run HEAD* from the tested PR candidate SHA.
  // The new Watchtower bridge verifies the association, not the pinned base.
  // Hence a green integration Run still cannot release an execution gate.
  if(bridgeIntegration.length===1){
    const linked=bridgeIntegration[0];
    integrationState=linked.state;
    if(prResult.status!=="observed"){
      phase="UNKNOWN";specialReason="PR_SCOPED_BRIDGE_UNAVAILABLE";
    }else if(linked.state==="RED"){
      phase="RED";specialReason="INTEGRATION_CI_FAILED";
    }else if(linked.state==="PENDING"){
      phase=ordinaryState==="RED"?"RED":"PENDING";
      specialReason="INTEGRATION_CI_RUNNING";
    }else{
      phase="UNKNOWN";
      specialReason=linked.reason==="INTEGRATION_BASELINE_UNVERIFIED"?
        linked.reason:"INTEGRATION_GITHUB_CORROBORATION_REQUIRED";
    }
  }else if(integrationRequired&&prEvidence){
    if(prResult.status!=="observed"){
      phase="UNKNOWN";specialReason="PR_SCOPED_BRIDGE_UNAVAILABLE";
    }else if(integrationState==="GREEN"){
      phase="UNKNOWN";specialReason="INTEGRATION_RUN_ASSOCIATION_UNVERIFIED";
    }else if(integrationState==="NOT_STARTED"){
      phase="PENDING";specialReason="INTEGRATION_RUN_NOT_OBSERVED";
    }
  }
  if(bridgeGeneral.length===1&&bridgeGeneral[0].state!=="GREEN"&&phase==="GREEN"){
    phase="UNKNOWN";specialReason="LATEST_GENERAL_CI_NOT_GREEN";
  }
  // An optional watched Run can fail while required checks appear green.
  // Never promote such a contradiction into a GREEN progress verdict.
  if(phase==="GREEN"&&(observed.ciState!=="SUCCESS"||observed.decision!=="VERIFY_GITHUB"))
    return fail("WATCHTOWER_RUN_NOT_SUCCESSFUL");
  // A CI snapshot is advisory until the separate merge/approval gate passes.
  const reason=specialReason||(phase==="GREEN"?"CI_CHECKS_GREEN_MERGE_GATE_STILL_REQUIRED":
    phase==="RED"?"CI_CHECK_FAILED":phase==="PENDING"?"CI_CHECK_PENDING":"CI_CHECKS_INDETERMINATE");
  return {workstreamId:id,repository:workstream.repository,prNumber:target.prNumber,
    headSha:target.headSha,stage,integrationCheck,
    ordinaryState,integrationState,integrationRequired,
    ordinaryChecks:ordinary,integrationChecks:integration,
    observedIntegrationRun:bridgeIntegration[0]||null,
    state:phase,action:phase==="RED"?"REPAIR_REVIEW":
      phase==="PENDING"?"WAIT_CI":phase==="GREEN"?"VERIFY_MERGE_AND_APPROVAL":"INSPECT",
    reason,verified:phase!=="UNKNOWN",safeToAdvance:false,
    evidenceHash:hash([id,workstream.task_revision,workstream.repository,target.prNumber,target.headSha,
      wt.runId,wt.attempt,stage,ordinary,integration,gh.checks,gh.state,
      bridgeIntegration,bridgeGeneral])};
}

export class CiStageTargets {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ci_stage_targets(
      workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK(stage IN ('preflight','integration')),
      integration_check TEXT NOT NULL,
      configured_at INTEGER NOT NULL) STRICT;`);
  }
  get(id){
    const row=this.db.prepare("SELECT stage,integration_check AS integrationCheck,configured_at AS configuredAt FROM ci_stage_targets WHERE workstream_id=?").get(id);
    return row||{stage:"preflight",integrationCheck:"CI Integration Verify",configuredAt:null};
  }
  set(id,{stage,integrationCheck="CI Integration Verify"},at=Date.now()){
    this.store.mustGet(id);
    if(!allowedStage.has(stage)||!integrationName(integrationCheck))throw Error("INVALID_CI_STAGE");
    return this.store.transaction(()=>{
      this.db.prepare(`INSERT INTO ci_stage_targets(workstream_id,stage,integration_check,configured_at)
        VALUES(?,?,?,?) ON CONFLICT(workstream_id) DO UPDATE SET
        stage=excluded.stage,integration_check=excluded.integration_check,
        configured_at=excluded.configured_at`).run(id,stage,integrationCheck,at);
      this.store.event(id,at,"ci_stage_target_set",null,null,"CI_PROGRESS_OBSERVATION_ONLY");
      return this.get(id);
    });
  }
  list(){return this.store.list().map(w=>({workstreamId:w.id,...this.get(w.id)}));}
}

export class CiProgressObserver {
  constructor(store,{watchtower,github,now=()=>Date.now()}={}){
    this.store=store;this.watchtower=watchtower;this.github=github;this.now=now;
    this.targets=new CiStageTargets(store);
    this.prEvidence=new CiPrEvidenceObserver({store,watchtower,github,now});
  }
  async refreshPrEvidence(){return this.prEvidence.refresh();}
  current(){
    const watchtower=this.watchtower.current(),github=this.github.current(),now=this.now();
    const prEvidence=this.prEvidence.current();
    return {checkedAt:now,prEvidence,results:this.store.list().map(workstream=>
      assessCiProgress({workstream,watchtower,github,prEvidence:
        prEvidence.status==="not_checked"?null:prEvidence,
        now,...this.targets.get(workstream.id)})),
      targets:this.targets.list()};
  }
}
