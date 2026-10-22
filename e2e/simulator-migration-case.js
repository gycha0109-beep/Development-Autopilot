import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {waitFor} from '../test-support/browser-environment.js';

export async function runSimulatorMigration({context,worker,options,simulator,sim,api,snapshot,extensionId,group,checkpoint,modern=false,existing=false,failure=false}){
  const id=existing?'sim-axis-19':failure?'sim-migration-failure':'sim-migration-source',title='Simulator Track 1',next='Simulator Track 2';
  const handoff=['AUTOPILOT_MIGRATION_HANDOFF','GitHub 저장소: sim-owner/sim-repo','원본 트랙: '+title,'신규 트랙: '+next,
    '목적: 격리된 시뮬레이터의 동일 탭 이관 검증.','로드맵: docs/ROADMAP.md. 완료: 이전 단계의 구현 및 검사. 남은 작업: 다음 미완료 작업을 수행하고 검증하십시오.',
    '승인 없이 병합하거나 비용을 발생시키지 마십시오. 이 문서는 테스트용 합성 데이터입니다.'].join('\n');
  await sim('/projects/g-p-simulator',{renderer:modern?'current':'legacy'});
  const input={id,project:'g-p-simulator',renderer:modern?'current':'legacy',title,responses:[{answer:handoff,delayMs:1500,scenario:modern?'writing':'normal'}]};
  const created=existing?{url:'/g/g-p-simulator/c/'+id}:await sim('/rooms',input);
  if(existing)await sim('/rooms/'+id+'/scenario',{scenario:'normal',title,responses:input.responses});
  const page=existing?context.pages().find(p=>p.url()===simulator.origin+created.url):await context.newPage();
  if(!existing)await page.goto(simulator.origin+created.url);
  await delay(400);
  const tabId=await worker.evaluate(async({url,group})=>{const ts=await chrome.tabs.query({url});if(ts.length!==1)throw Error('NON_UNIQUE_SOURCE');await chrome.tabs.group({tabIds:[ts[0].id],groupId:group});return ts[0].id;},{url:page.url(),group});
  await options.reload();const row=options.locator('#groups .tab-row').filter({hasText:title});
  if(!existing){await row.getByRole('button',{name:'탭 등록',exact:true}).click();await row.getByText('등록됨',{exact:true}).waitFor();}
  const sync=()=>options.getByRole('button',{name:'지금 동기화',exact:true}).click();await sync();
  const session=await waitFor('new migration tab bridge receipt',async()=>{const s=await snapshot();const key=existing?s.chromeBridge.links.find(l=>l.workstreamId===id)?.sessionKey:null;return s.chromeBridge.sessions.find(session=>existing?session.sessionKey===key:session.title===title);});
  const state=await snapshot();
  const oldLinks=state.chromeBridge.links.filter(l=>l.workstreamId!==id);
  if(!existing)await api('/workstreams',{id,name:id,projectKey:'sim-project',repository:'sim-owner/sim-repo',trackKey:'migration',intervalMinutes:35});
  if(!existing)await api('/workstreams/'+id+'/link-chrome',{extensionId,sessionKey:session.sessionKey});
  if(!existing)await api('/autopilot/observe',{workstreamId:id,observationPermitted:true});await sync();
  if(!existing)await waitFor('migration fresh preview',async()=>{const s=await snapshot();return s.autopilot.scopes.find(x=>x.workstreamId===id)?.observation?.verified;});
  if(!existing)await api('/chat-continuation/configure',{workstreamId:id,enabled:true,mode:'scheduled',message:'계속 진행',intervalMinutes:35,hours:1,maxMessages:1});
  if(!existing)await api('/autopilot/configure',{workstreamId:id,observationPermitted:true,executionPermitted:true,remainingWork:true});
  const config=(await snapshot()).chatContinuation.configs.find(c=>c.workstreamId===id);
  const configured=await options.evaluate(async key=>chrome.runtime.sendMessage({type:'AP_AUTO_MIGRATION_CONFIG',sessionKey:key,enabled:true,repository:'sim-owner/sim-repo'}),session.sessionKey);
  assert.equal(configured.ok,true,JSON.stringify(configured));
  if(failure){
    // Scoped to the disposable same-tab simulator. The generated target view
    // renders an ambiguous menu before the extension can inspect it.
    await page.evaluate(sourceId=>
      sessionStorage.setItem('autopilot.simulator.ambiguousRenameSource',sourceId),id);
  }
  await sim('/rooms/'+id+'/scenario',{scenario:'length'});await delay(400);
  let lastStage;
  await waitFor('same physical tab source handoff, new project chat, title and mapping restoration',async()=>{
    await sync();await api('/tick',{});await delay(1000);
    const progress=await worker.evaluate(async key=>(await chrome.storage.session.get('autopilot.migration.auto.progress.v1'))['autopilot.migration.auto.progress.v1']?.[key],session.sessionKey);
    if(progress?.stage!==lastStage){lastStage=progress?.stage;checkpoint('migration-stage',{stage:lastStage,reason:progress?.reason});}
    if(failure&&progress?.stage==='needs_attention'){const s=await snapshot();return s.autopilot.inbox.some(r=>r.workstreamId===id&&r.reasonCode==='MIGRATION_NEEDS_ATTENTION');}
    if(progress?.stage==='needs_attention')throw Error('MIGRATION_BLOCKED: '+progress.reason);
    return progress?.stage==='completed';
  },240000);
  const after=await snapshot();
  if(failure){
    assert.equal(after.chatContinuation.configs.find(c=>c.workstreamId===id).enabled,false);
    assert.deepEqual(after.chromeBridge.links.filter(l=>l.workstreamId!==id),oldLinks);
    const before=simulator.model.snapshot().rooms.map(r=>r.messages.length);
    await sync();await sync();assert.deepEqual(simulator.model.snapshot().rooms.map(r=>r.messages.length),before);
    assert.equal(after.autopilot.inbox.filter(r=>r.workstreamId===id&&r.reasonCode==='MIGRATION_NEEDS_ATTENTION').length,1);
    checkpoint('current-migration-rename-failure-isolated-inbox-no-replay',{category:'C-synthetic-UI-failure'});return;
  }
  const linked=after.chromeBridge.links.find(l=>l.workstreamId===id);
  assert.equal(linked.sessionKey,session.sessionKey);assert.equal(linked.status,'connected');
  assert.deepEqual(after.chromeBridge.links.filter(l=>l.workstreamId!==id),oldLinks);
  const tab=await worker.evaluate(async tabId=>chrome.tabs.get(tabId),tabId);
  assert.equal(tab.id,tabId);assert.equal(tab.groupId,group);assert.notEqual(tab.url,simulator.origin+created.url);
  assert.ok(tab.url.startsWith(simulator.origin+'/g/g-p-simulator/c/'));
  const targetId=tab.url.split('/').at(-1),source=simulator.model.view(id),target=simulator.model.view(targetId);
  assert.equal(source.messages.length,1);assert.ok(source.messages[0].message.includes('AUTOPILOT_MIGRATION_HANDOFF'));
  assert.deepEqual(target.messages.map(m=>m.message),[modern?handoff.split('\n').slice(1).join('\n\n').trim():handoff.slice('AUTOPILOT_MIGRATION_HANDOFF\n'.length)]);assert.equal(target.title,next);assert.equal(target.turns.at(-1).state,'complete');
  const restored=after.chatContinuation.configs.find(c=>c.workstreamId===id);
  assert.equal(restored.approvedAt,config.approvedAt);assert.equal(restored.expiresAt,config.expiresAt);assert.equal(restored.maxMessages,1);assert.equal(restored.sentCount,0);
  assert.equal(restored.enabled,true);assert.equal(after.autopilot.scopes.find(x=>x.workstreamId===id)?.schedule?.enabled,true);
  await sync();await sync();assert.equal(simulator.model.view(id).messages.length,1);assert.equal(simulator.model.view(targetId).messages.length,1);
  checkpoint((modern?'current-writing-block':'legacy')+'-migration-complete-same-tab-two-messages-no-replay',{renderer:modern?'observed-current-structure-synthetic-behavior':'synthetic-legacy',registeredWorkstreamRetained:true,approvalRetained:true});
}
