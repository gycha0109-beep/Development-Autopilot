import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkstreamStore} from '../local/store.js';
import {ChromeBridge} from '../local/chrome-bridge.js';
import {ChatContinuation} from '../local/chat-continuation.js';
import {AutopilotRuntime} from '../local/autopilot-runtime.js';
import {CHAT_COMPOSER_BUILD} from '../extension/chat-page.js';
import {collectMigrationResumeProof} from '../extension/migration-resume-worker.js';
import {observation,NOW,BINDING} from '../test-support/autopilot-fixture.js';

const ext='abcdefghijklmnopabcdefghijklmnop',target='d'.repeat(64);
function fixture(){
  let now=NOW;const store=new WorkstreamStore(),bridge=new ChromeBridge(store);
  const source={targets:{list:()=>[]},current:()=>({targets:[],results:[]}),refresh:async()=>{}},gate={one:()=>null,getReview:()=>null};
  store.create({id:'work',name:'Work',projectKey:'project',repository:'owner/repo'},now);
  const p=bridge.beginPairing(now);bridge.pair('chrome-extension://'+ext,p.code,now);
  bridge.sync(ext,{version:1,composerBuild:CHAT_COMPOSER_BUILD,sessions:[{sessionKey:'session',groupKey:'group',title:'Track 1',origin:'https://chatgpt.com',status:'connected'}]},now);
  bridge.link('work',ext,'session',now);
  const chat=new ChatContinuation(store,{bridge,watchtower:source,github:source,gate,now:()=>now});
  const runtime=new AutopilotRuntime(store,{bridge,chat,watchtower:source,github:source,gate,now:()=>now});
  runtime.updateMigrationWatches(ext,['session']);
  runtime.preview('work',true);const r=runtime.transport.requests(ext)[0];runtime.transport.accept(ext,{requestId:r.requestId,observation:observation({observedAt:now})});
  chat.configure('work',{enabled:true,mode:'scheduled',message:'계속 진행',intervalMinutes:1,hours:1,maxMessages:1});
  runtime.configure('work',{remainingWork:true,observationPermitted:true,executionPermitted:true});
  chat.pauseForMigration(ext,'session');
  return {store,bridge,chat,runtime,clock:t=>{now=t;},proof:c=>({requestId:c.requestId,sourceBindingFingerprint:BINDING,observation:observation({bindingFingerprint:target,observedAt:now}),
    samePhysicalTab:true,sameProject:true,sourceAuthored:true,firstReplyVerified:true,titleNPlusOneVerified:true,watchRetained:true}),
    close:()=>{runtime.close();store.close();}};
}

test('real migration challenge restores only existing authority and demands new post-resume observations',async()=>{
  const f=fixture();try{
    const cfg=f.chat.config('work'),resume=f.runtime.migrationResume,c=resume.challenge(ext,'session');assert.ok(c);
    assert.deepEqual(resume.challenge(ext,'session'),c,'polls cannot extend the challenge');
    f.clock(NOW+1000);assert.equal(await resume.accept(ext,'session',f.proof(c)),true);
    assert.equal(f.chat.resumeAfterMigration(ext,'session').resumed,true);
    const after=f.chat.config('work'),schedule=f.runtime.coordinator.get('work');
    for(const key of ['approvedAt','expiresAt','maxMessages','sentCount','message'])assert.equal(after[key],cfg[key]);
    assert.equal(schedule.binding_fingerprint,target);assert.equal(schedule.observation_after,NOW+1000);
    assert.equal(f.runtime.transport.latest('work'),null);assert.equal(f.chat.commands().length,0);
    await assert.rejects(()=>resume.accept(ext,'session',f.proof(c)),/CHALLENGE/);
  }finally{f.close();}
});

