import {createHash} from "node:crypto";
import {decideGate} from "../local/decision-gate.js";
export const NOW=1_000_000;
export const BINDING="b".repeat(64), REPLY="c".repeat(64), SHA="a".repeat(40);
export const workstream=patch=>({id:"work",name:"Test",project_key:"project",repository:"owner/repo",
  track_key:"track",state:"OBSERVING",enabled:true,paused:false,task_revision:1,active_operation_id:null,...patch});
export const observation=(patch={})=>({schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",
  verified:true,reasonCode:"UI_OBSERVED",observedAt:NOW,bindingFingerprint:BINDING,replyFingerprint:REPLY,
  assistantBusy:false,composerHasDraft:false,stopControlVerified:false,connectionWarning:false,
  lengthWarning:false,providerRestriction:false,otherWarning:false,uiAmbiguous:false,contentComplete:true,
  ciWaitCue:false,humanActionCue:false,scopeCompleteCue:false,...patch});
export const policy={stableForMs:500,maxAgeMs:10_000,inspectIntervalMs:1000,externalIntervalMs:5000,disconnectDebounceMs:1000};
export const scope=patch=>({approved:true,taskRevision:1,expiresAt:NOW+3_600_000,
  bindingFingerprint:BINDING,messageHash:createHash("sha256").update("계속 진행").digest("hex"),
  observationPermitted:true,executionPermitted:true,remainingWork:true,nextEligibleDispatchAt:NOW,
  recoveryPermitted:false,handoffPermitted:false,...patch});
export function ciEvidence(){
  const watchtower={status:"connected",contractVersion:"1.0",checkedAt:NOW-50,errorCode:null,
    targets:[{workstreamId:"work",repositoryId:8,runId:1001,attempt:2,headSha:SHA,configuredAt:NOW-5000}],
    results:[{workstreamId:"work",repositoryId:8,repository:"owner/repo",workTrackKey:"track",responsibilityKind:"track-owned",
      runId:1001,attempt:2,headSha:SHA,ciState:"SUCCESS",evidenceState:"FRESH",decision:"VERIFY_GITHUB",
      reason:"CI_SUCCESS_REQUIRES_PR_CHECKS_AND_APPROVALS",safeToAdvance:false}]};
  const github={status:"observed",checkedAt:NOW-50,errorCode:null,
    targets:[{workstreamId:"work",prNumber:21,headSha:SHA,configuredAt:NOW-5000}],
    results:[{workstreamId:"work",repository:"owner/repo",prNumber:21,headSha:SHA,checks:[{name:"CI",state:"SUCCESS"}],
      state:"MERGED_CONFIRMED",merged:true,requiredChecksVerified:true,reason:"REQUIRED_CHECKS_PASSED",safeToAdvance:false}]};
  const gate=decideGate({workstream:workstream(),globalStopped:false,watchtower,github,now:NOW});
  const review={workstreamId:"work",taskRevision:1,evidenceHash:gate.evidenceHash,reviewedAt:NOW-10,expiresAt:NOW+900_000};
  return {watchtower,github,review};
}
export const inputs=(patch={})=>({workstream:workstream(),observation:observation(),previous:observation({observedAt:NOW-1000}),
  globalStopped:false,scope:scope(),policy:{...policy},now:NOW,...patch});
