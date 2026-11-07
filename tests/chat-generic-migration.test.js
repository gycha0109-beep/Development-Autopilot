import test from "node:test";
import assert from "node:assert/strict";
import {
  runGenericMigrations,readGenericMigrationState,GENERIC_PROGRESS_KEY,
  GENERIC_ATTEMPTS_KEY
} from "../extension/generic-migration.js";

function fixture({warning=true,hardCap=false,stopped=false,throwSend=false,offline=false,stopDuringTransfer=false,pauseOffline=false,syncOffline=false,fatal=false,project=false,noVerifiedContext=false,noTransferredProof=false,trackTitle="프론트"}={}){
  const prior=globalThis.chrome;
  let now=100_000,epoch="session-epoch";
  const tab={id:4,windowId:2,groupId:-1,
    url:project?"https://chatgpt.com/g/g-p-project123/c/source":
      "https://chatgpt.com/c/source",title:"Plain Chat",status:"complete"};
  let registry={version:1,groups:[],sessions:[{
    key:"plain",groupKey:"",tabId:4,windowId:2,url:tab.url,
    title:"Plain Chat",paused:false,sessionToken:epoch,enrolledAt:1
  }]};
  const persistent={},transient={},effects=[];
  const updateStorage=(obj,values)=>{Object.assign(obj,values);
    if(values["autopilot.registry.v1"])registry=values["autopilot.registry.v1"]};
  globalThis.chrome={
    storage:{
      local:{get:async k=>({[k]:persistent[k]}),
        set:async v=>updateStorage(persistent,v)},
      session:{get:async k=>({[k]:transient[k]}),
        set:async v=>updateStorage(transient,v)}
    },
    scripting:{executeScript:async ({target,func,args=[]})=>{
      assert.equal(target.tabId,4);
      effects.push(func.name);
      let result;
      switch(func.name){
        case "inspectUnknownChatError":result=fatal?
          {eligible:true,fatal:true,sourcePath:new URL(tab.url).pathname,
            projectId:project?"g-p-project123":null}:
          {eligible:false,fatal:false,reason:"UNKNOWN_ERROR_ACTION_NOT_VERIFIED"};break;
        case "inspectChatLengthLimit": result={eligible:true,warning};break;
        case "inspectMigrationSource":result={ok:true,atLimit:hardCap,
          assistantCount:2,lastAssistantId:"old-assistant",lastUserId:"old-user"};break;
        case "captureLateLimitAssistant":result=noVerifiedContext?
          {ok:false,reason:"NO_VERIFIED_REPLY"}:{ok:true,
          body:"Verified last assistant answer and current roadmap details. ".repeat(7)};break;
        case "submitToExistingChatGPT":
          if(throwSend)throw Error("uncertain");
          if(args[1]==="handoff"){
            assert.equal(tab.url,project?
              "https://chatgpt.com/g/g-p-project123":"https://chatgpt.com/");
            assert.equal(args[2],project?"/g/g-p-project123":"/");
            assert.match(args[0],/AUTOPILOT_GENERIC_CHAT_HANDOFF/);
            assert.ok(args[0].includes("AUTOPILOT_TRACK_LOCK_V1 "));
            assert.ok(args[0].includes(" :: "+trackTitle));
            assert.ok(args[0].includes("AUTOPILOT_TRACK_ACK "));
            assert.match(args[0],/다른 트랙/);
            if(fatal){
              assert.match(args[0],/WORKLOG/);
              assert.match(args[0],/ROADMAP/);
              if(project)assert.match(args[0],/owner\/project/);
              assert.match(args[0],/Do NOT request @migration/);
            }
          }else{
            assert.equal(args[1],"continuation");
            assert.equal(tab.url,"https://chatgpt.com/c/source");
            assert.match(args[0],/AUTOPILOT_GENERIC_REQUEST_V1/);
            assert.ok(args[0].length<=800);
          }
          result={clicked:true,reason:"SINGLE_CLICK"};break;
        case "captureGenericHandoff":
          result={ok:true,body:"Confirmed goals, decisions, current state, unfinished tasks. ".repeat(7)};break;
        case "inspectGenericTransferredChat":
          assert.equal(args[2],project?"g-p-project123":null);
          assert.equal(args[3],trackTitle);
          if(stopDuringTransfer)stopped=true;
          result=noTransferredProof?{ok:false,reason:"TRANSFER_HANDOFF_NOT_VERIFIED"}:
            {ok:true,source:"EXACT_TRANSFER_USER_TURN"};break;
        case "inspectGenericFirstReply":
          assert.equal(args[2],project?"g-p-project123":null);
          assert.equal(args[3],trackTitle);
          result={ok:true,replyFingerprint:"first-assistant-answer"};break;
        default:throw Error("unexpected page read: "+func.name);
      }
      return [{result}];
    }},
    tabs:{update:async(id,{url})=>{
      assert.equal(id,4);
      assert.equal(url,project?
        "https://chatgpt.com/g/g-p-project123":"https://chatgpt.com/");
      tab.url=url;effects.push("navigated");
      return {...tab};
    }}
  };
  const targets=[{sessionKey:"plain",sourceKind:"chat-macro-general",
    migrationStatus:"armed",trackTitle,repository:project?"owner/project":null}];
  const bridgeCommand=async (route,payload)=>{
    if(route.endsWith("/status")){
      if(offline)throw Error("BRIDGE_NETWORK_UNAVAILABLE");
      return {authenticated:true,stopped};
    }
    if(route.endsWith("/migration-pause")){
      if(pauseOffline)throw Error("BRIDGE_NETWORK_UNAVAILABLE");
      assert.equal(payload.generic,true);
      effects.push("paused");return {macroSession:true,previouslyScheduled:true};
    }
    if(route.endsWith("/migration-resume")){
      assert.equal(payload.generic,true);
      effects.push("resumed");return {macroSession:true,resumed:true};
    }
    throw Error("invalid route "+route);
  };
  const syncRegistry=async()=>{
    if(syncOffline)throw Error("BRIDGE_NETWORK_UNAVAILABLE");
    effects.push("synced");return {connected:true};
  };
  const tick=(currentTargets=targets)=>runGenericMigrations({
    registry,snapshot:{groups:[],tabs:[tab]},epoch,targets:currentTargets,
    bridgeCommand,syncRegistry,now:()=>now
  });
  return {tab,tick,effects,targets,persistent,transient,getRegistry:()=>registry,
    state:()=>transient[GENERIC_PROGRESS_KEY]?.plain,
    advance:ms=>{now+=ms},stop:v=>{stopped=v},setOffline:v=>{offline=v},
    stopDuringTransfer:v=>{stopDuringTransfer=v},
    setPauseOffline:v=>{pauseOffline=v},setSyncOffline:v=>{syncOffline=v},
    resetSession:()=>{delete transient[GENERIC_PROGRESS_KEY]},
    cleanup:()=>{globalThis.chrome=prior}};
}
test("standalone ordinary chat automatically migrates and rebinds with no Workstream or Chrome group",async()=>{
  const f=fixture();
  try{
    await f.tick();assert.equal(f.state().stage,"source_ready");
    await f.tick();assert.equal(f.state().stage,"await_source_reply");
    await f.tick();assert.equal(f.state().stage,"await_source_reply");
    f.advance(7000);
    await f.tick();assert.equal(f.state().stage,"ready_to_navigate");
    await f.tick();assert.equal(f.state().stage,"target_home");
    await f.tick();assert.equal(f.state().stage,"await_target",JSON.stringify(f.state()));
    f.tab.url="https://chatgpt.com/c/created";
    await f.tick();assert.equal(f.state().stage,"resync_target");
    assert.equal(f.getRegistry().sessions[0].url,f.tab.url);
    assert.equal(f.getRegistry().sessions[0].groupKey,"");
    assert.equal(f.getRegistry().groups.length,0);
    await f.tick();assert.equal(f.state().stage,"await_target_reply");
    await f.tick();assert.equal(f.state().stage,"await_target_reply");
    f.advance(7000);
    await f.tick();assert.equal(f.state().stage,"completed");
    assert.deepEqual(f.effects.filter(x=>x==="submitToExistingChatGPT").length,2);
    assert.equal(f.effects.filter(x=>x==="resumed").length,1);
    assert.ok(f.effects.indexOf("paused")<f.effects.indexOf("navigated"));
    assert.ok(f.effects.indexOf("synced")<f.effects.indexOf("resumed"));
    assert.equal((await readGenericMigrationState())[0].stage,"completed");
    await f.tick();assert.equal(f.effects.filter(x=>x==="resumed").length,1);
  }finally{f.cleanup()}
});
test("macro opt-out, global stop, and missing warning prevent any migration writes",async()=>{
  for(const options of [{warning:false},{stopped:true}]){
    const f=fixture(options);
    try{await f.tick();assert.equal(f.state(),undefined);
      assert.equal(f.effects.includes("paused"),false);}
    finally{f.cleanup()}
  }
  const f=fixture();
  try{await f.tick([]);assert.equal(f.state(),undefined);
    assert.equal(f.persistent[GENERIC_ATTEMPTS_KEY],undefined);}
  finally{f.cleanup()}
});
test("hard cap uses verified final assistant evidence without sending old chat prompt",async()=>{
  const f=fixture({hardCap:true});
  try{
    await f.tick();assert.equal(f.state().stage,"late_capture");
    await f.tick();assert.equal(f.state().stage,"ready_to_navigate");
    assert.equal(f.state().limited,true);
    assert.equal(f.effects.includes("captureLateLimitAssistant"),true);
    assert.equal(f.effects.includes("submitToExistingChatGPT"),false);
  }finally{f.cleanup()}
});
test("uncertain source send cannot be retried on future heartbeat",async()=>{
  const f=fixture({throwSend:true});
  try{
    await f.tick();await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.state().reason,"uncertain");
    const sends=f.effects.filter(x=>x==="submitToExistingChatGPT").length;
    await f.tick();assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,sends);
    assert.ok(f.persistent[GENERIC_ATTEMPTS_KEY].plain);
  }finally{f.cleanup()}
});
test("global stop halts resumed in-flight migration, retaining state for later",async()=>{
  const f=fixture();
  try{
    await f.tick();f.stop(true);
    await f.tick();assert.equal(f.state().stage,"source_ready");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,0);
    f.stop(false);await f.tick();
    assert.equal(f.state().stage,"await_source_reply");
  }finally{f.cleanup()}
});

