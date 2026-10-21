import test from 'node:test';
import assert from 'node:assert/strict';
import {executeLoadingReload} from '../extension/loading-worker.js';
import {readRequestedObservation} from '../extension/observation-worker.js';
const op='12345678-1234-4234-8234-123456789abc';
function fixture({unsafe=false,busy=false,authorized=true,drift=false,throwReload=false,newUser=false}={}){
  const group={key:'group',groupId:3,windowId:2,sessionToken:'epoch',paused:false};
  const session={key:'session',tabId:11,groupKey:'group',sessionToken:'epoch',paused:false,url:'https://chatgpt.com/c/loading'};
  const registry={groups:[group],sessions:[session]},tab={id:11,windowId:2,groupId:3,url:session.url};
  let reloads=0,auths=0;const attempted=new Set();
  const a={load:async()=>structuredClone(registry),snapshot:async()=>({groups:[{id:3,windowId:2}],tabs:[tab]}),
    epoch:async()=> 'epoch',getTab:async()=>tab,busy:async()=>busy,
    authorize:async()=>{auths++;if(drift)session.paused=true;return {authorized};},
    markAttempt:async id=>{if(attempted.has(id))return false;attempted.add(id);return true;},
    reload:async id=>{assert.equal(id,11);reloads++;if(throwReload)throw Error('uncertain');},
    execute:async options=>{
      assert.equal(options.target.tabId,11);assert.equal(options.world,'ISOLATED');
      if(options.func.name==='captureChatObservation')return [{result:{schemaVersion:1,sourceVersion:'chat-observer-1',source:'chatgpt-dom',verified:false,reasonCode:'ASSISTANT_RESPONSE_UNAVAILABLE'}}];
      assert.equal(options.func.name,'inspectLoadingPage');
      return [{result:unsafe?null:{safe:true,failed:true,bindingFingerprint:options.args[0].bindingFingerprint,
        userFingerprint:(newUser&&auths?'f':'e').repeat(64)}}];
    }};
  const c={operationId:op,workstreamId:'work',sessionKey:'session',userFingerprint:'e'.repeat(64)};
  return {a,c,reloads:()=>reloads,attempted,run:async()=>{
    const p=await readRequestedObservation(c,a);c.bindingFingerprint=p.loadingSafety?.bindingFingerprint;
    return executeLoadingReload(c,a);
  }};
}
test('worker reloads the exact registered physical tab once and duplicate commands cannot navigate again',async()=>{
  const f=fixture();assert.equal((await f.run()).outcome,'started');assert.equal(f.reloads(),1);
  assert.equal((await f.run()).outcome,'unknown');assert.equal(f.reloads(),1);
});
for(const option of ['unsafe','busy','drift','newUser'])
test('worker never navigates with '+option,async()=>{
  const f=fixture({[option]:true});assert.notEqual((await f.run()).outcome,'started');assert.equal(f.reloads(),0);
});
test('server refusal prevents a reload and navigation exceptions are never retried',async()=>{
  const refused=fixture({authorized:false});assert.equal((await refused.run()).outcome,'refused');assert.equal(refused.reloads(),0);
  const uncertain=fixture({throwReload:true});assert.equal((await uncertain.run()).outcome,'unknown');
  assert.equal((await uncertain.run()).outcome,'unknown');assert.equal(uncertain.reloads(),1);
});
