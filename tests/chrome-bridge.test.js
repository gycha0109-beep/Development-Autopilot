import test from "node:test";
import assert from "node:assert/strict";
import { WorkstreamStore } from "../local/store.js";
import { ChromeBridge, BRIDGE_TTL_MS, PAIR_TTL_MS } from "../local/chrome-bridge.js";
import { bridgePayload } from "../extension/bridge-core.js";
import { applyAction, emptyRegistry } from "../extension/core.js";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const extOrigin = "chrome-extension://" + extensionId;
function fixture() {
  const store = new WorkstreamStore();
  const bridge = new ChromeBridge(store);
  return { store, bridge, close() { store.close(); } };
}
function paired(bridge, at = 1000) {
  const code = bridge.beginPairing(at);
  const result = bridge.pair(extOrigin, code.code, at + 1);
  assert.equal(result.ok, true);
  return result.token;
}
const session = key => ({
  sessionKey: key, groupKey: "group-1", groupLabel: "Builders",
  title: "Test session", origin: "https://chatgpt.com", status: "connected"
});
test("one-time pairing works only for a Chrome extension origin and cannot be reused", () => {
  const f = fixture();
  try {
    const code = f.bridge.beginPairing(100);
    assert.throws(() => f.bridge.pair("https://example.com", code.code, 120), /Chrome/);
    assert.deepEqual(f.bridge.pair(extOrigin, "F".repeat(20), 150), {ok:false});
    const token = f.bridge.pair(extOrigin, code.code, 160);
    assert.equal(token.ok, true);
    assert.equal(f.bridge.authenticate(extOrigin, token.token), extensionId);
    assert.equal(f.bridge.authenticate(extOrigin, "wrong"), null);
    assert.throws(() => f.bridge.pair(extOrigin, code.code, 161), /만료/);
  } finally { f.close(); }
});
test("expired pairing code cannot be used and wrong guesses are capped", () => {
  const f = fixture();
  try {
    const code = f.bridge.beginPairing(100);
    assert.throws(() => f.bridge.pair(extOrigin, code.code, 100 + PAIR_TTL_MS + 1), /만료/);
    f.bridge.beginPairing(200_000);
    for (let n = 0; n < 5; n++) {
      assert.equal(f.bridge.pair(extOrigin, "A".repeat(20), 200_010 + n).ok, false);
    }
    assert.throws(() => f.bridge.pair(extOrigin, code.code, 200_020), /만료/);
  } finally { f.close(); }
});
test("sync persists only enrolled sessions and reports stale heartbeat fail-closed", () => {
  const f = fixture();
  try {
    const token = paired(f.bridge);
    f.bridge.sync(extensionId, { version: 1, sessions: [session("tab-1")] }, 2000);
    assert.equal(f.bridge.authenticate(extOrigin, token), extensionId);
    const alive = f.bridge.getSnapshot(2001);
    assert.equal(alive.clients[0].status, "online");
    assert.equal(alive.sessions[0].status, "connected");
    const stale = f.bridge.getSnapshot(2000 + BRIDGE_TTL_MS + 1);
    assert.equal(stale.sessions[0].status, "stale");
    assert.equal(stale.clients[0].status, "offline");
  } finally { f.close(); }
});
test("links require a current registered session and never auto-switch to another tab", () => {
  const f = fixture();
  try {
    paired(f.bridge);
    f.store.create({id:"build",name:"Build",projectKey:"build",repository:"owner/repo"},1000);
    f.store.create({id:"beauty",name:"Beauty",projectKey:"beauty",repository:"owner/beauty"},1000);
    f.bridge.sync(extensionId, {version:1,sessions:[session("tab-1"),session("tab-2")]},2000);
    f.bridge.link("build",extensionId,"tab-1",2001);
    assert.throws(() => f.bridge.link("beauty",extensionId,"tab-1",2002), /UNIQUE|constraint/i);
    f.bridge.sync(extensionId,{version:1,sessions:[session("tab-2")]},3000);
    const link = f.bridge.getSnapshot(3001).links[0];
    assert.equal(link.sessionKey,"tab-1");
    assert.equal(link.status,"missing");
    assert.throws(() => f.bridge.link("beauty",extensionId,"tab-1",3002), /연결되지/);
    f.bridge.link("beauty",extensionId,"tab-2",3003);
    assert.equal(f.bridge.getSnapshot(3004).links.length,2);
  } finally { f.close(); }
});
test("re-pair invalidates previous credential and clears links explicitly", () => {
  const f = fixture();
  try {
    const token1 = paired(f.bridge);
    f.store.create({id:"project",name:"Project",projectKey:"project",repository:"owner/repo"},1000);
    f.bridge.sync(extensionId, {version:1,sessions:[session("tab-1")]},2000);
    f.bridge.link("project",extensionId,"tab-1",2001);
    const code = f.bridge.beginPairing(3000);
    const token2 = f.bridge.pair(extOrigin,code.code,3001).token;
    assert.equal(f.bridge.authenticate(extOrigin,token1),null);
    assert.equal(f.bridge.authenticate(extOrigin,token2),extensionId);
    assert.equal(f.bridge.getSnapshot(3002).links.length,0);
  } finally { f.close(); }
});
test("unpair revokes token and deletes associated inventory", () => {
  const f = fixture();
  try {
    const token=paired(f.bridge);
    f.bridge.sync(extensionId,{version:1,sessions:[session("tab-1")]},2000);
    f.bridge.unpair(extensionId,3000);
    assert.equal(f.bridge.authenticate(extOrigin,token),null);
    assert.equal(f.bridge.getSnapshot(3000).sessions.length,0);
  } finally { f.close(); }
});
test("invalid or duplicate sessions are rejected atomically", () => {
  const f=fixture();
  try {
    paired(f.bridge);
    f.bridge.sync(extensionId,{version:1,sessions:[session("original")]},2000);
    assert.throws(()=>f.bridge.sync(extensionId,{version:1,sessions:[session("new"),session("new")]},3000),/등록/);
    assert.equal(f.bridge.getSnapshot(3000).sessions.length,1);
    assert.throws(()=>f.bridge.sync(extensionId,{version:1,sessions:[{...session("new"),origin:"file:///secret"}]},3000),/Origin/);
  } finally { f.close(); }
});
test("authenticated Chrome bridge records exact active composer build, never trusts missing or stale versions",()=>{
  const f=fixture();
  try {
    paired(f.bridge);
    f.bridge.sync(extensionId,{version:1,sessions:[session("tab-1")]},2_000);
    assert.equal(f.bridge.getSnapshot(2_001).clients[0].composerBuild,null);
    f.bridge.sync(extensionId,{version:1,composerBuild:"composer-2026-10-14-r11",
      sessions:[session("tab-1")]},3_000);
    assert.equal(f.bridge.getSnapshot(3_001).clients[0].composerBuild,
      "composer-2026-10-14-r11");
    f.bridge.sync(extensionId,{version:1,composerBuild:"unsupported-old-worker",
      sessions:[session("tab-1")]},4_000);
    assert.equal(f.bridge.getSnapshot(4_001).clients[0].composerBuild,null);
  }finally{f.close()}
});
test("Chrome payload excludes unregistered tabs and complete conversation URLs", () => {
  const browser = {
    groups: [{id:1,windowId:2,title:"Dev",color:"blue"}],
    tabs: [
      {id:7,windowId:2,groupId:1,url:"https://chatgpt.com/c/secret-one",title:"First"},
      {id:8,windowId:2,groupId:1,url:"https://chatgpt.com/c/secret-two",title:"Second"}
    ]
  };
  let counter=0;
  const makeId=()=> "key-" + ++counter;
  let registry=applyAction(emptyRegistry(),{type:"enrollGroup",groupId:1},browser,"epoch1",makeId,1000);
  registry=applyAction(registry,{type:"enrollTab",groupKey:registry.groups[0].key,tabId:7},browser,"epoch1",makeId,1001);
  const payload=bridgePayload(registry,browser,"epoch1");
  assert.equal(payload.sessions.length,1);
  assert.equal(payload.sessions[0].status,"connected");
  assert.equal(payload.sessions[0].origin,"https://chatgpt.com");
  assert.doesNotMatch(JSON.stringify(payload),/secret-one|secret-two/);
  const afterRestart=bridgePayload(registry,browser,"epoch2");
  assert.equal(afterRestart.sessions[0].status,"needs-rebind");
});