test("temporary localhost outage waits and then resumes automatic handoff without manual reset",async()=>{
  const f=fixture();
  try{
    await f.tick();assert.equal(f.state().stage,"source_ready");
    f.setOffline(true);
    await f.tick();
    assert.equal(f.state().stage,"source_ready");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,0);
    f.setOffline(false);
    await f.tick();
    assert.equal(f.state().stage,"await_source_reply");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,1);
  }finally{f.cleanup()}
});

test("global stop during transferred-message verification prevents rebinding until safe",async()=>{
  const f=fixture({stopDuringTransfer:true});
  try{
    await f.tick();await f.tick();await f.tick();
    f.advance(7000);await f.tick();
    await f.tick();await f.tick();
    f.tab.url="https://chatgpt.com/c/after-handoff";
    await f.tick();
    assert.equal(f.state().stage,"await_target",JSON.stringify(f.state()));
    assert.equal(f.getRegistry().sessions[0].url,"https://chatgpt.com/c/source");
    f.stopDuringTransfer(false);f.stop(false);
    await f.tick();
    assert.equal(f.state().stage,"resync_target");
    assert.equal(f.getRegistry().sessions[0].url,f.tab.url);
  }finally{f.cleanup()}
});

test("browser restart with missing migration progress never silently repeats a sent handoff",async()=>{
  const f=fixture();
  try{
    await f.tick();assert.equal(f.state().stage,"source_ready");
    f.resetSession();
    const restarted=f.targets.map(t=>({...t,migrationStatus:"migrating"}));
    const events=await f.tick(restarted);
    assert.equal(events[0].stage,"needs_attention");
    assert.equal(events[0].reason,"MIGRATION_PROGRESS_LOST_NO_REPLAY");
    assert.equal(f.effects.includes("submitToExistingChatGPT"),false);
    assert.equal(f.effects.includes("navigated"),false);
  }finally{f.cleanup()}
});
test("migration pauses retry after temporary transport failure without manual reset",async()=>{
  const f=fixture({pauseOffline:true});
  try{
    await f.tick();assert.equal(f.state().stage,"pause_pending");
    await f.tick();assert.equal(f.state().stage,"pause_pending");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,0);
    f.setPauseOffline(false);
    await f.tick();assert.equal(f.state().stage,"source_ready");
    await f.tick();assert.equal(f.state().stage,"await_source_reply");
  }finally{f.cleanup()}
});
test("resync outage after exact target rebind waits and resumes from the same stage",async()=>{
  const f=fixture({syncOffline:true});
  try{
    await f.tick();await f.tick();await f.tick();
    f.advance(7000);await f.tick();
    await f.tick();await f.tick();
    f.tab.url="https://chatgpt.com/c/created";
    await f.tick();
    assert.equal(f.state().stage,"resync_target");
    await f.tick();assert.equal(f.state().stage,"resync_target");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,2);
    f.setSyncOffline(false);
    await f.tick();assert.equal(f.state().stage,"await_target_reply");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,2);
  }finally{f.cleanup()}
});

