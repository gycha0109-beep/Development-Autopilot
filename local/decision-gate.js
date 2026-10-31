import { createHash } from "node:crypto";

export const GATE_VERSION = 1;
export const WATCHTOWER_MAX_AGE_MS = 90_000;
export const GITHUB_MAX_AGE_MS = 180_000;
export const REVIEW_TTL_MS = 15 * 60_000;
const sha256 = input => createHash("sha256").update(input).digest("hex");

function recent(at, now, limit) {
  return Number.isSafeInteger(at) && at > 0 &&
    at <= now + 5_000 && now - at <= limit;
}

function exactOne(items, workstreamId) {
  const matches = Array.isArray(items) ? items.filter(x => x?.workstreamId === workstreamId) : [];
  return matches.length === 1 ? matches[0] : null;
}

function safeReason(value) {
  return typeof value === "string" ? value.slice(0, 100) : "UNKNOWN";
}

function deny(workstreamId, decision, reason, evidence = null) {
  return {
    version: GATE_VERSION,
    workstreamId,
    decision,
    reason,
    evidenceHash: evidence,
    operatorReviewed: false,
    executionAllowed: false,
    phaseComplete: false
  };
}

export function decideGate({
  workstream, globalStopped = false, watchtower, github, directCore = null, review = null,
  now = Date.now()
}) {
  if(directCore && directCore.status!=="disabled")
    return decideHeadlessGate({workstream,globalStopped,watchtower,github,directCore,review,now});
  const id = workstream?.id;
  if (typeof id !== "string" || !id) throw new Error("Gate requires a Workstream identity.");
  if (globalStopped === true) return deny(id, "PAUSED", "GLOBAL_EMERGENCY_STOP");
  if (!workstream.enabled || workstream.paused) return deny(id, "PAUSED", "WORKSTREAM_DISABLED_OR_PAUSED");
  if (workstream.active_operation_id || ["RUNNING","WAIT_EXTERNAL","WAIT_HUMAN"].includes(workstream.state)) {
    // An existing operation has its own lifecycle and may never be overwritten by a CI gate.
    return deny(id, "WAIT_EXTERNAL", "WORKSTREAM_OPERATION_PENDING");
  }
  if (workstream.state === "BLOCKED" || workstream.state === "UNKNOWN")
    return deny(id, "BLOCKED", "WORKSTREAM_REQUIRES_RECONCILIATION");
  if (workstream.state === "COMPLETE")
    return deny(id, "COMPLETE", "WORKSTREAM_ALREADY_COMPLETE");

  const wtTarget = exactOne(watchtower?.targets, id);
  const ghTarget = exactOne(github?.targets, id);
  if (!wtTarget || !ghTarget)
    return deny(id, "UNKNOWN", !wtTarget ? "WATCHTOWER_TARGET_MISSING" : "GITHUB_TARGET_MISSING");
  if (typeof wtTarget.headSha !== "string" || typeof ghTarget.headSha !== "string" ||
      !/^[a-f0-9]{40}$/i.test(wtTarget.headSha) ||
      wtTarget.headSha.toLowerCase() !== ghTarget.headSha.toLowerCase())
    return deny(id, "UNKNOWN", "TARGET_HEAD_SHA_MISMATCH");

  if (watchtower.status !== "connected" || watchtower.contractVersion !== "1.0" ||
      watchtower.errorCode || github.status !== "observed" || github.errorCode) {
    return deny(id, "UNKNOWN", "UPSTREAM_UNAVAILABLE_OR_INCOMPATIBLE");
  }
  if (!recent(watchtower.checkedAt, now, WATCHTOWER_MAX_AGE_MS) ||
      !recent(github.checkedAt, now, GITHUB_MAX_AGE_MS) ||
      watchtower.checkedAt < wtTarget.configuredAt ||
      github.checkedAt < ghTarget.configuredAt) {
    return deny(id, "UNKNOWN", "OBSERVATION_STALE_OR_PRECEDES_BINDING");
  }

  const wt = exactOne(watchtower.results, id);
  const gh = exactOne(github.results, id);
  if (!wt || !gh) return deny(id, "UNKNOWN", "RESULT_MISSING_OR_AMBIGUOUS");
  if (wt.safeToAdvance !== false || gh.safeToAdvance !== false)
    return deny(id, "UNKNOWN", "EVIDENCE_CONTRACT_VIOLATION");
  if (wt.repositoryId !== wtTarget.repositoryId || wt.repository !== workstream.repository ||
      gh.repository !== workstream.repository ||
      (workstream.track_key && wt.workTrackKey !== workstream.track_key)) {
    return deny(id, "UNKNOWN", "REPOSITORY_OR_TRACK_EVIDENCE_MISMATCH");
  }
  if (wt.runId !== wtTarget.runId || wt.attempt !== wtTarget.attempt ||
      wt.headSha?.toLowerCase() !== wtTarget.headSha.toLowerCase() ||
      gh.prNumber !== ghTarget.prNumber ||
      gh.headSha?.toLowerCase() !== ghTarget.headSha.toLowerCase()) {
    return deny(id, "UNKNOWN", "RESULT_TARGET_MISMATCH");
  }
  if (wt.decision === "UNKNOWN" || !["VERIFY_GITHUB", "WAIT_EXTERNAL", "BLOCKED"].includes(wt.decision)) {
    return deny(id, "UNKNOWN", "WATCHTOWER_" + safeReason(wt.reason));
  }
  if (wt.decision === "BLOCKED") return deny(id, "BLOCKED", "CI_" + safeReason(wt.reason));
  if (wt.decision === "WAIT_EXTERNAL") return deny(id, "WAIT_EXTERNAL", "CI_" + safeReason(wt.reason));
  if (wt.decision !== "VERIFY_GITHUB" || wt.ciState !== "SUCCESS" || wt.evidenceState !== "FRESH") {
    return deny(id, "UNKNOWN", "CI_NOT_PROVEN_SUCCESSFUL");
  }
  if (gh.state === "FAILURE") return deny(id, "BLOCKED", "GITHUB_REQUIRED_CHECK_FAILED");
  if (gh.state === "WAIT_EXTERNAL" || gh.state === "CHECKS_PASSED_NOT_MERGED")
    return deny(id, "WAIT_EXTERNAL", gh.state === "CHECKS_PASSED_NOT_MERGED" ? "PR_NOT_MERGED" : "GITHUB_CHECK_PENDING");
  if (gh.state !== "MERGED_CONFIRMED" || gh.merged !== true ||
      gh.requiredChecksVerified !== true) {
    return deny(id, "UNKNOWN", "GITHUB_MERGE_OR_CHECKS_UNVERIFIED");
  }

  const identity = {
    gateVersion:GATE_VERSION,workstreamId:id,
    taskRevision:workstream.task_revision,
    repository:workstream.repository,projectKey:workstream.project_key,
    trackKey:workstream.track_key,
    watchtower:{repositoryId:wtTarget.repositoryId,runId:wtTarget.runId,
      attempt:wtTarget.attempt,headSha:wtTarget.headSha.toLowerCase(),configuredAt:wtTarget.configuredAt},
    github:{prNumber:ghTarget.prNumber,headSha:ghTarget.headSha.toLowerCase(),configuredAt:ghTarget.configuredAt},
    observedEvidence:{
      watchtower:{ciState:wt.ciState,evidenceState:wt.evidenceState,decision:wt.decision,
        trackKey:wt.workTrackKey,responsibilityKind:wt.responsibilityKind},
      github:{state:gh.state,reason:gh.reason,merged:gh.merged,
        requiredChecksVerified:gh.requiredChecksVerified,
        checks: Array.isArray(gh.checks) ? gh.checks.map(c=>({name:c.name,state:c.state})) : []}
    }
  };
  const evidenceHash = sha256(JSON.stringify(identity));
  const approved = review?.evidenceHash === evidenceHash &&
    review.workstreamId === id &&
    review.taskRevision === workstream.task_revision &&
    recent(review.reviewedAt,now,REVIEW_TTL_MS) &&
    now < review.expiresAt;

  return {
    ...deny(id, approved ? "REVIEWED" : "WAIT_HUMAN",
      approved ? "OPERATOR_REVIEW_RECORDED_NO_EXECUTION" : "PHASE_ACCEPTANCE_REQUIRES_HUMAN_REVIEW",
      evidenceHash),
    operatorReviewed: Boolean(approved),
    expiresAt: approved ? review.expiresAt : null,
    githubPr: ghTarget.prNumber,
    runId:wtTarget.runId
  };
}

