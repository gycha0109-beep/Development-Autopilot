import {createHash} from "node:crypto";
import {classifyObservation,PAGE_UNAVAILABLE_REASONS} from "./chat-observation.js";
import {decideGate} from "./decision-gate.js";
import {ciWaitTimeout} from "./ci-wait.js";
import {ciResumeTarget} from "./ci-resume.js";

export const ACTIONS = Object.freeze(["NO_ACTION","INSPECT_AGAIN","CHECK_CI","WAIT_CI",
  "CONTINUE","BEGIN_HANDOFF","RECOVER_DISCONNECT","CALL_OPERATOR","UNKNOWN"]);
export const hashAction = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;

export function scopeProblem(workstream,scope,now){
  if(!time(now))return "INVALID_CLOCK";
  if (!scope || scope.approved!==true || scope.taskRevision!==workstream.task_revision ||
      !time(scope.expiresAt) || now>=scope.expiresAt || !hex(scope.messageHash))return "SCOPE_NOT_APPROVED";
  if (scope.observationPermitted!==true || scope.executionPermitted!==true)return "PROVIDER_CAPABILITY_NOT_APPROVED";
  return null;
}

// Pure: observation/CI are evidence; only an operator scope grants permission.
export function decideNextAction({workstream,observation,previous=null,globalStopped=true,
  scope=null,policy={},ci={},operation=null,responseConsumed=false,now} = {}) {
  const id=workstream?.id;
  const classified=classifyObservation(observation,{previous,now,
    stableForMs:policy.stableForMs,maxAgeMs:policy.maxAgeMs});
  let evidenceHash=null;
  const result=(nextAction,reasonCode,nextCheckAt=null)=>({schemaVersion:1,workstreamId:id??null,
    nextAction,reasonCode,observationFingerprint:classified.observationFingerprint,
    responseFingerprint:hex(observation?.replyFingerprint)?observation.replyFingerprint:null,
    bindingFingerprint:hex(observation?.bindingFingerprint)?observation.bindingFingerprint:null,
    evidenceRefs:evidenceHash?[evidenceHash]:[],nextCheckAt,
    authorizationRequired:nextAction==="CALL_OPERATOR",
    actionFingerprint:hashAction([1,id,workstream?.task_revision,observation?.bindingFingerprint,
      observation?.replyFingerprint,nextAction,scope?.messageHash,evidenceHash])});
  const inspect=reason=>result("INSPECT_AGAIN",reason,now+policy.inspectIntervalMs);
  if (typeof id!=="string" || !Number.isSafeInteger(workstream.task_revision) || !time(now))
    return result("UNKNOWN","INVALID_WORKSTREAM_OR_CLOCK");
  if (globalStopped!==false) return result("NO_ACTION","GLOBAL_STOP");
  if (!workstream.enabled || workstream.paused) return result("NO_ACTION","WORKSTREAM_PAUSED");
  if (workstream.state==="COMPLETE") return result("NO_ACTION","WORKSTREAM_COMPLETE");
  if (workstream.state==="WAIT_HUMAN" || ["UNKNOWN","BLOCKED"].includes(workstream.state))
    return result("CALL_OPERATOR","WORKSTREAM_REQUIRES_REVIEW");
  if (operation || workstream.active_operation_id || ["RUNNING","WAIT_EXTERNAL"].includes(workstream.state))
    return result("UNKNOWN","UNRECONCILED_OPERATION");
  for (const key of ["inspectIntervalMs","externalIntervalMs","disconnectDebounceMs"])
    if (!Number.isSafeInteger(policy[key]) || policy[key]<=0 || policy[key]>86_400_000)
      return result("UNKNOWN","INVALID_AUTOPILOT_POLICY");
  if(PAGE_UNAVAILABLE_REASONS.includes(classified.reasonCode))
    return result("CALL_OPERATOR",classified.reasonCode);
  const problem=scopeProblem(workstream,scope,now);
  // A successfully exhausted bounded campaign is normal, not a request to
  // pause its independent read consent. All queue/claim budget guards remain.
  if(problem==="SCOPE_NOT_APPROVED"&&scope?.messageLimitReached===true&&
     scope.observationPermitted===true&&scope.taskRevision===workstream.task_revision&&
     hex(scope.bindingFingerprint)&&observation?.bindingFingerprint===scope.bindingFingerprint){
    if(classified.state==="WAIT_HUMAN")return result("CALL_OPERATOR",classified.reasonCode);
    return result("NO_ACTION","APPROVED_MESSAGE_LIMIT_REACHED");
  }
  if(problem)return result("CALL_OPERATOR",problem);
  if (!hex(scope.bindingFingerprint) || observation?.bindingFingerprint!==scope.bindingFingerprint)
    return result("UNKNOWN","OBSERVATION_BINDING_MISMATCH");
  if (classified.state==="WAIT_HUMAN") return result("CALL_OPERATOR",classified.reasonCode);
  if (classified.state==="UNKNOWN") return inspect(classified.reasonCode);
  if (classified.state==="DISCONNECTED") {
    if (scope.recoveryPermitted!==true) return result("CALL_OPERATOR","DISCONNECT_RECOVERY_NOT_APPROVED");
    if (!observation.stopControlVerified) return result("UNKNOWN","STOP_CONTROL_UNVERIFIED");
    const prior=classifyObservation(previous,{now,stableForMs:policy.stableForMs,maxAgeMs:policy.maxAgeMs});
    if (prior.state!=="DISCONNECTED" || previous.bindingFingerprint!==observation.bindingFingerprint ||
        !previous.stopControlVerified || observation.observedAt-previous.observedAt<policy.disconnectDebounceMs)
      return inspect("DISCONNECT_RECHECK_REQUIRED");
    return result("RECOVER_DISCONNECT","PERSISTENT_DISCONNECT_VERIFIED");
  }
  if (classified.state==="LENGTH_LIMIT") return scope.handoffPermitted===true ?
    result("BEGIN_HANDOFF","VERIFIED_LENGTH_WARNING") : result("CALL_OPERATOR","HANDOFF_NOT_APPROVED");
  const bound=[...(ci.watchtower?.targets||[]),...(ci.github?.targets||[])].some(t=>t.workstreamId===id);
  if(scope.ciResumeTargetHash&&scope.ciResumeTargetHash!==ciResumeTarget({workstream,...ci})?.targetHash)
    return result("CALL_OPERATOR","CI_RESUME_TARGET_CHANGED");
  if (bound || classified.state==="CI_WAIT_CUE") {
    const gate=decideGate({workstream,globalStopped,watchtower:ci.watchtower,github:ci.github,review:ci.review,now});
    evidenceHash=gate.evidenceHash;
    if (["UNKNOWN","WAIT_EXTERNAL"].includes(gate.decision)) {
      const timeout=ciWaitTimeout({workstream,observation,ci,now},gate.decision==="UNKNOWN");
      if(timeout)return result("CALL_OPERATOR",timeout);
      return gate.decision==="UNKNOWN"?result("CHECK_CI","CI_EVIDENCE_UNVERIFIED",now+policy.externalIntervalMs):
        result("WAIT_CI",gate.reason,now+policy.externalIntervalMs);
    }
    if (gate.decision==="BLOCKED") return result("CALL_OPERATOR",gate.reason);
    if (gate.decision!=="REVIEWED" && !(gate.decision==="WAIT_HUMAN" &&
        ((hex(scope.evidenceHash) && scope.evidenceHash===gate.evidenceHash)||
          (hex(scope.ciResumeTargetHash)&&scope.ciResumeTargetHash===ciResumeTarget({workstream,...ci})?.targetHash))))
      return result("CALL_OPERATOR","CI_REVIEW_REQUIRED");
  }
  if (observation.scopeCompleteCue) return result("CALL_OPERATOR","GOAL_COMPLETION_REVIEW_REQUIRED");
  if (scope.remainingWork!==true) return result("NO_ACTION","NO_APPROVED_REMAINING_WORK");
  if (observation.assistantBusy===true) return inspect("ASSISTANT_GENERATING");
  if (!classified.assistantStable) return inspect("RESPONSE_STABILIZING");
  if(responseConsumed)return result("NO_ACTION","RESPONSE_ALREADY_CONSUMED");
  if (!time(scope.nextEligibleDispatchAt)) return result("UNKNOWN","DISPATCH_CLOCK_UNVERIFIED");
  if (now<scope.nextEligibleDispatchAt) return result("INSPECT_AGAIN","DISPATCH_NOT_DUE",scope.nextEligibleDispatchAt);
  return result("CONTINUE","STABLE_RESPONSE_AND_APPROVED_SCOPE");
}
