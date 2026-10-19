import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WorkstreamStore } from "../local/store.js";
import { ChromeBridge, BRIDGE_TTL_MS } from "../local/chrome-bridge.js";
import { ChromeEnrollment } from "../local/chrome-enrollment.js";
import { discoverChatCandidates,enrollApprovedCandidate } from "../extension/remote-enrollment.js";
import { emptyRegistry,applyAction } from "../extension/core.js";

const extensionId="abcdefghijklmnopabcdefghijklmnop";
const origin="chrome-extension://"+extensionId;
const hashUrl=async url=>createHash("sha256").update(url).digest("hex");
const group={id:44,windowId:7,title:"codex_test",color:"blue"};
const url="https://chatgpt.com/";
const tab={id:19,groupId:44,windowId:7,title:"ChatGPT",url};
const snapshot={groups:[group],tabs:[tab]};
const candidate={
  tabId:19,groupId:44,windowId:7,groupLabel:"codex_test",
  title:"ChatGPT",route:"new",urlHash:createHash("sha256").update(url).digest("hex")
};
function setup(now=1000){
  const store=new WorkstreamStore();
  const bridge=new ChromeBridge(store);
  const enrollment=new ChromeEnrollment(store,{bridge});
  const code=bridge.beginPairing(now).code;
  const paired=bridge.pair(origin,code,now+1);
  assert.equal(paired.ok,true);
  store.create({id:"codex_test",name:"codex_test",projectKey:"codex_test",
    repository:"gycha0109-beep/Development-Autopilot"},now);
  bridge.sync(extensionId,{version:1,sessions:[]},now+2);
  enrollment.ingest(extensionId,{candidates:[candidate]},now+2);
  return {store,bridge,enrollment,close:()=>store.close()};
}

test("discovery publishes only unregistered grouped ChatGPT candidates without URLs",async()=>{
  const live={groups:[group],tabs:[
    tab,
    {id:20,groupId:44,windowId:7,title:"Settings",url:"https://chatgpt.com/settings"},
    {id:21,groupId:44,windowId:7,title:"Other",url:"https://other.test/c/a"},
    {id:22,groupId:-1,windowId:7,title:"ChatGPT 2",url:"https://chatgpt.com/"},
    {id:23,groupId:44,windowId:7,title:"Another chat",url:"https://chatgpt.com/c/abc"}
  ]};
  const results=await discoverChatCandidates(emptyRegistry(),live,"epoch",{hashUrl});
  assert.deepEqual(results.map(x=>x.tabId),[19,23]);
  assert.equal(results[0].route,"new");
  assert.equal(JSON.stringify(results).includes("https://chatgpt.com"),false);
  assert.equal(JSON.stringify(results).includes("/c/abc"),false);
  let registry=applyAction(emptyRegistry(),{type:"enrollGroup",groupId:44},
    live,"epoch",()=>"testgroup",1000);
  registry=applyAction(registry,{type:"enrollTab",groupKey:"testgroup",tabId:19},
    live,"epoch",()=>"testtab",1001);
  assert.deepEqual((await discoverChatCandidates(registry,live,"epoch",{hashUrl}))
    .map(x=>x.tabId),[23]);
});

test("approved candidate enrolls the exact tab once and never overwrites existing registration",async()=>{
  let registry=emptyRegistry(),live=snapshot;
  const params={load:async()=>registry,snapshot:async()=>live,
    epoch:async()=>"epoch",save:async r=>{registry=r},hashUrl,now:()=>2000};
  const intent={id:"12345678-1234-4234-8234-123456789abc",
    tabId:19,groupId:44,windowId:7,urlHash:candidate.urlHash,route:"new"};
  let result=await enrollApprovedCandidate(intent,params);
  assert.equal(result.sessionKey,intent.id);
  assert.equal(registry.groups.length,1);
  assert.equal(registry.sessions.length,1);
  assert.equal(registry.sessions[0].tabId,19);
  result=await enrollApprovedCandidate(intent,params);
  assert.equal(result.alreadyApplied,true);
  assert.equal(registry.sessions.length,1);
  assert.equal(registry.groups.length,1);
  await assert.rejects(enrollApprovedCandidate({...intent,
    id:"12345678-1234-4234-8234-123456789abd"},params),
    /ENROLLMENT_TAB_ALREADY_REGISTERED/);
});