test("Unknown error bypasses old chat @handoff and migrates same project after independent context read",async()=>{
  const f=fixture({fatal:true,project:true});
  try{
    await f.tick();assert.equal(f.state().stage,"unknown_context_capture");
    assert.equal(f.state().reason,"UNKNOWN_ERROR_DIRECT_RECOVERY");
    assert.equal(f.state().projectId,"g-p-project123");
    await f.tick();assert.equal(f.state().stage,"ready_to_navigate");
    assert.equal(f.state().contextVerified,true);
    assert.equal(f.state().trackTitle,"프론트");
    assert.equal(f.effects.includes("captureGenericHandoff"),false);
    await f.tick();assert.equal(f.state().stage,"target_home");
    await f.tick();assert.equal(f.state().stage,"await_target",JSON.stringify(f.state()));
    const sent=f.effects.filter(x=>x==="submitToExistingChatGPT");
    assert.equal(sent.length,1); // New project only, never the broken chat.
    f.tab.url="https://chatgpt.com/g/g-p-project123/c/after-recovery";
    await f.tick();assert.equal(f.state().stage,"resync_target");
    assert.equal(f.getRegistry().sessions[0].url,f.tab.url);
    await f.tick();assert.equal(f.state().stage,"await_target_reply");
    await f.tick();f.advance(7000);await f.tick();
    assert.equal(f.state().stage,"completed");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,1);
    assert.equal(f.effects.filter(x=>x==="resumed").length,1);
  }finally{f.cleanup();}
});
test("Unknown error with no readable source still starts new chat with explicitly incomplete context",async()=>{
  const f=fixture({fatal:true,noVerifiedContext:true,warning:false});
  try{
    await f.tick();assert.equal(f.state().stage,"unknown_context_capture");
    await f.tick();
    assert.equal(f.state().stage,"ready_to_navigate");
    assert.equal(f.state().body,null);
    assert.equal(f.state().contextVerified,false);
    await f.tick();await f.tick();
    assert.equal(f.state().stage,"await_target",JSON.stringify(f.state()));
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,1);
    assert.equal(f.effects.includes("captureGenericHandoff"),false);
    assert.equal(f.effects.includes("inspectMigrationSource"),false);
  }finally{f.cleanup();}
});
test("Unknown error respects global stop and never creates target or submits when stopped",async()=>{
  const f=fixture({fatal:true,stopped:true});
  try{
    await f.tick();
    assert.equal(f.state(),undefined);
    assert.equal(f.effects.includes("navigated"),false);
    assert.equal(f.effects.includes("submitToExistingChatGPT"),false);
  }finally{f.cleanup();}
});
test("Unknown error uncertain navigation never reruns another browser side effect",async()=>{
  const f=fixture({fatal:true,noVerifiedContext:true});
  try{
    await f.tick();await f.tick();await f.tick();
    assert.equal(f.state().stage,"target_home");
    f.resetSession();
    const targets=f.targets.map(x=>({...x,migrationStatus:"migrating"}));
    const events=await f.tick(targets);
    assert.equal(events[0].stage,"needs_attention");
    assert.equal(f.effects.filter(x=>x==="navigated").length,1);
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,0);
  }finally{f.cleanup();}
});

