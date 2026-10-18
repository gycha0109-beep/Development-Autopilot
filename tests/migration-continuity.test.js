import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatContinuation} from "../local/chat-continuation.js";
import {AutopilotCoordinator} from "../local/autopilot-coordinator.js";
import {CHAT_COMPOSER_BUILD} from "../extension/chat-page.js";
import {policy,observation,NOW,BINDING} from "../test-support/autopilot-fixture.js";

const ext="abcdefghijklmnopabcdefghijklmnop",targetBinding="d".repeat(64);
function fixture(patchProof={}){
  let now=NOW;
  const store=new WorkstreamStore();store.create({id:"work",name:"Work",projectKey:"project",repository:"owner/repo"},now);
  const targets=[];
  const watchtower={targets:{list:()=>targets},current:()=>({targets,results:[]}),refresh:async()=>{}};
  const github={targets:{list:()=>[]},current:()=>({targets:[],results:[]}),refresh:async()=>{}};
  const gate={one:()=>null};
  const bridge={getSnapshot:()=>({clients:[{extensionId:ext,status:"online",composerBuild:CHAT_COMPOSER_BUILD}],
    links:[{workstreamId:"work",extensionId:ext,sessionKey:"session",status:"connected"}],
    sessions:[{extensionId:ext,sessionKey:"session",status:"connected",origin:"https://chatgpt.com"}]})};
  const chat=new ChatContinuation(store,{bridge,watchtower,github,gate,now:()=>now});
  chat.configure("work",{enabled:true,mode:"scheduled",message:"계속 진행",intervalMinutes:1,hours:1,maxMessages:3});
  const coordinator=new AutopilotCoordinator(store,{chat,watchtower,github,gate,now:()=>now,
    observe:async()=>observation({observedAt:now}),verifyMigration:async request=>({...request,
      verified:true,bindingFingerprint:targetBinding,samePhysicalTab:true,sameProject:true,sourceAuthored:true,
      firstReplyVerified:true,titleNPlusOneVerified:true,watchRetained:true,observedAt:now,...patchProof})});
  coordinator.configure("work",{bindingFingerprint:BINDING,remainingWork:true,observationPermitted:true,executionPermitted:true,
    policy:{...policy,observationTimeoutMs:1000}});
  return {store,chat,coordinator,targets,clock:at=>{now=at;},pause:()=>chat.pauseForMigration(ext,"session"),
    resume:()=>chat.resumeAfterMigration(ext,"session")};
}

test("existing migration pause atomically checkpoints observation/CI clocks and cannot resume without fresh binding proof",async()=>{
  const f=fixture();try{
    f.store.db.prepare("UPDATE autopilot_schedules SET next_external_check_at=? WHERE workstream_id='work'").run(NOW+5000);
    const before=f.coordinator.get("work"),campaign=f.chat.config("work"),stream=f.store.get("work");
    assert.equal(f.pause().previouslyScheduled,true);
    const checkpoint=f.coordinator.migration.get("work");
    assert.equal(f.coordinator.get("work").enabled,false);assert.equal(f.chat.config("work").enabled,false);
    assert.equal(f.resume().reasonCode,"MIGRATION_OBSERVATION_BINDING_REQUIRED");
    f.pause();assert.equal(f.coordinator.migration.get("work").id,checkpoint.id);
    f.clock(NOW+1000);assert.equal(await f.coordinator.migration.verifyRebind("work"),true);
    assert.equal(f.resume().resumed,true);
    const restored=f.coordinator.get("work"),cfg=f.chat.config("work");
    assert.equal(restored.binding_fingerprint,targetBinding);assert.equal(restored.enabled,true);
    assert.equal(restored.next_external_check_at,NOW+6000);
    assert.equal(restored.next_inspect_at,NOW+1000);assert.equal(restored.policy.inspectIntervalMs,before.policy.inspectIntervalMs);
    assert.equal(cfg.expiresAt,campaign.expiresAt);assert.equal(cfg.sentCount,campaign.sentCount);
    assert.deepEqual(f.store.get("work"),stream);assert.deepEqual(f.targets,[]);
    assert.equal(f.coordinator.migration.get("work").status,"completed");
    assert.equal(f.coordinator.state.pending("work"),null);assert.equal(f.chat.commands().length,0);
  }finally{f.store.close();}
});

test("same-tab/project/source/first-reply/title/watch proof omissions all fail closed",async()=>{
  for(const patch of [{samePhysicalTab:false},{sameProject:false},{sourceAuthored:false},{firstReplyVerified:false},
    {titleNPlusOneVerified:false},{watchRetained:false},{bindingFingerprint:BINDING},{sourceBindingFingerprint:targetBinding},
    {sessionKey:"other"},{extensionId:"other"},{observedAt:NOW-1},{migrationId:"other"}]){
    const f=fixture(patch);try{f.pause();assert.equal(await f.coordinator.migration.verifyRebind("work"),false);
      assert.equal(f.resume().resumed,false);assert.equal(f.coordinator.get("work").enabled,false);
    }finally{f.store.close();}
  }
});

test("failed/unknown migration checkpoint, expired scope, changed target or changed campaign cannot reset or resume",async()=>{
  for(const mutate of [f=>{f.store.db.prepare("UPDATE autopilot_migrations SET status='unknown' WHERE workstream_id='work'").run();},
    f=>f.clock(NOW+3_600_001),f=>f.targets.push({workstreamId:"work",runId:22}),
    f=>{f.store.db.prepare("UPDATE chat_continuation_settings SET message='changed' WHERE workstream_id='work'").run();}]){
    const f=fixture();try{f.pause();const checkpoint=f.coordinator.migration.get("work");mutate(f);f.pause();
      assert.equal(f.coordinator.migration.get("work").id,checkpoint.id);
      assert.equal(await f.coordinator.migration.verifyRebind("work"),false);
      assert.equal(f.resume().resumed,false);assert.equal(f.chat.commands().length,0);
    }finally{f.store.close();}
  }
});

test("proof can expire before resume and missing adapter never authorizes restoration",async()=>{
  const f=fixture();try{f.pause();assert.equal(await f.coordinator.migration.verifyRebind("work"),true);
    f.clock(NOW+policy.maxAgeMs+1);assert.equal(f.resume().resumed,false);
  }finally{f.store.close();}
  const g=fixture();try{g.pause();g.coordinator.migration.verify=null;
    assert.equal(await g.coordinator.migration.verifyRebind("work"),false);assert.equal(g.resume().resumed,false);
    assert.throws(()=>g.store.deleteWorkstream("work","Work",NOW),/MIGRATION_IN_FLIGHT/);
  }finally{g.store.close();}
});
