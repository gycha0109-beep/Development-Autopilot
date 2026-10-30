import test from "node:test";
import assert from "node:assert/strict";
import { WorkstreamStore } from "../local/store.js";
import { ChromeBridge } from "../local/chrome-bridge.js";
import { PortableWorkstreamConfig } from "../local/portable-config.js";

const id = "a".repeat(32);
const sample = (sessionKey="s1")=>({
  name:"PIE",projectKey:"PIE",repository:"gycha0109-beep/Project_Intelligence_Engine",
  trackKey:null,intervalMinutes:35,enabled:true,paused:false,sessionKey
});
function setup(){
  const store=new WorkstreamStore(":memory:");
  const bridge=new ChromeBridge(store);
  const config=new PortableWorkstreamConfig(store,bridge);
  return {store,bridge,config};
}
function connect(bridge,sessionKey="s1"){
  const one=bridge.beginPairing();
  const result=bridge.pair("chrome-extension://"+id,one.code);
  assert.equal(result.ok,true);
  bridge.sync(id,{version:1,composerBuild:"composer-2026-10-15-r17",sessions:[{
    sessionKey,groupKey:"g1",groupLabel:"PIE",title:"PIE",
    origin:"https://chatgpt.com",status:"connected"
  }]});
}
test("creates workstream without sending a chat message and imports pending link",()=>{
  const {store,bridge,config}=setup();
  const result=config.import(id,[sample()]);
  assert.equal(result.created,1);
  assert.equal(result.linked,0);
  assert.equal(store.list()[0].mode,"observe");
  assert.equal(store.list()[0].last_dispatched_at,null);
  assert.equal(config.export(id).workstreams[0].sessionKey,null);
  connect(bridge);
  assert.equal(config.reconcile(id),1);
  assert.equal(bridge.getSnapshot().links.length,1);
  assert.equal(config.export(id).workstreams[0].sessionKey,"s1");
  store.close();
});
test("same import again is idempotent and does not remove existing mapping",()=>{
  const {store,bridge,config}=setup();
  connect(bridge);
  const once=config.import(id,[sample()]);
  const twice=config.import(id,[sample()]);
  assert.equal(once.linked,1);
  assert.equal(twice.created,0);
  assert.equal(twice.existing,1);
  assert.equal(store.list().length,1);
  assert.equal(bridge.getSnapshot().links.length,1);
  store.close();
});
test("multiple different session keys cannot bind to the same workstream",()=>{
  const {store,bridge,config}=setup();
  connect(bridge);
  config.import(id,[sample()]);
  const before=bridge.getSnapshot().links[0].sessionKey;
  config.import(id,[sample("s2")]);
  assert.equal(bridge.getSnapshot().links[0].sessionKey,before);
  store.close();
});
test("rejects invalid and duplicate configuration",()=>{
  const {store,config}=setup();
  assert.throws(()=>config.import(id,[{...sample(),repository:"evil"}]));
  assert.throws(()=>config.import(id,[sample(),sample()]));
  assert.equal(store.list().length,0);
  store.close();
});