test("Unknown error recovery reconciles an already transferred target chat without resending",async()=>{
  const f=fixture({fatal:true,project:true});
  try{
    await f.tick();await f.tick();await f.tick();
    assert.equal(f.state().stage,"target_home");
    f.tab.url="https://chatgpt.com/g/g-p-project123/c/already-transferred";
    await f.tick();
    assert.equal(f.state().stage,"await_target",JSON.stringify(f.state()));
    assert.equal(f.state().reason,"GENERIC_TARGET_ALREADY_TRANSFERRED_VERIFIED");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,0);
    await f.tick();
    assert.equal(f.state().stage,"resync_target");
    assert.equal(f.getRegistry().sessions[0].url,f.tab.url);
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,0);
  }finally{f.cleanup();}
});
test("Unknown error moved to unrelated project chat refuses any duplicate handoff",async()=>{
  const f=fixture({fatal:true,project:true,noTransferredProof:true});
  try{
    await f.tick();await f.tick();await f.tick();
    assert.equal(f.state().stage,"target_home");
    f.tab.url="https://chatgpt.com/g/g-p-project123/c/unverified";
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.state().reason,"GENERIC_TARGET_CHANGED_NO_TRANSFER_PROOF");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,0);
    await f.tick();
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,0);
  }finally{f.cleanup();}
});
test("Unknown error stalled project landing cannot wait forever",async()=>{
  const f=fixture({fatal:true,project:true});
  try{
    await f.tick();await f.tick();await f.tick();
    assert.equal(f.state().stage,"target_home");
    f.tab.status="loading";
    f.advance(121_000);
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.state().reason,"GENERIC_TARGET_HOME_LOADING_TIMEOUT");
    assert.equal(f.effects.filter(x=>x==="submitToExistingChatGPT").length,0);
  }finally{f.cleanup();}
});