test("stale URL, changed route, moved group and ambiguous old registration are rejected",async()=>{
  let registry=emptyRegistry(),live=snapshot;
  const params={load:async()=>registry,snapshot:async()=>live,
    epoch:async()=>"epoch",save:async r=>{registry=r},hashUrl,now:()=>2000};
  const intent={id:"12345678-1234-4234-8234-123456789abc",
    tabId:19,groupId:44,windowId:7,urlHash:candidate.urlHash,route:"new"};
  live={groups:[group],tabs:[{...tab,url:"https://chatgpt.com/?model=other"}]};
  await assert.rejects(enrollApprovedCandidate(intent,params),/ENROLLMENT_CONVERSATION_CHANGED/);
  live={groups:[group],tabs:[{...tab,groupId:45}]};
  await assert.rejects(enrollApprovedCandidate(intent,params),/ENROLLMENT_TARGET_CHANGED/);
  live=snapshot;
  registry=applyAction(registry,{type:"enrollGroup",groupId:44},
    live,"old-epoch",()=>"stale-group",1000);
  await assert.rejects(enrollApprovedCandidate(intent,params),/ENROLLMENT_EXISTING_GROUP_REQUIRES_REBIND/);
  assert.equal(registry.sessions.length,0);
});

test("local intent refuses stale candidate, false ACK and previous links; exact confirmed registration binds",()=>{
  const f=setup();
  try{
    assert.throws(()=>f.enrollment.begin("codex_test",extensionId,19,
      "f".repeat(64),1004),/CHROME_ENROLLMENT_STALE_OR_CHANGED_TAB/);
    const intent=f.enrollment.begin("codex_test",extensionId,19,candidate.urlHash,1004);
    assert.equal(f.enrollment.pending(extensionId,1005).length,1);
    assert.throws(()=>f.enrollment.begin("codex_test",extensionId,19,candidate.urlHash,1005),
      /CHROME_ENROLLMENT_ALREADY_PENDING/);
    assert.throws(()=>f.enrollment.acknowledge(extensionId,{
      id:intent.id,status:"applied",sessionKey:intent.id},1006),
      /CHROME_ENROLLMENT_REGISTERED_SESSION_NOT_CONFIRMED/);
    f.bridge.sync(extensionId,{version:1,sessions:[{
      sessionKey:intent.id,groupKey:intent.id+"-group",groupLabel:"codex_test",
      title:"ChatGPT",origin:"https://chatgpt.com",status:"connected"
    }]},1007);
    assert.throws(()=>f.enrollment.acknowledge(extensionId,{
      id:intent.id,status:"applied",sessionKey:"different"},1008),
      /CHROME_ENROLLMENT_SESSION_PROOF_MISMATCH/);
    const ack=f.enrollment.acknowledge(extensionId,{
      id:intent.id,status:"applied",sessionKey:intent.id},1009);
    assert.equal(ack.status,"done");
    const linked=f.bridge.getSnapshot(1010).links;
    assert.equal(linked.length,1);
    assert.equal(linked[0].sessionKey,intent.id);
    assert.equal(f.enrollment.acknowledge(extensionId,{
      id:intent.id,status:"applied",sessionKey:intent.id},1010).alreadyConfirmed,true);
    assert.equal(f.enrollment.pending(extensionId,1011).length,0);
    assert.throws(()=>f.enrollment.begin("codex_test",extensionId,19,candidate.urlHash,1011),
      /CHROME_ENROLLMENT_WORKSTREAM_ALREADY_LINKED/);
  }finally{f.close()}
});

test("server only exposes recent candidates, rejects duplicate/spoofed discovery, and expires intents",()=>{
  const f=setup();
  try{
    assert.throws(()=>f.enrollment.ingest(extensionId,{candidates:[
      candidate,candidate]},1005),/CHROME_DISCOVERY_INVALID/);
    assert.throws(()=>f.enrollment.ingest(extensionId,{candidates:[{
      ...candidate,groupId:-1}]},1005),/CHROME_DISCOVERY_INVALID/);
    assert.equal(f.enrollment.getSnapshot(1006).candidates.length,1);
    assert.equal(f.enrollment.getSnapshot(1002+BRIDGE_TTL_MS+1).candidates.length,0);
    const intent=f.enrollment.begin("codex_test",extensionId,19,candidate.urlHash,1005);
    assert.equal(f.enrollment.pending(extensionId,1005+300001).length,0);
    assert.equal(f.enrollment.getSnapshot(1005+300001).registrations[0].status,"expired");
    assert.throws(()=>f.enrollment.acknowledge(extensionId,{
      id:intent.id,status:"applied",sessionKey:intent.id},1005+300001),
      /CHROME_ENROLLMENT_INTENT_EXPIRED_OR_CLOSED/);
  }finally{f.close()}
});

test("unpair deletes discovered candidates and registration intents safely",()=>{
  const f=setup();
  try{
    f.enrollment.begin("codex_test",extensionId,19,candidate.urlHash,1005);
    f.bridge.unpair(extensionId,1006);
    assert.deepEqual(f.enrollment.getSnapshot(1007).candidates,[]);
    assert.deepEqual(f.enrollment.getSnapshot(1007).registrations,[]);
  }finally{f.close()}
});
