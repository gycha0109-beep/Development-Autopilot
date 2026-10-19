import test from "node:test";
import assert from "node:assert/strict";
import {decideNextAction,ACTIONS} from "../local/autopilot-decision.js";
import {classifyObservation} from "../local/chat-observation.js";
import {inputs,workstream,observation,scope,ciEvidence,policy,NOW} from "../test-support/autopilot-fixture.js";

test("exhausted send permission grants no action while human/provider and binding gates remain closed",()=>{
  const exhausted=scope({approved:false,messageLimitReached:true});
  const normal=decideNextAction(inputs({scope:exhausted}));
  assert.equal(normal.nextAction,"NO_ACTION");assert.equal(normal.reasonCode,"APPROVED_MESSAGE_LIMIT_REACHED");
  for(const patch of [{humanActionCue:true},{providerRestriction:true}])
    assert.equal(decideNextAction(inputs({scope:exhausted,observation:observation(patch)})).nextAction,"CALL_OPERATOR");
  for(const patch of [{bindingFingerprint:"f".repeat(64)},{taskRevision:2},{observationPermitted:false}])
    assert.equal(decideNextAction(inputs({scope:{...exhausted,...patch}})).nextAction,"CALL_OPERATOR");
});

for(const [name,patch,action,reason] of [
  ["normal approved response",{},"CONTINUE","STABLE_RESPONSE_AND_APPROVED_SCOPE"],
  ["consumed response does not use dispatch budget",{responseConsumed:true},"NO_ACTION","RESPONSE_ALREADY_CONSUMED"],
  ["global STOP",{globalStopped:true},"NO_ACTION","GLOBAL_STOP"],
  ["paused axis",{workstream:workstream({paused:true})},"NO_ACTION","WORKSTREAM_PAUSED"],
  ["complete axis",{workstream:workstream({state:"COMPLETE"})},"NO_ACTION","WORKSTREAM_COMPLETE"],
  ["pending human",{workstream:workstream({state:"WAIT_HUMAN"})},"CALL_OPERATOR","WORKSTREAM_REQUIRES_REVIEW"],
  ["unknown operation",{operation:{status:"unknown"}},"UNKNOWN","UNRECONCILED_OPERATION"],
  ["active operation",{workstream:workstream({active_operation_id:"operation"})},"UNKNOWN","UNRECONCILED_OPERATION"],
  ["expired scope",{scope:scope({expiresAt:NOW})},"CALL_OPERATOR","SCOPE_NOT_APPROVED"],
  ["different revision",{scope:scope({taskRevision:2})},"CALL_OPERATOR","SCOPE_NOT_APPROVED"],
  ["provider permission absent",{scope:scope({executionPermitted:false})},"CALL_OPERATOR","PROVIDER_CAPABILITY_NOT_APPROVED"],
  ["different binding",{scope:scope({bindingFingerprint:"d".repeat(64)})},"UNKNOWN","OBSERVATION_BINDING_MISMATCH"],
  ["user typing",{observation:observation({composerHasDraft:true})},"INSPECT_AGAIN","USER_DRAFT_PRESENT"],
  ["streaming",{observation:observation({assistantBusy:true})},"INSPECT_AGAIN","ASSISTANT_GENERATING"],
  ["stale snapshot",{observation:observation({observedAt:NOW-20_000})},"INSPECT_AGAIN","OBSERVATION_STALE"],
  ["no stable baseline",{previous:null},"INSPECT_AGAIN","RESPONSE_STABILIZING"],
  ["not yet dispatch due",{scope:scope({nextEligibleDispatchAt:NOW+1000})},"INSPECT_AGAIN","DISPATCH_NOT_DUE"],
  ["quota warning",{observation:observation({providerRestriction:true})},"CALL_OPERATOR","PROVIDER_RESTRICTION"],
  ["cost/approval cue",{observation:observation({humanActionCue:true})},"CALL_OPERATOR","HUMAN_ACTION_CUE"],
  ["unsupported disconnect",{observation:observation({connectionWarning:true,assistantBusy:true,stopControlVerified:true})},"CALL_OPERATOR","DISCONNECT_RECOVERY_NOT_APPROVED"],
  ["length warning",{observation:observation({lengthWarning:true}),scope:scope({handoffPermitted:true})},"BEGIN_HANDOFF","VERIFIED_LENGTH_WARNING"],
  ["goal claim is not goal verification",{observation:observation({scopeCompleteCue:true})},"CALL_OPERATOR","GOAL_COMPLETION_REVIEW_REQUIRED"],
  ["no remaining scope",{scope:scope({remainingWork:false})},"NO_ACTION","NO_APPROVED_REMAINING_WORK"],
  ["CI cue without binding",{observation:observation({ciWaitCue:true})},"CHECK_CI","CI_EVIDENCE_UNVERIFIED"]
])test(name,()=>{
  const result=decideNextAction(inputs(patch));
  assert.equal(result.nextAction,action); assert.equal(result.reasonCode,reason);
  assert.ok(ACTIONS.includes(result.nextAction)); assert.match(result.actionFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result,"actions"),false);
});