test("Unknown error refuses to infer a track from a shared GitHub repository",async()=>{
 const f=fixture({fatal:true,project:true,trackTitle:null});
 try{
   const events=await f.tick();
   assert.equal(events[0].reason,"GENERIC_TRACK_BINDING_REQUIRED");
   assert.equal(f.state(),undefined);
   assert.equal(f.effects.length,0);
 }finally{f.cleanup();}
});
test("legacy unscoped frontend migration cannot continue or replay its old handoff",async()=>{
 const f=fixture({fatal:true,project:true,trackTitle:"프론트"});
 try{
   await f.tick();await f.tick();
   assert.equal(f.state().stage,"ready_to_navigate");
   delete f.state().trackTitle;
   const events=await f.tick();
   assert.equal(events[0].reason,"GENERIC_TRACK_IDENTITY_MISMATCH_NO_REPLAY");
   assert.equal(f.state().stage,"needs_attention");
   assert.equal(f.effects.includes("navigated"),false);
   assert.equal(f.effects.includes("submitToExistingChatGPT"),false);
 }finally{f.cleanup();}
});
test("changed auto-migration binding cannot resume another track in a shared project",async()=>{
 const f=fixture({fatal:true,project:true,trackTitle:"프론트"});
 try{
   await f.tick();await f.tick();
   const different=f.targets.map(x=>({...x,trackTitle:"챗봇 장기기억"}));
   const events=await f.tick(different);
   assert.equal(events[0].reason,"GENERIC_TRACK_IDENTITY_MISMATCH_NO_REPLAY");
   assert.equal(f.state().stage,"needs_attention");
   assert.equal(f.effects.includes("navigated"),false);
 }finally{f.cleanup();}
});