test('inactive watcher inventory is not permission; malformed enabled scopes and post-proof revocation fail closed',async()=>{
  const f=fixture();try{
    f.runtime.updateMigrationWatches(ext,[]);assert.equal(f.runtime.coordinator.context('work').scope.handoffPermitted,false);
    assert.equal(f.runtime.migrationResume.challenge(ext,'session'),null);
    assert.throws(()=>f.bridge.sync(ext,{version:1,sessions:[],migrationWatchSessionKeys:['session'],migrationEnabledSessionKeys:['other']},NOW),/활성/);
    f.runtime.updateMigrationWatches(ext,['session']);const c=f.runtime.migrationResume.challenge(ext,'session');
    await f.runtime.migrationResume.accept(ext,'session',f.proof(c));f.runtime.updateMigrationWatches(ext,[]);
    assert.equal(f.chat.resumeAfterMigration(ext,'session').resumed,false);assert.equal(f.chat.config('work').enabled,false);
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});

test('missing identity/DOM evidence cannot rebind, spend approval or replay a failed proof',async()=>{
  for(const patch of [{samePhysicalTab:false},{sameProject:false},{sourceAuthored:false},{firstReplyVerified:false},
    {titleNPlusOneVerified:false},{watchRetained:false},{sourceBindingFingerprint:target},
    {observation:observation({bindingFingerprint:BINDING})},{observation:observation({assistantBusy:true})},
    {observation:observation({composerHasDraft:true})},{observation:observation({verified:false})}]){
    const f=fixture();try{
      const c=f.runtime.migrationResume.challenge(ext,'session');
      await assert.rejects(()=>f.runtime.migrationResume.accept(ext,'session',{...f.proof(c),...patch}));
      assert.equal(f.chat.resumeAfterMigration(ext,'session').resumed,false);
      assert.equal(f.chat.config('work').sentCount,0);assert.equal(f.chat.commands().length,0);
      await assert.rejects(()=>f.runtime.migrationResume.accept(ext,'session',f.proof(c)),/CHALLENGE/);
    }finally{f.close();}
  }
});

test('cross-extension/session, expired and process-lost migration challenges fail closed',async()=>{
  for(const mutate of [f=>f.clock(NOW+60001),f=>f.runtime.migrationResume.pending.clear(),f=>f.runtime.updateMigrationWatches(ext,[])]){
    const f=fixture();try{const c=f.runtime.migrationResume.challenge(ext,'session');mutate(f);
      await assert.rejects(()=>f.runtime.migrationResume.accept(ext,'session',f.proof(c)),/CHALLENGE/);
    }finally{f.close();}
  }
  const f=fixture();try{const c=f.runtime.migrationResume.challenge(ext,'session');
    assert.equal(f.runtime.migrationResume.challenge('other','session'),null);
    await assert.rejects(()=>f.runtime.migrationResume.accept(ext,'different-session',f.proof(c)),/CHALLENGE/);
    await assert.rejects(()=>f.runtime.migrationResume.accept('other','session',f.proof(c)),/CHALLENGE/);
    assert.equal(f.runtime.coordinator.get('work').enabled,false);
  }finally{f.close();}
});

test('worker proof refuses unrelated same-project chats and missing authored/first-reply state',async()=>{
  const registry={groups:[{key:'group',groupId:3,windowId:2,sessionToken:'epoch'}],sessions:[{key:'session',groupKey:'group',tabId:1,sessionToken:'epoch',url:'https://chatgpt.com/g/g-p-owned/c/target'}]};
  const tab={id:1,groupId:3,windowId:2,url:registry.sessions[0].url};
  const snapshot={groups:[{id:3,windowId:2}],tabs:[tab]};
  const sourceUrl='https://chatgpt.com/g/g-p-owned/c/source',sourceBindingFingerprint=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['work','session',1,2,3,sourceUrl]))).then(b=>Buffer.from(b).toString('hex'));
  const c={workstreamId:'work',sessionKey:'session',requestId:'challenge',sourceBindingFingerprint,deadlineAt:NOW+1000};
  const state={stage:'resume_pending',sourceAuthored:true,sessionKey:'session',sourceTabId:1,targetTabId:1,windowId:2,groupId:3,projectId:'g-p-owned',sourceUrl,targetConversationUrl:tab.url,registryRebound:true,replyFingerprint:'reply',stableAt:NOW-7000,nextTitle:'Track 2'};
  const adapters={registry,snapshot,epoch:'epoch',watchRetained:true,now:()=>NOW,getTab:async()=>tab,execute:async r=>[{result:r.func.name==='inspectMigrationTarget'?{ok:true,projectConversation:true,busy:false,assistantCount:1,lastReplyFingerprint:'reply'}:
    r.func.name==='readRegisteredChatTitle'?{ok:true,title:'Track 2'}:observation({bindingFingerprint:target,observedAt:NOW})}]};
  assert.ok(await collectMigrationResumeProof(c,state,adapters));
  for(const patch of [{sourceAuthored:false},{targetTabId:99},{targetConversationUrl:'https://chatgpt.com/g/g-p-owned/c/other'},{projectId:'g-p-other'},{replyFingerprint:'wrong'}])
    assert.equal(await collectMigrationResumeProof(c,{...state,...patch},adapters),null);
});

test('migration failure Inbox is scoped, deduplicated and cannot resume or spend authority',()=>{
  const f=fixture();try{
    f.store.create({id:'sibling',name:'Sibling',projectKey:'project',repository:'owner/repo'},NOW);
    const before=f.chat.config('work'),resume=f.runtime.migrationResume;
    assert.throws(()=>resume.reportFailure('different-extension','session'),/SCOPE/);
    assert.throws(()=>resume.reportFailure(ext,'different-session'),/SCOPE/);
    const first=resume.reportFailure(ext,'session');assert.equal(first.reported,true);
    assert.deepEqual(resume.reportFailure(ext,'session'),first);
    const requests=f.runtime.inbox.list();assert.equal(requests.length,1);
    assert.equal(requests[0].workstreamId,'work');assert.equal(requests[0].reasonCode,'MIGRATION_NEEDS_ATTENTION');
    assert.equal(f.store.mustGet('work').paused,true);assert.equal(f.store.mustGet('sibling').paused,false);
    assert.equal(f.chat.config('work').enabled,false);assert.equal(f.chat.commands().length,0);
    for(const key of ['approvedAt','expiresAt','maxMessages','sentCount'])assert.equal(f.chat.config('work')[key],before[key]);
    f.store.db.prepare("UPDATE workstreams SET task_revision=task_revision+1 WHERE id='work'").run();
    assert.throws(()=>resume.reportFailure(ext,'session'),/SCOPE/,'stale checkpoints cannot pause a new task revision');
  }finally{f.close();}
});

test('a stale migration failure cannot pause a newly approved campaign',()=>{
  const f=fixture();try{
    f.chat.configure('work',{enabled:true,mode:'scheduled',message:'계속 진행',intervalMinutes:1,hours:1,maxMessages:1});
    assert.throws(()=>f.runtime.migrationResume.reportFailure(ext,'session'),/SCOPE/);
    assert.equal(f.store.mustGet('work').paused,false);assert.equal(f.chat.config('work').enabled,true);
    assert.equal(f.runtime.inbox.list().length,0);assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
