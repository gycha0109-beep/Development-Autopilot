import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_COMPOSER_BUILD } from "../extension/chat-page.js";
import { ChromeBridge, REQUIRED_COMPOSER_BUILD } from "../local/chrome-bridge.js";
import { ChatContinuation } from "../local/chat-continuation.js";
import { WorkstreamStore } from "../local/store.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const sessionKey = "existing-registered-tab";

function fixture() {
  const store = new WorkstreamStore();
  let now = 1_000_000;
  const bridge = new ChromeBridge(store);
  store.create({id:"work",name:"Test",projectKey:"test",repository:"owner/test"},now);
  const code = bridge.beginPairing(now).code;
  assert.equal(bridge.pair("chrome-extension://" + extensionId,code,now).ok,true);
  const sync = composerBuild => bridge.sync(extensionId,{
    version:1,composerBuild,sessions:[{
      sessionKey,groupKey:"existing-group",groupLabel:"Test",title:"Test 1",
      origin:"https://chatgpt.com",status:"connected"
    }]
  },now);
  sync(CHAT_COMPOSER_BUILD);
  bridge.link("work",extensionId,sessionKey,now);
  const targets = {list:()=>[]};
  const dependencies = {bridge,watchtower:{targets},github:{targets},gate:{one:()=>null},now:()=>now};
  const chat = new ChatContinuation(store,dependencies);
  const approve = () => chat.configure("work",{
    enabled:true,mode:"manual",message:"계속 진행",intervalMinutes:10,hours:1,maxMessages:1
  });
  return {store,bridge,chat,dependencies,sync,approve,advance:ms=>{now+=ms;}};
}

test("bridge compatibility contract matches the shipped extension composer",()=>{
  assert.equal(REQUIRED_COMPOSER_BUILD,CHAT_COMPOSER_BUILD);
});

test("real bridge accepts the shipped composer and permits exactly one approved claim",()=>{
  const f = fixture();
  try {
    assert.equal(f.bridge.getSnapshot(1_000_000).clients[0].composerBuild,CHAT_COMPOSER_BUILD);
    assert.equal(f.chat.linkedSession("work",1_000_000).sessionKey,sessionKey);
    assert.equal(f.chat.commands().length,0); // heartbeat is not a send command
    f.approve();
    const queued = f.chat.queue("work",{manual:true});
    assert.equal(f.chat.claim(extensionId).id,queued.id);
    assert.equal(f.chat.claim(extensionId),null);
    assert.equal(f.chat.commands().length,1);
  } finally { f.store.close(); }
});

test("missing, previous and unknown composer versions block approval and pending claims",()=>{
  for (const build of [undefined,"composer-2026-10-14-r14","composer-2026-10-15-r15","unsupported-worker"]) {
    const f = fixture();
    try {
      f.approve();
      const queued = f.chat.queue("work",{manual:true});
      f.sync(build);
      assert.equal(f.bridge.getSnapshot(1_000_000).clients[0].composerBuild,null);
      assert.equal(f.chat.linkedSession("work",1_000_000),null);
      assert.throws(f.approve,/CHAT_SESSION_NOT_CONNECTED/);
      assert.equal(f.chat.claim(extensionId),null);
      assert.equal(f.chat.commands()[0].id,queued.id);
      assert.equal(f.chat.commands()[0].state,"blocked");
      assert.equal(f.chat.config("work").enabled,false);
      f.sync(CHAT_COMPOSER_BUILD);
      assert.equal(f.chat.claim(extensionId),null);
      assert.deepEqual(f.chat.tick(),[]);
    } finally { f.store.close(); }
  }
});

test("current-build sync and executor restart cannot replay an uncertain send",()=>{
  const f = fixture();
  try {
    f.approve();
    const queued = f.chat.queue("work",{manual:true});
    f.chat.claim(extensionId);
    f.advance(120_001);
    assert.equal(f.chat.reconcile(),1);
    f.sync(CHAT_COMPOSER_BUILD);
    const restarted = new ChatContinuation(f.store,f.dependencies);
    assert.equal(restarted.commands()[0].id,queued.id);
    assert.equal(restarted.commands()[0].state,"unknown");
    assert.equal(restarted.config("work").enabled,false);
    assert.equal(restarted.claim(extensionId),null);
    assert.deepEqual(restarted.tick(),[]);
    assert.equal(f.bridge.getSnapshot(1_120_001).links[0].sessionKey,sessionKey);
  } finally { f.store.close(); }
});
