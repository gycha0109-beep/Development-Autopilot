import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { SimulatorModel } from '../simulator/model.js';
import { startSimulator } from '../simulator/server.js';
import { buildSimulatorRuntime,loopbackOrigin } from '../simulator/test-build.js';

test('simulator stream, idempotent requests, stop and persisted reload recovery are independent',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'autopilot-simulator-'));let now=100;
  try{
    const file=path.join(dir,'state.json');let m=new SimulatorModel({file,now:()=>now});
    for(let i=0;i<20;i++)m.create({id:'axis-'+i});
    m.patch('axis-0',{responses:[{answer:'Owned next response',delayMs:100}]});
    assert.deepEqual(m.send('axis-0',{requestId:'request-1',message:'계속 진행'}),{accepted:true,userId:'axis-0-user-1'});
    m.send('axis-0',{requestId:'request-1',message:'계속 진행'});
    assert.equal(m.view('axis-0').messages.length,1);
    assert.throws(()=>m.send('axis-0',{requestId:'request-2',message:'계속 진행'}),/STILL_GENERATING/);
    now=201;assert.equal(m.view('axis-0').turns.at(-1).state,'complete');
    m.navigate('axis-1');m.patch('axis-1',{scenario:'loading-error'});m.navigate('axis-1');
    assert.equal(m.view('axis-1').scenario,'normal');assert.equal(m.view('axis-1').reloads,1);
    m.navigate('axis-2');m.patch('axis-2',{scenario:'loading-error',recoverOnReload:false});m.navigate('axis-2');
    assert.equal(m.view('axis-2').scenario,'loading-error');
    m.patch('axis-3',{scenario:'disconnect'});m.stop('axis-3');m.stop('axis-3');assert.equal(m.view('axis-3').stops,1);
    m=new SimulatorModel({file,now:()=>now});assert.equal(m.view('axis-0').messages.length,1);
    assert.ok(m.snapshot().rooms.slice(4).every(r=>r.messages.length===0&&r.reloads===0&&r.stops===0));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('simulator API requires exact loopback Host, same-origin JSON and rejects foreign project routes',async()=>{
  const s=await startSimulator();
  try{
    const post=(body,headers={})=>fetch(s.origin+'/simulator/api/rooms',{method:'POST',headers:{Origin:s.origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await post({id:'owned'},{Origin:'https://chatgpt.com'})).status,403);
    const badHost=await new Promise((ok,no)=>{const req=request(s.origin+'/simulator/api',{headers:{Host:'evil.example'}},res=>{res.resume();ok(res.statusCode);});req.on('error',no);req.end();});
    assert.equal(badHost,403);
    assert.equal((await post({id:'owned',project:'g-p-owned'})).status,200);
    assert.equal((await fetch(s.origin+'/c/owned')).status,404);
    assert.equal((await fetch(s.origin+'/g/g-p-owned/c/owned')).status,200);
    assert.equal((await post({id:'owned'})).status,400);
    assert.equal((await fetch(s.origin+'/simulator/api')).headers.get('access-control-allow-origin'),null);
  }finally{await s.close();}
});

test('explicit test build removes production origin access without changing policy or source',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'autopilot-simulator-build-'));
  try{
    const credentialUrl=new URL('http://127.0.0.1:48273');credentialUrl.username='synthetic-user';
    for(const value of ['https://chatgpt.com','http://localhost:48273','http://127.0.0.1:48273/',credentialUrl.href])assert.throws(()=>loopbackOrigin(value));
    const before=readFileSync(new URL('../extension/chat-observer.js',import.meta.url),'utf8');
    const build=buildSimulatorRuntime({destination:path.join(dir,'runtime'),simulatorOrigin:'http://127.0.0.1:48273',bridgeOrigin:'http://127.0.0.1:48274'});
    assert.deepEqual(JSON.parse(readFileSync(path.join(build.extensionDir,'manifest.json'),'utf8')).host_permissions,['http://127.0.0.1/*']);
    assert.equal(readFileSync(path.join(build.extensionDir,'chat-observer.js'),'utf8'),before.replaceAll('https://chatgpt.com','http://127.0.0.1:48273'));
    assert.equal(readFileSync(new URL('../extension/chat-observer.js',import.meta.url),'utf8'),before);
    const migration=readFileSync(path.join(build.extensionDir,'migration-auto.js'),'utf8');
    assert.doesNotMatch(migration,/chatgpt\\\.com/);
    assert.ok(migration.includes('http:\\/\\/127\\.0\\.0\\.1:48273'));
    for(const file of ['loading-recovery.js','autopilot-decision.js','autopilot-coordinator.js','disconnect-recovery.js','chat-continuation.js']){
      const source=readFileSync(new URL('../local/'+file,import.meta.url),'utf8');
      assert.equal(readFileSync(path.join(dir,'runtime','local',file),'utf8'),source.replaceAll('https://chatgpt.com','http://127.0.0.1:48273'));
    }
    assert.throws(()=>buildSimulatorRuntime({destination:path.join(dir,'runtime'),simulatorOrigin:'http://127.0.0.1:48273',bridgeOrigin:'http://127.0.0.1:48274'}),/ABSENT/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('invalid scenario control is atomic and empty project chats have no fabricated assistant reply',()=>{
  const m=new SimulatorModel();m.create({id:'owned'});const before=m.view('owned');
  assert.throws(()=>m.patch('owned',{scenario:'cost',responses:[{delayMs:-1}]}),/DELAY/);
  assert.deepEqual(m.view('owned'),before);
  assert.throws(()=>m.create({id:'bad',scenario:'unsupported'}),/SCENARIO/);
  assert.throws(()=>m.room('bad'),/NOT_FOUND/);
  m.create({id:'new',empty:true,project:'g-p-owned'});assert.equal(m.view('new').turns.length,0);
  m.send('new',{requestId:'handoff-1',message:'Owned handoff'});assert.equal(m.view('new').turns.length,1);
});
