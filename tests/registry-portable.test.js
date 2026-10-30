import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreExactRegistrations, exportPortableRegistry, importPortableRegistry } from '../extension/registry-portable.js';

const oldUrl = 'https://chatgpt.com/g/g-p-test/c/12345';
const buildUrl = 'https://chatgpt.com/g/g-p-build/c/98765';
const oldRegistry = () => ({
  version: 1,
  groups: [{key:'g1',groupId:8,windowId:2,sessionToken:'old',label:'PIE',color:'blue',paused:false,enrolledAt:1}],
  sessions:[{key:'s1',groupKey:'g1',tabId:30,sessionToken:'old',url:oldUrl,title:'PIE 데이터 분석 2',paused:false,enrolledAt:1}]
});
const snapshot=(group=99,tabs=[{id:777,groupId:group,windowId:9,url:oldUrl,title:'new title'}])=>({
  groups:[{id:group,windowId:9,title:'PIE',color:'blue'}], tabs
});
test('reboot restores exact URL and retains stable session keys',()=>{
  const r=restoreExactRegistrations(oldRegistry(),snapshot(),'new-token');
  assert.equal(r.changed,true);
  assert.equal(r.groupsRestored,1);
  assert.equal(r.tabsRestored,1);
  assert.equal(r.registry.sessions[0].key,'s1');
  assert.equal(r.registry.sessions[0].tabId,777);
  assert.equal(r.registry.groups[0].groupId,99);
  const again=restoreExactRegistrations(r.registry,snapshot(),'new-token');
  assert.equal(again.changed,false);
});
test('recovery refuses ambiguous duplicated exact URL',()=>{
  const s=snapshot();
  s.tabs.push({id:778,groupId:99,windowId:9,url:oldUrl});
  const r=restoreExactRegistrations(oldRegistry(),s,'new-token');
  assert.equal(r.tabsRestored,0);
  assert.equal(r.registry.sessions[0].sessionToken,'old');
});
test('recovery refuses same title but changed conversation URL',()=>{
  const s=snapshot(99,[{id:777,groupId:99,windowId:9,url:buildUrl,title:'PIE 데이터 분석 2'}]);
  assert.equal(restoreExactRegistrations(oldRegistry(),s,'new-token').changed,false);
});
test('export has only portable registered fields and no bridge tokens',()=>{
  const r=oldRegistry();r.secret='not-for-export';
  const p=exportPortableRegistry(r);
  assert.equal(p.version,1);
  assert.equal(p.sessions[0].url,oldUrl);
  assert.equal(JSON.stringify(p).includes('not-for-export'),false);
  assert.equal(JSON.stringify(p).includes('sessionToken'),false);
});
test('portable import restores exact opened URL and is idempotent',()=>{
  const p=exportPortableRegistry(oldRegistry());
  const blank={version:1,groups:[],sessions:[]};
  const first=importPortableRegistry(blank,p,snapshot(),'new-token',()=> 'new-key',42);
  assert.equal(first.importedGroups,1);assert.equal(first.importedTabs,1);
  assert.equal(first.restoredTabs,1);
  const second=importPortableRegistry(first.registry,p,snapshot(),'new-token',()=> 'other-key',43);
  assert.equal(second.importedGroups,0);assert.equal(second.importedTabs,0);
});
test('old duplicate PIE group never overrides newer exact registered chat',()=>{
  const reg=oldRegistry();
  reg.groups[0].enrolledAt=10;
  reg.sessions[0].enrolledAt=10;
  reg.groups.push({key:'g2',groupId:99,windowId:9,sessionToken:'present',label:'PIE',color:'blue',paused:false,enrolledAt:20});
  reg.sessions.push({key:'s2',groupKey:'g2',tabId:777,sessionToken:'present',url:oldUrl,title:'PIE 데이터 분석 2',paused:false,enrolledAt:20});
  const live=snapshot();
  const exported=exportPortableRegistry(reg,live,'present');
  assert.equal(exported.sessions.length,1);
  assert.equal(exported.sessions[0].key,'s2');
  const recovered=restoreExactRegistrations(reg,live,'new-token');
  assert.equal(recovered.tabsRestored,1);
  assert.equal(recovered.registry.sessions.find(x=>x.key==='s2').sessionToken,'new-token');
  assert.equal(recovered.registry.sessions.find(x=>x.key==='s1').sessionToken,'old');
});

test('invalid URL, duplicate keys, invalid schema are rejected atomically',()=>{
  const p=exportPortableRegistry(oldRegistry());
  p.sessions[0].url='https://example.com/c/123';
  assert.throws(()=>importPortableRegistry({version:1,groups:[],sessions:[]},p,snapshot(),'x',()=> 'x',12));
  const q=exportPortableRegistry(oldRegistry());q.sessions.push({...q.sessions[0]});
  assert.throws(()=>importPortableRegistry({version:1,groups:[],sessions:[]},q,snapshot(),'x',()=> 'x',12));
});
test('import stages missing tabs and later recovers when exact chat opens',()=>{
  const p=exportPortableRegistry(oldRegistry());
  const blank={version:1,groups:[],sessions:[]};
  const first=importPortableRegistry(blank,p,{groups:[],tabs:[]},'new-token',()=> 'new-key',10);
  assert.equal(first.restoredTabs,0);
  const r=restoreExactRegistrations(first.registry,snapshot(),'new-token');
  assert.equal(r.tabsRestored,1);
});