export function decideHeadlessGate({workstream,globalStopped=false,watchtower,github,
  directCore,review=null,now=Date.now()}={}){
  const id=workstream?.id;
  if(typeof id!=="string"||!id)throw new Error("Gate requires a Workstream identity.");
  if(globalStopped)return deny(id,"PAUSED","GLOBAL_EMERGENCY_STOP");
  if(!workstream.enabled||workstream.paused)return deny(id,"PAUSED","WORKSTREAM_DISABLED_OR_PAUSED");
  if(workstream.active_operation_id||["RUNNING","WAIT_EXTERNAL","WAIT_HUMAN"].includes(workstream.state))
    return deny(id,"WAIT_EXTERNAL","WORKSTREAM_OPERATION_PENDING");
  if(["BLOCKED","UNKNOWN"].includes(workstream.state))
    return deny(id,"BLOCKED","WORKSTREAM_REQUIRES_RECONCILIATION");
  if(workstream.state==="COMPLETE")return deny(id,"COMPLETE","WORKSTREAM_ALREADY_COMPLETE");
  const wtTarget=exactOne(watchtower?.targets,id);
  const ghTarget=exactOne(github?.targets,id);
  if(!wtTarget||!ghTarget)return deny(id,"UNKNOWN","EXACT_CI_AND_PR_TARGET_REQUIRED");
  if(!/^[a-f0-9]{40}$/i.test(wtTarget.headSha||"")||
     wtTarget.headSha.toLowerCase()!==ghTarget.headSha?.toLowerCase()||
     !Number.isSafeInteger(wtTarget.runId)||wtTarget.runId<1||
     !Number.isSafeInteger(wtTarget.attempt)||wtTarget.attempt<1||
     !Number.isSafeInteger(ghTarget.prNumber)||ghTarget.prNumber<1)
    return deny(id,"UNKNOWN","TARGET_HEAD_SHA_MISMATCH");
  if(directCore?.status!=="observed"||directCore.errorCode||
     github?.status!=="observed"||github.errorCode||
     !recent(directCore.checkedAt,now,WATCHTOWER_MAX_AGE_MS)||
     !recent(github.checkedAt,now,GITHUB_MAX_AGE_MS)||
     directCore.checkedAt<wtTarget.configuredAt||
     github.checkedAt<ghTarget.configuredAt)
    return deny(id,"UNKNOWN","HEADLESS_CI_OR_GITHUB_EVIDENCE_UNAVAILABLE");
  const ci=exactOne(directCore.results,id);
  const gh=exactOne(github.results,id);
  if(!ci||!gh||ci.safeToAdvance!==false||gh.safeToAdvance!==false||
     ci.source!=="github_actions_direct"||
     ci.repository!==workstream.repository||gh.repository!==workstream.repository||
     ci.runId!==wtTarget.runId||ci.attempt!==wtTarget.attempt||
     ci.prNumber!==ghTarget.prNumber||gh.prNumber!==ghTarget.prNumber||
     ci.headSha?.toLowerCase()!==wtTarget.headSha.toLowerCase()||
     gh.headSha?.toLowerCase()!==ghTarget.headSha.toLowerCase()||
     !recent(Date.parse(ci.observedAt),now,WATCHTOWER_MAX_AGE_MS))
    return deny(id,"UNKNOWN","HEADLESS_CI_TARGET_OR_EVIDENCE_MISMATCH");
  if(ci.decision==="BLOCKED")return deny(id,"BLOCKED","CI_"+safeReason(ci.reason));
  if(ci.decision==="WAIT_EXTERNAL")return deny(id,"WAIT_EXTERNAL","CI_"+safeReason(ci.reason));
  if(ci.decision!=="VERIFY_GITHUB"||ci.ciState!=="SUCCESS")
    return deny(id,"UNKNOWN","HEADLESS_CI_NOT_VERIFIED_SUCCESS");
  if(gh.state==="FAILURE")return deny(id,"BLOCKED","GITHUB_REQUIRED_CHECK_FAILED");
  if(["WAIT_EXTERNAL","CHECKS_PASSED_NOT_MERGED"].includes(gh.state))
    return deny(id,"WAIT_EXTERNAL",gh.state==="WAIT_EXTERNAL"?"GITHUB_CHECK_PENDING":"PR_NOT_MERGED");
  if(gh.state!=="MERGED_CONFIRMED"||gh.merged!==true||
     gh.requiredChecksVerified!==true||!Array.isArray(gh.checks)||
     gh.checks.some(c=>c.state!=="SUCCESS"))
    return deny(id,"UNKNOWN","GITHUB_MERGE_OR_REQUIRED_CHECKS_UNVERIFIED");
  const identity={
    gateVersion:GATE_VERSION,source:"headless_github_actions",
    workstreamId:id,taskRevision:workstream.task_revision,
    repository:workstream.repository,projectKey:workstream.project_key,
    trackKey:workstream.track_key,
    ci:{repositoryId:wtTarget.repositoryId,runId:wtTarget.runId,
      attempt:wtTarget.attempt,headSha:wtTarget.headSha.toLowerCase(),
      configuredAt:wtTarget.configuredAt,ciState:ci.ciState,decision:ci.decision},
    github:{prNumber:ghTarget.prNumber,headSha:ghTarget.headSha.toLowerCase(),
      configuredAt:ghTarget.configuredAt,state:gh.state,merged:gh.merged,
      requiredChecksVerified:gh.requiredChecksVerified,
      checks:gh.checks.map(c=>({name:c.name,state:c.state}))}
  };
  const evidenceHash=sha256(JSON.stringify(identity));
  const approved=review?.evidenceHash===evidenceHash&&review.workstreamId===id&&
    review.taskRevision===workstream.task_revision&&
    recent(review.reviewedAt,now,REVIEW_TTL_MS)&&now<review.expiresAt;
  return {...deny(id,approved?"REVIEWED":"WAIT_HUMAN",
    approved?"OPERATOR_REVIEW_RECORDED_NO_EXECUTION":"PHASE_ACCEPTANCE_REQUIRES_HUMAN_REVIEW",evidenceHash),
    operatorReviewed:Boolean(approved),expiresAt:approved?review.expiresAt:null,
    githubPr:ghTarget.prNumber,runId:wtTarget.runId,source:"headless_github_actions"};
}

