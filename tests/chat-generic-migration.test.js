import test from "node:test";
import assert from "node:assert/strict";
import {
  runGenericMigrations,readGenericMigrationState,GENERIC_PROGRESS_KEY,
  GENERIC_ATTEMPTS_KEY
} from "../extension/generic-migration.js";

function fixture({warning=true,hardCap=false,stopped=false,throwSend=false,offline=false,stopDuringTransfer=false}={}){
  const prior=globalThis.chrome;
  let now=100_000,epoch="session-epoch";
  const tab={id:4,windowId:2,groupId:-1,
    url:"https://chatgpt.com/c/source",title:"Plain Chat",status:"complete"};
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
        case "inspectChatLengthLimit": result={eligible:true,warning};break;
        case "inspectMigrationSource":result={ok:true,atLimit:hardCap,
          assistantCount:2,lastAssistantId:"old-assistant",lastUserId:"old-user"};break;
        case "captureLateLimitAssistant":result={ok:true,
          body:"Verified last assistant answer and current roadmap details. ".repeat(7)};break;
        case "submitToExistingChatGPT":
          if(throwSend)throw Error("uncertain");
          if(args[1]==="handoff"){
            assert.equal(tab.url,"https://chatgpt.com/");
            assert.equal(args[2],"/");
            assert.match(args[0],/AUTOPILOT_GENERIC_CHAT_HANDOFF/);
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
          if(stopDuringTransfer)stopped=true;
          result={ok:true,source:"EXACT_TRANSFER_USER_TURN"};break;
        case "inspectGenericFirstReply":
          result={ok:true,replyFingerprint:"first-assistant-answer"};break;
        default:throw Error("unexpected page read: "+func.name);
      }
      return [{result}];
    }},
    tabs:{update:async(id,{url})=>{
      assert.equal(id,4);
      assert.equal(url,"https://chatgpt.com/");
      tab.url=url;effects.push("navigated");
      return {...tab};
    }}
  };
  const targets=[{sessionKey:"plain",sourceKind:"chat-macro-general"}];
  const bridgeCommand=async (route,payload)=>{
    if(route.endsWith("/status")){
      if(offline)throw Error("BRIDGE_NETWORK_UNAVAILABLE");
      return {authenticated:true,stopped};
    }
    if(route.endsWith("/migration-pause")){
      assert.equal(payload.generic,true);
      effects.push("paused");return {macroSession:true,previouslyScheduled:true};
    }
    if(route.endsWith("/migration-resume")){
      assert.equal(payload.generic,true);
      effects.push("resumed");return {macroSession:true,resumed:true};
    }
    throw Error("invalid route "+route);
  };
  const syncRegistry=async()=>{effects.push("synced");return {connected:true}};
  const tick=(currentTargets=targets)=>runGenericMigrations({
    registry,snapshot:{groups:[],tabs:[tab]},epoch,targets:currentTargets,
    bridgeCommand,syncRegistry,now:()=>now
  });
  return {tab,tick,effects,targets,persistent,transient,getRegistry:()=>registry,
    state:()=>transient[GENERIC_PROGRESS_KEY]?.plain,
    advance:ms=>{now+=ms},stop:v=>{stopped=v},setOffline:v=>{offline=v},
    stopDuringTransfer:v=>{stopDuringTransfer=v},
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
    await f.tick();assert.equal(f.state().stage,"await_target");
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
    assert.equal(f.state().stage,"await_target");
    assert.equal(f.getRegistry().sessions[0].url,"https://chatgpt.com/c/source");
    f.stopDuringTransfer(false);f.stop(false);
    await f.tick();
    assert.equal(f.state().stage,"resync_target");
    assert.equal(f.getRegistry().sessions[0].url,f.tab.url);
  }finally{f.cleanup()}
});
