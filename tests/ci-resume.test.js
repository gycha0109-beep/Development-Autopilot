import test from "node:test";
import assert from "node:assert/strict";
import {ciResumeCandidate,ciResumeTarget} from "../local/ci-resume.js";
import {decideNextAction} from "../local/autopilot-decision.js";
import {inputs,ciEvidence,scope,observation} from "../test-support/autopilot-fixture.js";

test("conditional CI approval requires an exact active Track and independent live Run association",()=>{
  const args=inputs({ci:ciEvidence()});const {watchtower,github}=args.ci;
  const input={...args,watchtower,github};
  assert.ok(ciResumeCandidate(input));
  for(const mutate of [a=>{a.workstream.track_key=null;},a=>{a.github.results[0].runVerified=false;},
    a=>{a.github.results[0].attempt=1;},a=>{a.watchtower.status="unavailable";},
    a=>{a.github.checkedAt=0;},a=>{a.watchtower.results[0].workTrackKey="other";}]){
    const changed=structuredClone(input);mutate(changed);assert.equal(ciResumeCandidate(changed),null);
  }
});

test("a bounded conditional scope releases only fully verified merged success without recording phase review",()=>{
  const ci=ciEvidence();ci.review=null;
  const args=inputs({ci,observation:observation({ciWaitCue:true}),previous:observation({ciWaitCue:true,observedAt:999000})});
  args.scope=scope({ciResumeTargetHash:ciResumeTarget({workstream:args.workstream,...ci}).targetHash});
  assert.equal(decideNextAction(args).nextAction,"CONTINUE");
  for(const mutate of [a=>{a.ci.github.results[0].merged=false;a.ci.github.results[0].state="CHECKS_PASSED_NOT_MERGED";},
    a=>{a.ci.github.results[0].requiredChecksVerified=false;},a=>{a.ci.github.results[0].state="FAILURE";},
    a=>{a.scope.expiresAt=a.now;},a=>{a.observation.composerHasDraft=true;},a=>{a.observation.assistantBusy=true;}]){
    const changed=structuredClone(args);mutate(changed);assert.notEqual(decideNextAction(changed).nextAction,"CONTINUE");
  }
  for(const mutate of [a=>{a.ci.watchtower.targets=[];a.ci.github.targets=[];},
    a=>{a.ci.github.targets[0].prNumber++;},a=>{a.ci.watchtower.targets[0].attempt++;},
    a=>{a.ci.watchtower.targets[0].configuredAt++;},a=>{a.workstream.track_key="other";}]){
    const changed=structuredClone(args);mutate(changed);
    assert.equal(decideNextAction(changed).reasonCode,"CI_RESUME_TARGET_CHANGED");
  }
  assert.equal(ci.review,null);
});