export class DecisionGate {
  constructor(store,{watchtower,github,directCore=null,now=()=>Date.now()}={}){
    if(!watchtower || !github)throw new Error("Both observation sources are required");
    this.store=store;
    this.watchtower=watchtower;
    this.github=github;
    this.directCore=directCore;
    this.now=now;
    this.db=store.db;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS decision_gate_reviews(",
      "workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),",
      "evidence_hash TEXT NOT NULL,task_revision INTEGER NOT NULL,",
      "reviewed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS decision_gate_history(",
      "id INTEGER PRIMARY KEY AUTOINCREMENT,workstream_id TEXT NOT NULL REFERENCES workstreams(id),",
      "at INTEGER NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,",
      "evidence_hash TEXT) STRICT;"
    ].join(" "));
  }
  getReview(id){
    const row=this.db.prepare(
      "SELECT workstream_id AS workstreamId,evidence_hash AS evidenceHash,"+
      "task_revision AS taskRevision,reviewed_at AS reviewedAt,expires_at AS expiresAt "+
      "FROM decision_gate_reviews WHERE workstream_id=?"
    ).get(id);
    return row||null;
  }
  list(){
    const watchtower=this.watchtower.current();
    const github=this.github.current();
    const now=this.now();
    const stopped=this.store.isStopped();
    return this.store.list().map(workstream => decideGate({
      workstream,globalStopped:stopped,watchtower,github,
      directCore:this.directCore?.current()||null,
      review:this.getReview(workstream.id),now
    }));
  }
  one(id){
    this.store.mustGet(id);
    return this.list().find(row=>row.workstreamId===id);
  }
  recordCurrent(){
    const now=this.now();
    const current=this.list();
    this.store.transaction(()=>{
      for(const g of current){
        const previous=this.db.prepare(
          "SELECT decision,reason,evidence_hash FROM decision_gate_history "+
          "WHERE workstream_id=? ORDER BY id DESC LIMIT 1"
        ).get(g.workstreamId);
        if(previous?.decision===g.decision && previous?.reason===g.reason &&
           (previous?.evidence_hash??null)===g.evidenceHash)continue;
        this.db.prepare(
          "INSERT INTO decision_gate_history("+
          "workstream_id,at,decision,reason,evidence_hash) VALUES(?,?,?,?,?)"
        ).run(g.workstreamId,now,g.decision,g.reason,g.evidenceHash);
      }
    });
    return current;
  }
  recentHistory(limit=60){
    return this.db.prepare(
      "SELECT id,workstream_id AS workstreamId,at,decision,reason,"+
      "evidence_hash AS evidenceHash FROM decision_gate_history "+
      "ORDER BY id DESC LIMIT ?"
    ).all(Math.min(250,Math.max(1,limit)));
  }
  review(id){
    const now=this.now();
    return this.store.transaction(()=>{
      const workstream=this.store.mustGet(id);
      const gate=this.one(id);
      if(gate.decision!=="WAIT_HUMAN" || !gate.evidenceHash)
        throw new Error("CI/PR \uac80\uc99d\uacfc \uc0ac\uc6a9\uc790 \uc2b9\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.");
      const expiry=now+REVIEW_TTL_MS;
      this.db.prepare(
        "INSERT INTO decision_gate_reviews(workstream_id,evidence_hash,task_revision,reviewed_at,expires_at) "+
        "VALUES(?,?,?,?,?) ON CONFLICT(workstream_id) DO UPDATE SET "+
        "evidence_hash=excluded.evidence_hash,task_revision=excluded.task_revision,"+
        "reviewed_at=excluded.reviewed_at,expires_at=excluded.expires_at"
      ).run(id,gate.evidenceHash,workstream.task_revision,now,expiry);
      this.store.event(id,now,"decision_gate_review",null,null,
        "operator_acknowledged_evidence_only_no_execution");
      return this.one(id);
    });
  }
}
