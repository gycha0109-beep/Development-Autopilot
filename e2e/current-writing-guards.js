import assert from 'node:assert/strict';

// Synthetic negative cases against the generated production functions, in the
// real MV3 isolated world. Never run this against a user/ChatGPT tab.
export async function checkCurrentWritingGuards({context,worker,options,simulator,sim,checkpoint}) {
  const id='modern-guard-room';
  const request='현재 개발 채팅의 길이 제한으로 다음 채팅에 이관해야 합니다. 이관 프롬프트 새 프로젝트 채팅 로드맵 AUTOPILOT_MIGRATION_HANDOFF sim-owner/sim-repo Simulator Track 1';
  const body=('sim-owner/sim-repo Simulator Track 1\n'+('다음 작업을 진행하고 결과를 검증하십시오. '.repeat(8))).trim();
  const renderedBody=body.replaceAll('\n','\n\n');
  await sim('/rooms',{id,project:'g-p-simulator',scenario:'writing',answer:'AUTOPILOT_MIGRATION_HANDOFF\n'+body});
  const page=await context.newPage();await page.goto(simulator.origin+'/g/g-p-simulator/c/'+id);
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({url}))[0].id,page.url());
  const read=()=>options.evaluate(async ({tabId})=>{
    const {copyLastMigrationAssistant}=await import(chrome.runtime.getURL('migration-page.js'));
    const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:copyLastMigrationAssistant,args:[0,'AUTOPILOT_MIGRATION_HANDOFF',30000,'old-assistant','old-user',false,{repository:'sim-owner/sim-repo',trackTitle:'Simulator Track 1'}]});
    return result;
  },{tabId});
  await page.locator('[data-chatgpt-search-unit-key$=":user"]').evaluate((e,text)=>{e.textContent=text;},request);
  const good=await read();assert.equal(good.ok,true,JSON.stringify(good));assert.equal(good.body,renderedBody);assert.equal(good.evidence,'CURRENT_IDENTITY_WRITING_BLOCK');
  const mutate=async(fn)=>{const original=await page.locator('main').innerHTML();await page.evaluate(fn);const result=await read();assert.equal(result.ok,false,JSON.stringify(result));await page.locator('main').evaluate((e,html)=>{e.innerHTML=html;},original);};
  await mutate(()=>document.querySelector('[data-dil-source-message-id]').setAttribute('data-dil-source-message-id','unrelated-message'));
  await mutate(()=>{const stop=document.createElement('button');stop.setAttribute('aria-label','중지');document.querySelector('form').append(stop);});
  await mutate(()=>document.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state','streaming'));
  await mutate(()=>{const c=document.querySelector('[data-testid="chatgpt-writing-block"]');c.after(c.cloneNode(true));});
  await mutate(()=>document.querySelector('.writing-block-editor').remove());
  await mutate(()=>document.querySelector('.writing-block-editor [role="textbox"]').append(Object.assign(document.createElement('span'),{hidden:true,textContent:'Missing section'})));
  await mutate(()=>document.querySelector('[data-chatgpt-search-unit-key$=":user"]').textContent='Unrelated request');
  await mutate(()=>document.querySelector('.writing-block-editor [role="textbox"]').textContent='AUTOPILOT_MIGRATION_HANDOFF\nshort');
  await mutate(()=>{const p=document.createElement('p');p.textContent='AUTOPILOT_MIGRATION_HANDOFF';document.querySelector('[data-dil-message-id]').prepend(p);});
  assert.equal((await read()).body,renderedBody,'negative cases cannot poison the next independent capture');
  await page.close();checkpoint('current-writing-guard-regressions',{positive:1,negative:9,category:'B-structure-C-fault-injection',actualChatGPT:false});
}
