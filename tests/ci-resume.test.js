import test from "node:test";
import assert from "node:assert/strict";
import { ciResumeCandidates,ciFollowupStatus } from "../local/ci-resume.js";

const sha="a".repeat(40);
const id="stream-1";
const now=Date.now();
const workstream={id,repository:"example/repo",track_key:"core"};
const target={workstreamId:id,repositoryId:9,runId:71,attempt:2,headSha:sha};
const ghTarget={workstreamId:id,prNumber:18,headSha:sha};
const review={workstreamId:id,decision:"REVIEWED",operatorReviewed:true,
  evidenceHash:"b".repeat(64),expiresAt:now+60000,reason:"OPERATOR_REVIEW_RECORDED_NO_EXECUTION"};
const wtResult={workstreamId:id,decision:"VERIFY_GITHUB",ciState:"SUCCESS"};
const ghResult={workstreamId:id,state:"MERGED_CONFIRMED",merged:true,requiredChecksVerified:true};
function fixture(){
  const wt={status:"connected",targets:[{...target}],results:[{...wtResult}]};
  const gh={status:"observed",targets:[{...ghTarget}],results:[{...ghResult}]};
  const decision={...review};
  return {store:{list:()=>[workstream]},watchtower:{current:()=>wt},
    github:{current:()=>gh},gate:{one:()=>decision},now,wt,gh,decision};
}
test("exact reviewed CI+PR evidence produces a stable single candidate",()=>{
  const f=fixture(),c=ciResumeCandidates(f);
  assert.equal(c.length,1);
  assert.match(c[0].targetHash,/^[a-f0-9]{64}$/);
  assert.equal(c[0].runId,71);
  assert.equal(c[0].prNumber,18);
  assert.equal(ciResumeCandidates(f)[0].targetHash,c[0].targetHash);
});
test("changed head, failed CI, pending PR, or missing integration fail closed",()=>{
  for(const mutate of [
    f=>{f.gh.targets[0].headSha="c".repeat(40)},
    f=>{f.wt.results[0].decision="BLOCKED"},
    f=>{f.gh.results[0].state="CHECKS_PASSED_NOT_MERGED"},
    f=>{f.wt.status="unavailable"},
    f=>{f.gh.status="unavailable"},
    f=>{f.gh.targets.push({...ghTarget})}
  ]){
    const f=fixture();mutate(f);
    assert.deepEqual(ciResumeCandidates(f),[]);
  }
});
test("review expiry disables new approval but same-evidence existing campaign can revalidate",()=>{
  const f=fixture();
  f.decision.decision="WAIT_HUMAN";
  f.decision.operatorReviewed=false;
  f.decision.expiresAt=null;
  assert.deepEqual(ciResumeCandidates(f),[]);
  assert.equal(ciResumeCandidates({...f,requireReviewed:false}).length,1);
  f.gh.results[0].merged=false;
  assert.deepEqual(ciResumeCandidates({...f,requireReviewed:false}),[]);
});
test("changing CI identity invalidates previously approved target hash",()=>{
  const f=fixture();
  const original=ciResumeCandidates(f)[0].targetHash;
  f.wt.targets[0].runId=72;
  assert.notEqual(ciResumeCandidates(f)[0].targetHash,original);
});
test("followup routing never treats failure or unknown as automatic resume",()=>{
  const f=fixture();
  assert.equal(ciFollowupStatus({...f,workstreamId:id}).action,"APPROVED_RESUME");
  f.decision.decision="WAIT_HUMAN";
  assert.equal(ciFollowupStatus({...f,workstreamId:id}).action,"REQUIRE_APPROVAL");
  f.decision.decision="WAIT_EXTERNAL";
  assert.equal(ciFollowupStatus({...f,workstreamId:id}).action,"WAIT_CI_OR_MERGE");
  f.decision.decision="BLOCKED";
  f.wt.results[0].decision="BLOCKED";
  assert.equal(ciFollowupStatus({...f,workstreamId:id}).action,"REVIEW_FAILURE");
  f.wt.status="unavailable";
  assert.equal(ciFollowupStatus({...f,workstreamId:id}).action,"STOP_UNVERIFIED");
});

import { WorkstreamStore } from "../local/store.js";
import { ChatContinuation } from "../local/chat-continuation.js";
test("CI-bound scheduled consent is rejected without exact approval and pauses after evidence drift",()=>{
  const store=new WorkstreamStore();
  const stream=store.create({id:"bound",name:"Bound",projectKey:"bound",repository:"example/repo",intervalMinutes:1});
  const ext="a".repeat(32),session="chat-1",fingerprint="f".repeat(64);
  const bridge={getSnapshot:()=>({clients:[{extensionId:ext,status:"online",composerBuild:"composer-2026-10-15-r17"}],
    links:[{workstreamId:stream.id,extensionId:ext,sessionKey:session,status:"connected"}],
    sessions:[{extensionId:ext,sessionKey:session,status:"connected",origin:"https://chatgpt.com"}]})};
  const watchtower={targets:{list:()=>[]}},github={targets:{list:()=>[]}},gate={one:()=>({decision:"UNKNOWN"})};
  let allowed=true,now=1_000_000;
  const chat=new ChatContinuation(store,{bridge,watchtower,github,gate,
    ciCandidates:()=>allowed?[{workstreamId:stream.id,targetHash:fingerprint}]:[],now:()=>now});
  const options={enabled:true,mode:"scheduled",message:"Continue after verified CI",intervalMinutes:1,
    ciResumeTargetHash:fingerprint};
  try{
    assert.throws(()=>chat.configure(stream.id,{...options,ciResumeTargetHash:"e".repeat(64)}),/CI_RESUME_EVIDENCE_NOT_REVIEWED/);
    const cfg=chat.configure(stream.id,options);
    assert.equal(cfg.ciResumeTargetHash,fingerprint);
    allowed=false;
    now+=120_000;
    assert.deepEqual(chat.tick(),[]);
    assert.equal(chat.config(stream.id).statusReason,"CI_EVIDENCE_CHANGED_OR_STALE");
    assert.equal(chat.commands().length,0);
  }finally{store.close()}
});
