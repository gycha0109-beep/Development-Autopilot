import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const origin='chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const post=(base,path,body,from=base,token)=>fetch(base+path,{method:'POST',headers:{Origin:from,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
test('popup control requires exact paired extension and an owned connected chat before configuring or sending',{timeout:20000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'autopilot-popup-'));
 const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['local/server.js'],{cwd:process.cwd(),env:{...process.env,AUTOPILOT_DB:join(dir,'test.sqlite3'),AUTOPILOT_PORT:String(port)},stdio:'ignore'});
 try{
  let ready=false;for(let i=0;i<80;i++){try{const r=await fetch(base+'/api/v1/snapshot');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,60))}
  assert.equal(ready,true);
  let r=await post(base,'/api/v1/workstreams',{id:'alpha',name:'Alpha',projectKey:'alpha',repository:'owner/repo'});assert.equal(r.status,201);
  r=await post(base,'/api/v1/bridge/control-state',{},'https://malicious.example');assert.equal(r.status,403);
  r=await post(base,'/api/v1/bridge/control-state',{},origin);assert.equal(r.status,401);
  r=await post(base,'/api/v1/bridge/pairing/start',{});const code=(await r.json()).code;
  r=await post(base,'/api/v1/bridge/pair',{code},origin);assert.equal(r.status,200);const token=(await r.json()).token;
  r=await post(base,'/api/v1/bridge/control-state',{},origin,token);assert.equal(r.status,200);assert.equal((await r.json()).workstreams.length,1);
  r=await post(base,'/api/v1/bridge/control-configure',{workstreamId:'alpha',enabled:true,mode:'scheduled',message:'continue',intervalMinutes:15},origin,token);assert.equal(r.status,400);
  r=await post(base,'/api/v1/bridge/control-link',{workstreamId:'alpha',sessionKey:'missing'},origin,token);assert.equal(r.status,400);
  r=await post(base,'/api/v1/bridge/control-stop',{workstreamId:'alpha'},origin,token);assert.equal(r.status,400);
  const sync=async(status,urlHash='a'.repeat(64))=>{
    const response=await post(base,'/api/v1/bridge/sync',{version:1,composerBuild:'composer-2026-10-15-r17',
      sessions:[{sessionKey:'session-one',groupKey:'group-one',groupLabel:'Alpha',
        title:'Alpha chat',origin:'https://chatgpt.com',status,urlHash}]},origin,token);
    assert.equal(response.status,200);
  };
  await sync('connected');
  r=await post(base,'/api/v1/bridge/control-link',{workstreamId:'alpha',sessionKey:'session-one'},origin,token);
  assert.equal(r.status,200);
  r=await post(base,'/api/v1/bridge/control-configure',{workstreamId:'alpha',enabled:true,
    mode:'scheduled',message:'continue',intervalMinutes:15},origin,token);
  assert.equal(r.status,200);
  assert.equal((await r.json()).config.enabled,true);
  await sync('missing');
  await sync('connected');
  r=await post(base,'/api/v1/bridge/control-state',{},origin,token);
  assert.equal(r.status,200);
  const state=await r.json();
  assert.equal(state.configs[0].enabled,true);
  assert.equal(state.configs[0].approvedSessionKey,'session-one');
  assert.equal(state.configs[0].approvedUrlHash,'a'.repeat(64));
  // The same stable key pointing to a different conversation hash is not a reconnect.
  await sync('connected','b'.repeat(64));
  r=await post(base,'/api/v1/bridge/control-state',{},origin,token);
  const changed=await r.json();
  assert.equal(changed.configs[0].enabled,false);
  assert.equal(changed.configs[0].statusReason,'CHAT_SESSION_RECONNECTED_REAPPROVAL_REQUIRED');
  // Explicitly approve the current chat and then bind a different registered chat.
  r=await post(base,'/api/v1/bridge/control-configure',{workstreamId:'alpha',
    enabled:true,mode:'scheduled',message:'continue',intervalMinutes:15},origin,token);
  assert.equal(r.status,200);
  assert.equal((await r.json()).config.enabled,true);
  r=await post(base,'/api/v1/bridge/sync',{
    version:1,composerBuild:'composer-2026-10-15-r17',
    sessions:[
      {sessionKey:'session-one',groupKey:'group-one',groupLabel:'Alpha',
        title:'Alpha chat',origin:'https://chatgpt.com',status:'connected',urlHash:'b'.repeat(64)},
      {sessionKey:'session-two',groupKey:'group-two',groupLabel:'Alpha',
        title:'Other chat',origin:'https://chatgpt.com',status:'connected',urlHash:'c'.repeat(64)}
    ]
  },origin,token);
  assert.equal(r.status,200);
  r=await post(base,'/api/v1/bridge/control-link',{
    workstreamId:'alpha',sessionKey:'session-two'
  },origin,token);
  assert.equal(r.status,200);
  const relink=await r.json();
  assert.equal(relink.reapprovalRequired,true);
  r=await post(base,'/api/v1/bridge/control-state',{},origin,token);
  assert.equal((await r.json()).configs[0].enabled,false);
  r=await fetch(base+'/api/v1/snapshot');
  assert.equal((await r.json()).chatContinuation.commands.length,0);

 }finally{child.kill();if(child.exitCode===null)await once(child,'exit');rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
