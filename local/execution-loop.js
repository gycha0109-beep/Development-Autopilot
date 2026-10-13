import { createHash, randomUUID } from "node:crypto";
import {
  MOCK_ADAPTER_ID, DeterministicMockAdapter,
  executionRequest, verifyMockResult
} from "./execution-adapter.js";

const hex = value => createHash("sha256").update(value).digest("hex");
const statuses = ["draft","approved","running","waiting","verified","failed","unknown"];
const validText = (value, max) => typeof value === "string" && value.trim().length > 0 &&
  value.trim().length <= max;
const APPROVAL_TTL_MS = 10 * 60_000;
const format = row => row ? {
  id:row.id,workstreamId:row.workstream_id,taskRevision:row.task_revision,
  fingerprint:row.fingerprint,title:row.title,instruction:row.instruction,
  expectedMarker:row.expected_marker,adapterId:row.adapter_id,status:row.status,
  approvedAt:row.approved_at,approvalExpiresAt:row.approval_expires_at,
  operationId:row.operation_id,createdAt:row.created_at,updatedAt:row.updated_at,
  finishedAt:row.finished_at,resultReason:row.result_reason,
  simulated:true,verifiedSimulation:row.status==="verified",phaseComplete:false
} : null;

export class ExecutionLoop {
  constructor(store,{gate,watchtower,github,adapter=new DeterministicMockAdapter(),
    now=()=>Date.now()}={}){
    if(!gate || !watchtower || !github)throw new Error("ExecutionLoop requires all policy sources.");
    if(adapter.id!==MOCK_ADAPTER_ID ||
       adapter.capabilities?.contractVersion!==1 ||
       adapter.capabilities?.sideEffects!==false ||
       adapter.capabilities?.supportsInspection!==true ||
       typeof adapter.submit!=="function" || typeof adapter.inspect!=="function"){
      throw new Error("Only the no-side-effect simulation adapter is authorized in Phase 4.");
    }
    this.store=store;this.db=store.db;this.gate=gate;
    this.watchtower=watchtower;this.github=github;
    this.adapter=adapter;this.now=now;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS execution_plans(",
      "id TEXT PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id),",
      "task_revision INTEGER NOT NULL,fingerprint TEXT NOT NULL UNIQUE,",
      "adapter_id TEXT NOT NULL,title TEXT NOT NULL,instruction TEXT NOT NULL,",
      "expected_marker TEXT NOT NULL,status TEXT NOT NULL",
      "CHECK(status IN ('draft','approved','running','waiting','verified','failed','unknown')),",
      "approved_at INTEGER,approval_expires_at INTEGER,operation_id TEXT UNIQUE,",
      "request_json TEXT,receipt_json TEXT,result_reason TEXT,",
      "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,finished_at INTEGER,",
      "UNIQUE(workstream_id,task_revision)) STRICT;"
    ].join(" "));
  }
  hasAny(workstreamId){
    return Boolean(this.db.prepare(
      "SELECT 1 FROM execution_plans WHERE workstream_id=? LIMIT 1"
    ).get(workstreamId));
  }
  list(){
    return this.db.prepare("SELECT * FROM execution_plans ORDER BY created_at,id").all().map(format);
  }
  raw(id){
    return this.db.prepare("SELECT * FROM execution_plans WHERE id=?").get(id)||null;
  }
  must(id){
    const plan=this.raw(id);
    if(!plan)throw new Error("SIMULATION_PLAN_NOT_FOUND");
    return plan;
  }
  snapshot(id){return format(this.must(id));}
  requiresEvidence(id){
    return this.watchtower.targets.list().some(t=>t.workstreamId===id) ||
      this.github.targets.list().some(t=>t.workstreamId===id);
  }
  preflight(workstreamId){
    const ws=this.store.mustGet(workstreamId);
    if(this.store.isStopped())throw new Error("GLOBAL_STOP_ACTIVE");
    if(!ws.enabled||ws.paused)throw new Error("WORKSTREAM_PAUSED");
    if(ws.mode!=="simulation"||ws.state!=="READY"||ws.active_operation_id)
      throw new Error("WORKSTREAM_NOT_READY");
    if(this.requiresEvidence(workstreamId) &&
       this.gate.one(workstreamId)?.decision!=="REVIEWED"){
      throw new Error("CI_PR_EVIDENCE_REQUIRES_REVIEW");
    }
    return ws;
  }
  create({workstreamId,title,instruction,expectedMarker="SIMULATED_PASS"}={}){
    if(!validText(title,120)||!validText(instruction,500)||
       !validText(expectedMarker,64)||!/^[A-Z0-9_-]{3,64}$/.test(expectedMarker)) {
      throw new Error("INVALID_SIMULATION_PLAN");
    }
    const now=this.now();
    return this.store.transaction(()=>{
      const ws=this.preflight(workstreamId);
      if(this.hasAny(workstreamId)){
        // One immutable plan per revision, no silent overwrite after approval.
        const existing=this.db.prepare(
          "SELECT id FROM execution_plans WHERE workstream_id=? AND task_revision=?"
        ).get(workstreamId,ws.task_revision);
        if(existing)throw new Error("TASK_REVISION_ALREADY_PLANNED");
      }
      const op=this.db.prepare(
        "SELECT id FROM operations WHERE workstream_id=? AND task_revision=? LIMIT 1"
      ).get(workstreamId,ws.task_revision);
      if(op)throw new Error("TASK_REVISION_ALREADY_DISPATCHED");
      const fingerprint=hex(JSON.stringify({
        workstreamId,revision:ws.task_revision,repository:ws.repository,
        projectKey:ws.project_key,trackKey:ws.track_key,
        title:title.trim(),instruction:instruction.trim(),expectedMarker,adapterId:MOCK_ADAPTER_ID
      }));
      const id=randomUUID();
      this.db.prepare(
        "INSERT INTO execution_plans(id,workstream_id,task_revision,fingerprint,"+
        "adapter_id,title,instruction,expected_marker,status,created_at,updated_at) "+
        "VALUES(?,?,?,?,?,?,?,?,'draft',?,?)"
      ).run(id,workstreamId,ws.task_revision,fingerprint,MOCK_ADAPTER_ID,
        title.trim(),instruction.trim(),expectedMarker,now,now);
      this.store.event(workstreamId,now,"phase4_plan_created",ws.state,ws.state,
        "simulation_only_plan_created");
      return this.snapshot(id);
    });
  }
  approve(id){
    const now=this.now();
    return this.store.transaction(()=>{
      const plan=this.must(id);
      if(plan.status!=="draft")throw new Error("PLAN_APPROVAL_NOT_ALLOWED");
      const ws=this.preflight(plan.workstream_id);
      if(ws.task_revision!==plan.task_revision)throw new Error("TASK_REVISION_CHANGED");
      this.db.prepare(
        "UPDATE execution_plans SET status='approved',approved_at=?,approval_expires_at=?,updated_at=? WHERE id=?"
      ).run(now,now+APPROVAL_TTL_MS,now,id);
      this.store.event(plan.workstream_id,now,"phase4_plan_approved",ws.state,ws.state,
        "one_task_operator_approval_simulation_only");
      return this.snapshot(id);
    });
  }
  verifyApproval(plan,now){
    if(plan.status!=="approved"||!Number.isSafeInteger(plan.approved_at)||
       now<plan.approved_at || now>=plan.approval_expires_at){
      throw new Error("PLAN_APPROVAL_MISSING_OR_EXPIRED");
    }
    const ws=this.preflight(plan.workstream_id);
    if(ws.task_revision!==plan.task_revision)throw new Error("TASK_REVISION_CHANGED");
    return ws;
  }
  async dispatch(id){
    const now=this.now();
    // No await occurs between policy check and SQLite operation reservation.
    const plan=this.must(id);
    const ws=this.verifyApproval(plan,now);
    const operation=this.store.claimDue(ws.id,now);
    if(!operation)throw new Error("OPERATION_NOT_CLAIMABLE");
    this.db.prepare(
      "UPDATE execution_plans SET status='running',operation_id=?,updated_at=? WHERE id=?"
    ).run(operation.operationId,now,id);
    const request=executionRequest(ws,plan,operation);
    try{
      const receipt=await this.adapter.submit(request);
      if(!receipt || receipt.accepted!==true ||
         receipt.adapterId!==MOCK_ADAPTER_ID||
         receipt.operationId!==operation.operationId ||
         receipt.fingerprint!==plan.fingerprint ||
         receipt.receiptId!=="mock:"+operation.operationId){
        throw new Error("ADAPTER_RECEIPT_UNVERIFIED");
      }
      // Durable receipt written BEFORE changing operation to accepted.
      this.db.prepare(
        "UPDATE execution_plans SET request_json=?,receipt_json=?,updated_at=? WHERE id=?"
      ).run(JSON.stringify(request),JSON.stringify(receipt),this.now(),id);
      this.store.acknowledged(operation.operationId,this.now());
      this.db.prepare(
        "UPDATE execution_plans SET status='waiting',updated_at=? WHERE id=?"
      ).run(this.now(),id);
      this.store.event(ws.id,this.now(),"phase4_adapter_accepted","RUNNING","WAIT_EXTERNAL",
        "mock_adapter_accepted_not_completed",operation.operationId);
      return this.snapshot(id);
    }catch{
      // Even if the adapter accepted before throwing, never replay this operation.
      this.store.resolve(operation.operationId,"abandoned",this.now());
      this.db.prepare(
        "UPDATE execution_plans SET status='unknown',result_reason=?,updated_at=? WHERE id=?"
      ).run("SUBMIT_OUTCOME_AMBIGUOUS_NO_RETRY",this.now(),id);
      return this.snapshot(id);
    }
  }
  async inspect(id){
    const plan=this.must(id);
    if(plan.status!=="waiting" || !plan.receipt_json || !plan.request_json ||
       !plan.operation_id) throw new Error("NO_INSPECTABLE_RECEIPT");
    const ws=this.store.mustGet(plan.workstream_id);
    const op=this.db.prepare("SELECT * FROM operations WHERE id=?").get(plan.operation_id);
    if(ws.active_operation_id!==plan.operation_id || ws.state!=="WAIT_EXTERNAL" ||
       op?.status!=="accepted" || op?.task_revision!==plan.task_revision){
      throw new Error("OPERATION_RECEIPT_NOT_CURRENT");
    }
    const request=JSON.parse(plan.request_json);
    const receipt=JSON.parse(plan.receipt_json);
    if(request.fingerprint!==plan.fingerprint||request.workstreamId!==ws.id ||
       request.taskRevision!==ws.task_revision||request.repository!==ws.repository) {
      throw new Error("PERSISTED_REQUEST_IDENTITY_MISMATCH");
    }
    let observation;
    try{
      observation=await this.adapter.inspect(receipt,request);
    }catch{
      // A provider failure is not evidence of execution failure or success.
      this.store.resolve(plan.operation_id,"abandoned",this.now());
      this.db.prepare(
        "UPDATE execution_plans SET status='unknown',result_reason=?,updated_at=? WHERE id=?"
      ).run("INSPECT_OUTCOME_UNKNOWN",this.now(),id);
      return this.snapshot(id);
    }
    const verdict=verifyMockResult(request,receipt,observation);
    if(verdict.pending){
      this.store.event(ws.id,this.now(),"phase4_inspect_pending","WAIT_EXTERNAL","WAIT_EXTERNAL",
        "mock_result_not_ready",plan.operation_id);
      return this.snapshot(id);
    }
    const outcome=verdict.verified?"completed":"failed";
    this.store.resolve(plan.operation_id,outcome,this.now());
    this.db.prepare(
      "UPDATE execution_plans SET status=?,result_reason=?,finished_at=?,updated_at=? WHERE id=?"
    ).run(verdict.verified?"verified":"failed",verdict.reason,this.now(),this.now(),id);
    this.store.event(ws.id,this.now(),"phase4_result_verified","WAIT_EXTERNAL",
      verdict.verified?"COMPLETE":"BLOCKED",verdict.reason,plan.operation_id);
    return this.snapshot(id);
  }
  reconcileOnStartup(){
    const now=this.now();
    let changed=0;
    this.store.transaction(()=>{
      const plans=this.db.prepare(
        "SELECT id,workstream_id,operation_id,status FROM execution_plans WHERE status IN ('running','waiting')"
      ).all();
      for(const plan of plans){
        const ws=this.store.mustGet(plan.workstream_id);
        if(plan.status==="waiting" && ws.state==="WAIT_EXTERNAL" &&
           ws.active_operation_id===plan.operation_id) continue;
        this.db.prepare(
          "UPDATE execution_plans SET status='unknown',result_reason=?,updated_at=? WHERE id=?"
        ).run("STARTUP_RECONCILIATION_REQUIRED_NO_REPLAY",now,plan.id);
        this.store.event(ws.id,now,"phase4_recovery",ws.state,ws.state,
          "ambiguous_adapter_receipt_requires_manual_reconciliation",plan.operation_id);
        changed++;
      }
    });
    return changed;
  }
}
