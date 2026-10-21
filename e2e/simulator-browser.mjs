import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { choosePort,waitFor } from '../test-support/browser-environment.js';
import { startSimulator } from '../simulator/server.js';
import { buildSimulatorRuntime } from '../simulator/test-build.js';
import { CI_TARGET } from '../simulator/ci-fixture.js';
import { runSimulatorMigration } from './simulator-migration-case.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const artifacts=path.join(root,'.autopilot','e2e-artifacts');mkdirSync(artifacts,{recursive:true});
const artifactPrefix=process.argv.includes('--migration-only')?'simulator-migration':'simulator';
const temp=mkdtempSync(path.join(tmpdir(),'autopilot-simulator-e2e-'));
const evidence={environment:'isolated-local-simulator',actualChatGPT:false,
  sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),checkpoints:[]};
const checkpoint=(name,data={})=>{evidence.checkpoints.push({name,at:new Date().toISOString(),...data});console.log(JSON.stringify({name,...data}));};
const simulator=await startSimulator({file:path.join(temp,'simulator.json')});
const port=await choosePort(),base='http://127.0.0.1:'+port,debugPort=await choosePort();
const build=buildSimulatorRuntime({destination:path.join(temp,'runtime'),simulatorOrigin:simulator.origin,bridgeOrigin:base,syntheticCI:true});
let context,server,serverLog='',errors=[];
const startServer=()=>{server=spawn(process.execPath,[build.serverPath],{cwd:temp,env:{...process.env,AUTOPILOT_PORT:String(port),AUTOPILOT_DB:path.join(temp,'autopilot.sqlite3')},stdio:['ignore','pipe','pipe']});for(const stream of [server.stdout,server.stderr])stream.on('data',data=>{serverLog+=data.toString();});};
const post=async(origin,route,body)=>{const r=await fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,route+': '+await r.clone().text());return r.json();};
const api=(route,body)=>post(base,'/api/v1'+route,body);
const sim=(route,body)=>post(simulator.origin,'/simulator/api'+route,body);
const snapshot=async()=>{const r=await fetch(base+'/api/v1/snapshot');assert.ok(r.ok);return r.json();};
const scope=(state,id)=>state.autopilot.scopes.find(s=>s.workstreamId===id);
try{
  startServer();await waitFor('simulator Autopilot server',async()=>!!(await fetch(base+'/api/v1/snapshot').catch(()=>null))?.ok);
  const chrome=process.env.PLAYWRIGHT_CHROME_EXECUTABLE||[
      path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft/Edge/Application/msedge.exe')
    ].find(existsSync);
  const launchOptions={...(chrome?{executablePath:chrome}:{channel:'chromium'}),headless:false,
    args:[`--load-extension=${build.extensionDir}`,`--disable-extensions-except=${build.extensionDir}`,`--remote-debugging-port=${debugPort}`]};
  evidence.browser=chrome?path.basename(chrome):'Playwright Chromium';
  context=await chromium.launchPersistentContext(path.join(temp,'profile'),launchOptions);
  await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  // Browser network interception is additional containment; the generated
  // extension has no chatgpt.com host permission and exact local page guards.
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    return [simulator.origin,base].includes(url.origin)||url.protocol==='chrome-extension:'?route.continue():route.abort('blockedbyclient');
  });
  context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
  let worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).host,pages=[];
  assert.equal(await worker.evaluate(()=>chrome.permissions.contains({origins:['https://chatgpt.com/*']})),false);
  for(let i=0;i<20;i++){
    const id='sim-axis-'+String(i).padStart(2,'0');
    await sim('/rooms',{id,title:id,project:'g-p-simulator',responses:[{answer:'이 작업축의 다음 응답이 완료됐습니다.',delayMs:1500}]});
    const page=await context.newPage();await page.goto(simulator.origin+'/g/g-p-simulator/c/'+id);pages.push(page);
  }
  const group=await worker.evaluate(async urls=>{const ids=[];for(const url of urls){const ts=await chrome.tabs.query({url});if(ts.length!==1)throw Error('NON_UNIQUE_TAB');ids.push(ts[0].id);}const group=await chrome.tabs.group({tabIds:ids});await chrome.tabGroups.update(group,{title:'SIMULATOR ONLY',color:'blue'});return group;},pages.map(p=>p.url()));
  const dashboard=await context.newPage();await dashboard.goto(base);await dashboard.getByRole('button',{name:'연결 코드 발급'}).click();
  const code=await waitFor('owned pairing code',async()=>{const t=(await dashboard.locator('#pair-code-value').textContent())?.trim();return /^[a-f0-9]{20}$/i.test(t??'')?t:null;});
  const options=await context.newPage();await options.goto('chrome-extension://'+extensionId+'/options.html');
  const groupCard=options.locator('#groups article').filter({hasText:'SIMULATOR ONLY'});
  await groupCard.getByRole('button',{name:'그룹 등록',exact:true}).click();await groupCard.getByText('그룹 등록됨',{exact:true}).waitFor();
  for(let i=0;i<20;i++){const row=groupCard.locator('.tab-row').nth(i);await row.getByRole('button',{name:'탭 등록',exact:true}).click();await row.getByText('등록됨',{exact:true}).waitFor();}
  await options.locator('#bridge-code').fill(code);await options.getByRole('button',{name:'로컬 연결',exact:true}).click();
  const sync=async()=>{await options.getByRole('button',{name:'지금 동기화',exact:true}).click();};
  await waitFor('twenty real extension sessions',async()=>{const s=await snapshot();return s.chromeBridge.sessions.length===20;});
  const tabsBefore=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({});return tabs.filter(t=>t.url?.includes('/c/sim-axis-')).map(t=>({id:t.id,url:t.url,groupId:t.groupId}));});
  let state=await snapshot();
  for(let i=0;i<20;i++){
    const id='sim-axis-'+String(i).padStart(2,'0'),session=state.chromeBridge.sessions.find(s=>s.title===id);assert.ok(session);
    await api('/workstreams',{id,name:id,projectKey:'sim-project',repository:'sim-owner/sim-repo',trackKey:'ops',intervalMinutes:35});
    await api('/workstreams/'+id+'/link-chrome',{extensionId,sessionKey:session.sessionKey});
    await api('/autopilot/observe',{workstreamId:id,observationPermitted:true});
    if([4,9,19].includes(i)){await sync();await waitFor('preview batch '+(i+1),async()=>{const s=await snapshot();return s.autopilot.scopes.filter(x=>x.observation?.verified).length===i+1;});checkpoint('independent-preview-'+(i+1));}
  }
  checkpoint('twenty-live-mv3-local-sessions',{origin:simulator.origin,debugPort,group});
  if(process.argv.includes('--migration-only')){
    await runSimulatorMigration({context,worker,options,simulator,sim,api,snapshot,extensionId,group,checkpoint});
  }else{
  const initialReplies=new Map((await snapshot()).autopilot.scopes.map(s=>[s.workstreamId,s.observation?.replyFingerprint]));
  // CI adapters make real HTTP requests and production verifiers inspect exact
  // repository/track/PR/SHA/run/attempt. No review/gate result is fabricated.
  const ciId='sim-axis-15';await sim('/ci/ops',{state:'running'});
  await api('/workstreams/'+ciId+'/watchtower-target',{repositoryId:12,runId:77,headSha:CI_TARGET.headSha,attempt:2});
  await api('/workstreams/'+ciId+'/github-target',{prNumber:18,headSha:CI_TARGET.headSha});
  await api('/watchtower/refresh',{});await api('/github/refresh',{});
  state=await snapshot();const candidate=state.chatContinuation.ciResumeCandidates.find(c=>c.workstreamId===ciId);assert.ok(candidate,'exact synthetic CI target candidate');
  for(let i=0;i<20;i++){
    const id='sim-axis-'+String(i).padStart(2,'0');
    await api('/chat-continuation/configure',{workstreamId:id,enabled:true,mode:'scheduled',message:'계속 진행',intervalMinutes:1,hours:1,maxMessages:1,...(id===ciId?{ciResumeTargetHash:candidate.targetHash}:{})});
    await api('/autopilot/configure',{workstreamId:id,remainingWork:true,observationPermitted:true,executionPermitted:true});
    if([10,11].includes(i))await api('/autopilot/loading/configure',{workstreamId:id,reloadPermitted:true});
    if(i===14)await api('/autopilot/recovery/configure',{workstreamId:id,recoveryPermitted:true});
  }
  for(const [i,scenario,extra]of [[10,'loading-error',{recoverOnReload:true}],[11,'loading-error',{recoverOnReload:false}],
    [12,'writing',{}],[13,'ambiguous',{}],[14,'disconnect',{responses:[{answer:'현재까지 진행한 작업과 남은 작업을 보고합니다.',delayMs:1500},{answer:'복구 후 다음 응답 완료.',delayMs:1500}]}],
    [15,'ci',{}],[16,'cost',{}],[17,'local-test',{}],[18,'approval',{}],[19,'generating',{}]]){
    await sim('/rooms/sim-axis-'+String(i).padStart(2,'0')+'/scenario',{scenario,...extra});
  }
  await delay(500);await api('/tick',{});await sync();
  await waitFor('CI running plus Inbox blocking while independent normal work continues',async()=>{
    await api('/tick',{});await sync();await delay(1000);const s=await snapshot();
    const ci=scope(s,ciId);
    return ci.observation?.ciWaitCue&&ci.decision?.nextAction==='WAIT_CI'&&ci.schedule.next_external_check_at>Date.now()&&
      [16,17,18].every(i=>s.workstreams.find(w=>w.id==='sim-axis-'+i)?.paused);
  },180000);
  state=await snapshot();assert.equal(simulator.model.view(ciId).messages.length,0);
  assert.ok(scope(state,ciId).schedule.next_external_check_at>Date.now()-10000);
  assert.equal(simulator.model.view('sim-axis-19').messages.length,0);assert.equal(simulator.model.view('sim-axis-12').messages.length,0);
  checkpoint('ci-generating-writing-human-blocked');
  await sim('/ci/ops',{state:'success'});
  await api('/watchtower/refresh',{});await api('/github/refresh',{});
  await waitFor('normal, loading reload resume, disconnect and CI single continuation',async()=>{
    await api('/tick',{});await sync();await delay(1500);
    const s=await snapshot(),normal=Array.from({length:10},(_,i)=>'sim-axis-'+String(i).padStart(2,'0'));
    return normal.every(id=>simulator.model.view(id).messages.length===1)&&simulator.model.view(ciId).messages.length===1&&
      scope(s,'sim-axis-10').loadingRecovery.episode?.stage==='DONE'&&simulator.model.view('sim-axis-10').messages.length===1&&
      scope(s,'sim-axis-11').loadingRecovery.episode?.stage==='FAILED'&&simulator.model.view('sim-axis-14').messages.length===2;
  },900000);
  await delay(2000);state=await snapshot();
  await waitFor('independent engine observation of every completed next reply',async()=>{
    await api('/tick',{});await sync();await delay(1000);const s=await snapshot();
    return [...Array.from({length:10},(_,i)=>'sim-axis-'+String(i).padStart(2,'0')),'sim-axis-10','sim-axis-14',ciId].every(id=>{
      const r=simulator.model.view(id),o=scope(s,id).observation;
      return o?.verified&&o.contentComplete&&o.assistantBusy===false&&o.observedAt>r.messages.at(-1).at&&o.replyFingerprint!==initialReplies.get(id);
    });
  },180000);
  state=await snapshot();checkpoint('all-next-replies-independently-observed');
  const completedFingerprint=scope(state,'sim-axis-00').observation.replyFingerprint;
  const faultStart=Date.now();
  await sim('/rooms/sim-axis-00/scenario',{duplicate:true});
  await sim('/rooms/sim-axis-01/scenario',{reverse:true});
  await sim('/rooms/sim-axis-02/scenario',{draft:'Synthetic unsent draft'});
  await waitFor('duplicate/reordered turns and a retained draft observed without another send',async()=>{
    await api('/tick',{});await sync();await delay(1000);const s=await snapshot();
    return [0,1,2].every(i=>scope(s,'sim-axis-0'+i).observation?.observedAt>faultStart)&&
      scope(s,'sim-axis-00').observation.replyFingerprint===completedFingerprint&&
      scope(s,'sim-axis-01').observation.replyFingerprint===initialReplies.get('sim-axis-01')&&
      scope(s,'sim-axis-02').observation.composerHasDraft===true;
  },180000);
  assert.equal(await pages[2].locator('#prompt-textarea').textContent(),'Synthetic unsent draft');
  checkpoint('duplicate-reordered-dom-and-unsent-draft-no-replay');
  state=await snapshot();
  for(let i=0;i<20;i++){
    const id='sim-axis-'+String(i).padStart(2,'0'),r=simulator.model.view(id),cfg=state.chatContinuation.configs.find(c=>c.workstreamId===id);
    assert.ok(cfg.sentCount<=1&&cfg.maxMessages===1,id+' original bound retained');
    if(i<10||i===10||i===15){assert.deepEqual(r.messages.map(m=>m.message),['계속 진행']);assert.equal(r.turns.at(-1).state,'complete');}
    else if(i===14){assert.deepEqual(r.messages.map(m=>m.message),['현재까지 진행한 작업과 남은 작업을 보고해줘.','계속 진행']);assert.equal(r.stops,1);}
    else assert.equal(r.messages.length,0,id+' must not send');
  }
  for(const i of [10,11])assert.equal(simulator.model.view('sim-axis-'+i).reloads,1);
  const reloadTimes=[10,11].map(i=>simulator.model.state.events.filter(e=>e.type==='navigation'&&e.roomId==='sim-axis-'+i).at(-1).at);
  assert.ok(Math.abs(reloadTimes[0]-reloadTimes[1])>=60000,'global reload slot and minimum interval retained');
  const tabsAfter=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({});return tabs.filter(t=>t.url?.includes('/c/sim-axis-')).map(t=>({id:t.id,url:t.url,groupId:t.groupId}));});
  assert.deepEqual(tabsAfter,tabsBefore,'same physical tabs, routes and groups retained');
  checkpoint('twenty-axis-mixed-runtime-complete',{messages:simulator.model.snapshot().rooms.reduce((n,r)=>n+r.messages.length,0),reloads:2,errors});
  assert.deepEqual(errors,[]);
  // Server restart keeps all approvals, claims and limits. Fresh observations
  // are required again; no uncertain command is replayed.
  const counts=simulator.model.snapshot().rooms.map(r=>r.messages.length),configs=state.chatContinuation.configs;
  await new Promise(ok=>{server.once('exit',ok);server.kill();});startServer();
  await waitFor('server restarted',async()=>!!(await fetch(base+'/api/v1/snapshot').catch(()=>null))?.ok);
  await sync();await api('/tick',{});await sync();await delay(2000);
  assert.deepEqual(simulator.model.snapshot().rooms.map(r=>r.messages.length),counts);
  const restored=await snapshot();for(const cfg of configs){const next=restored.chatContinuation.configs.find(c=>c.workstreamId===cfg.workstreamId);assert.equal(next.approvedAt,cfg.approvedAt);assert.equal(next.maxMessages,cfg.maxMessages);assert.equal(next.sentCount,cfg.sentCount);}
  checkpoint('server-restart-preserves-approvals-and-no-replay');
  // Closing this disposable profile invalidates physical-tab/epoch authority.
  // Registrations and approval history survive; explicit rebind is still needed.
  await context.tracing.stop({path:path.join(artifacts,'simulator-runtime-trace.zip')});await context.close();
  context=await chromium.launchPersistentContext(path.join(temp,'profile'),launchOptions);
  await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  await context.route('**/*',route=>{const u=new URL(route.request().url());return [simulator.origin,base].includes(u.origin)||u.protocol==='chrome-extension:'?route.continue():route.abort('blockedbyclient');});
  worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const restartedOptions=await context.newPage();await restartedOptions.goto('chrome-extension://'+extensionId+'/options.html');
  await restartedOptions.getByRole('button',{name:'지금 동기화',exact:true}).click();await api('/tick',{});await delay(1500);
  const restarted=await snapshot();assert.equal(restarted.chromeBridge.sessions.length,20);
  assert.ok(restarted.chromeBridge.sessions.every(s=>s.status!=='connected'));
  assert.deepEqual(simulator.model.snapshot().rooms.map(r=>r.messages.length),counts);
  assert.equal(restarted.chatContinuation.commands.length,restored.chatContinuation.commands.length);
  checkpoint('browser-and-extension-restart-preserve-registration-with-safe-rebind-hold');
  }
  evidence.success=true;
}catch(error){
  evidence.success=false;evidence.error=error.stack;writeFileSync(path.join(artifacts,artifactPrefix+'-server.log'),serverLog);
  try{writeFileSync(path.join(artifacts,artifactPrefix+'-failure.json'),JSON.stringify({snapshot:await snapshot(),simulator:simulator.model.snapshot()},null,2));}catch{}
  throw error;
}finally{
  writeFileSync(path.join(artifacts,artifactPrefix+'-results.json'),JSON.stringify(evidence,null,2));
  if(context){await context.tracing.stop({path:path.join(artifacts,artifactPrefix+'-browser-trace.zip')}).catch(()=>{});await context.close().catch(()=>{});}
  if(server?.exitCode===null){server.kill();await delay(500);}
  await simulator.close();
  if(!path.resolve(temp).startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(temp).startsWith('autopilot-simulator-e2e-'))throw Error('UNSAFE_TEMP_CLEANUP');
  rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}