test("CI queued/running/unmerged never continues; exact successful reviewed evidence can release a persistent CI cue",()=>{
  const ci=ciEvidence();
  const args=inputs({ci,observation:observation({ciWaitCue:true}),previous:observation({ciWaitCue:true,observedAt:NOW-1000})});
  const classified=classifyObservation(args.observation,{...policy,now:NOW,previous:args.previous});
  assert.equal(classified.state,"CI_WAIT_CUE"); assert.equal(classified.assistantStable,true);
  assert.equal(decideNextAction(args).nextAction,"CONTINUE");
  ci.watchtower.results[0].decision="WAIT_EXTERNAL";ci.watchtower.results[0].ciState="RUNNING";
  assert.equal(decideNextAction(args).nextAction,"WAIT_CI");
  ci.watchtower.results[0].decision="VERIFY_GITHUB";ci.watchtower.results[0].ciState="SUCCESS";
  ci.github.results[0].state="CHECKS_PASSED_NOT_MERGED";ci.github.results[0].merged=false;
  assert.equal(decideNextAction(args).reasonCode,"PR_NOT_MERGED");
});

test("other Track/SHA/run/attempt, stale or missing evidence cannot release CI",()=>{
  const mutations=[ci=>{ci.watchtower.results[0].workTrackKey="another";},ci=>{ci.watchtower.results[0].attempt=1;},
    ci=>{ci.github.results[0].prNumber=22;},ci=>{ci.watchtower.results[0].runId=1002;},
    ci=>{ci.github.targets[0].headSha="d".repeat(40);},ci=>{ci.watchtower.checkedAt=NOW-200_000;},
    ci=>{ci.watchtower.results=[];},ci=>{ci.watchtower.status="unavailable";}];
  for(const mutate of mutations){const ci=ciEvidence(); mutate(ci);
    assert.equal(decideNextAction(inputs({ci})).nextAction,"CHECK_CI");}
});

test("campaign review is bound to the same exact gate evidence and never authorizes a changed target",()=>{
  const ci=ciEvidence(),evidenceHash=ci.review.evidenceHash;ci.review=null;
  assert.equal(decideNextAction(inputs({ci})).nextAction,"CALL_OPERATOR");
  assert.equal(decideNextAction(inputs({ci,scope:scope({evidenceHash})})).nextAction,"CONTINUE");
  ci.github.results[0].checks.push({name:"another",state:"SUCCESS"});
  assert.equal(decideNextAction(inputs({ci,scope:scope({evidenceHash})})).nextAction,"CALL_OPERATOR");
});

test("disconnect needs repeat observations, exact enrollment and unambiguous stop evidence",()=>{
  const current=observation({connectionWarning:true,assistantBusy:true,stopControlVerified:true});
  const args=inputs({observation:current,scope:scope({recoveryPermitted:true}),previous:{...current,observedAt:NOW-1000}});
  assert.equal(decideNextAction(args).nextAction,"RECOVER_DISCONNECT");
  assert.equal(decideNextAction({...args,previous:null}).reasonCode,"DISCONNECT_RECHECK_REQUIRED");
  assert.equal(decideNextAction({...args,observation:{...current,stopControlVerified:false}}).reasonCode,"STOP_CONTROL_UNVERIFIED");
  assert.equal(decideNextAction({...args,observation:{...current,providerRestriction:true}}).nextAction,"CALL_OPERATOR");
});

test("stable action identity ignores polling time but changes on target and action",()=>{
  const first=decideNextAction(inputs());
  const second=decideNextAction(inputs({now:NOW+1000,observation:observation({observedAt:NOW+1000})}));
  assert.equal(first.actionFingerprint,second.actionFingerprint);
  assert.notEqual(first.observationFingerprint,second.observationFingerprint);
  assert.notEqual(first.actionFingerprint,decideNextAction(inputs({scope:scope({messageHash:"d".repeat(64)})})).actionFingerprint);
});
