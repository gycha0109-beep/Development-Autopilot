import test from "node:test";
import assert from "node:assert/strict";
import {autoMigrationCommand,runAutoMigrations,AUTO_MIGRATION_KEY,
  AUTO_MIGRATION_PROGRESS_KEY,AUTO_MIGRATION_TEST_KEY} from "../extension/migration-auto.js";

function fixture(){
  const previous=globalThis.chrome;
  const token="epoch";
  const sourceUrl="https://chatgpt.com/g/g-p-saju-project/c/old";
  const group={id:8,windowId:4,title:"Saju"};
  const tabs=[{id:9,windowId:4,groupId:8,url:sourceUrl,title:"사주 범용화 및 권한 통합 3",status:"complete"}];
  let registry={
    version:1,
    groups:[{key:"group",groupId:8,windowId:4,sessionToken:token,paused:false}],
    sessions:[{key:"saju",groupKey:"group",tabId:9,sessionToken:token,url:sourceUrl,paused:false}]
  };
  const local={},session={};
  const calls=[],effects=[];
  let warning=true;
  let blockFirst=true;
  let initialReply="old assistant context";
  let renameOk=true;
  let stopped=false;
  let failStatus=false;
  let nextTabId=20;
  globalThis.chrome={
    storage:{
      local:{
        get:async key=>({[key]:local[key]}),
        set:async values=>{
          Object.assign(local,values);
          if(values["autopilot.registry.v1"])registry=values["autopilot.registry.v1"];
        }
      },
      session:{
        get:async key=>({[key]:session[key]}),
        set:async values=>Object.assign(session,values)
      }
    },
    scripting:{executeScript:async payload=>{
      const name=payload.func.name;
      calls.push({name,tab:payload.target.tabId,args:payload.args});
      let response;
      switch(name){
        case "inspectChatLengthLimit":response={eligible:true,warning};break;
        case "inspectMigrationSource":
          response={ok:true,assistantCount:2,atLimit:true};break;
        case "submitToExistingChatGPT":
          if(payload.target.tabId===9)response=blockFirst?
            {clicked:false,reason:"COMPOSER_NOT_FOUND"}:
            {clicked:true,reason:"SEND_BUTTON_CLICKED_UNVERIFIED"};
          else {
            assert.equal(payload.args[1],"handoff");
            assert.match(payload.args[0],/현행 로드맵/);
            response={clicked:true,reason:"SEND_BUTTON_CLICKED_UNVERIFIED"};
          }
          break;
        case "copyLastAssistantContext":
          response={ok:true,body:initialReply,truncated:false};break;
        case "copyLastMigrationAssistant":
          response={ok:true,body:"로드맵 이관 프롬프트".repeat(15)};break;
        case "inspectMigrationTarget":
          response={ok:true,projectConversation:true,busy:false,
            assistantCount:1,lastReplyFingerprint:"reply-final"};break;
        case "renameMigrationConversation":
          assert.equal(payload.args[0],"사주 범용화 및 권한 통합 4");
          response=renameOk?{ok:true,reason:"MIGRATION_TITLE_VERIFIED"}:
            {ok:false,reason:"MIGRATION_TITLE_CHAT_MENU_NOT_FOUND"};break;
        default:throw Error("Unexpected injected script: "+name);
      }
      return [{result:response}];
    }},
    tabs:{
      create:async ({windowId,url,active})=>{
        assert.equal(windowId,4);assert.equal(active,false);
        const tab={id:nextTabId++,windowId,groupId:-1,url,status:"complete"};
        tabs.push(tab);
        effects.push("tab-created");
        return tab;
      },
      group:async ({tabIds,groupId})=>{
        assert.equal(groupId,8);
        for(const tab of tabs.filter(t=>tabIds.includes(t.id)))tab.groupId=groupId;
        effects.push("tab-grouped");
      }
    },
    runtime:{}
  };
  const api=async(route,payload)=>{
    if(failStatus && route.endsWith("/status"))throw Error("BRIDGE_DISCONNECTED");
    if(route.endsWith("/status"))return {stopped};
    if(route.endsWith("/migration-pause")){
      assert.equal(payload.sessionKey,"saju");
      effects.push("schedule-paused");
      return {previouslyScheduled:true,workstreamId:"work"};
    }
    if(route.endsWith("/migration-resume")){
      assert.equal(payload.sessionKey,"saju");
      effects.push("schedule-resumed");
      return {resumed:true,workstreamId:"work"};
    }
    throw Error("Unexpected bridge "+route);
  };
  const tick=()=>runAutoMigrations({
    registry,snapshot:{groups:[group],tabs},epoch:token,
    bridgeCommand:api,syncRegistry:async()=>{
      effects.push("bridge-synced");return {connected:true};
    }
  });
  const configure=()=>autoMigrationCommand({
    type:"AP_AUTO_MIGRATION_CONFIG",sessionKey:"saju",enabled:true,
    repository:"owner/Saju",trackTitle:"사주 범용화 및 권한 통합 3"
  },{registry,snapshot:{groups:[group],tabs},epoch:token});
  return {
    configure,tick,calls,effects,tabs,local,session,
    state:()=>session[AUTO_MIGRATION_PROGRESS_KEY]?.saju,
    settings:()=>local[AUTO_MIGRATION_KEY]?.[0],
    setWarning:v=>warning=v,setStop:v=>stopped=v,
    setStatusFail:v=>failStatus=v,setRename:v=>renameOk=v,
    setFirst:v=>blockFirst=v,
    current:()=>registry,
    test:()=>autoMigrationCommand({type:"AP_AUTO_MIGRATION_TEST",sessionKey:"saju"},
      {registry,snapshot:{groups:[group],tabs},epoch:token}),
    cleanup:()=>{globalThis.chrome=previous}
  };
}
test("detected max-limit stops schedule immediately, auto-handoffs in same project, waits for answer, increments title and resumes",async()=>{
  const f=fixture();
  try {
    const config=await f.configure();
    assert.equal(config.tracks[0].enabled,true);
    await f.tick();
    assert.equal(f.state().stage,"request_pending");
    assert.deepEqual(f.effects,["schedule-paused"]);
    assert.equal(f.settings().lastTriggeredUrl,"https://chatgpt.com/g/g-p-saju-project/c/old");
    await f.tick();
    assert.equal(f.state().stage,"fallback_pending");
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
    await f.tick();
    assert.equal(f.state().stage,"awaiting_target_page");
    assert.equal(f.tabs.length,2);
    assert.equal(f.tabs[1].url,"https://chatgpt.com/g/g-p-saju-project/project");
    await f.tick();
    assert.equal(f.state().stage,"awaiting_first_reply");
    assert.equal(f.state().body,null);
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,2);
    f.tabs[1].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    await f.tick();
    assert.equal(f.state().stage,"awaiting_first_reply");
    assert.equal(f.calls.filter(c=>c.name==="renameMigrationConversation").length,0);
    f.state().stableAt=Date.now()-7000;
    await f.tick();
    assert.equal(f.state().stage,"rebind_pending");
    assert.equal(f.calls.filter(c=>c.name==="renameMigrationConversation").length,1);
    await f.tick();
    assert.equal(f.state().stage,"resync_pending");
    assert.equal(f.current().sessions[0].key,"saju");
    assert.equal(f.current().sessions[0].tabId,20);
    assert.equal(f.current().sessions[0].url,f.tabs[1].url);
    await f.tick();
    assert.equal(f.state().stage,"resume_pending");
    await f.tick();
    assert.equal(f.state().stage,"completed");
    assert.equal(f.settings().trackTitle,"사주 범용화 및 권한 통합 4");
    assert.ok(f.effects.indexOf("schedule-paused")<f.effects.indexOf("tab-created"));
    assert.ok(f.effects.indexOf("bridge-synced")<f.effects.indexOf("schedule-resumed"));
    assert.equal(f.effects.filter(x=>x==="schedule-resumed").length,1);
    f.setWarning(true);
    await f.tick();
    assert.equal(f.tabs.length,2); // No repeated migration on already-handled conversation
  }finally{f.cleanup()}
});
test("unpaired/STOP or missing warning never starts migration; interruption fails closed",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.setStop(true);
    await f.tick();
    assert.equal(f.state(),undefined);
    f.setStop(false);
    f.setWarning(false);
    await f.tick();
    assert.equal(f.state(),undefined);
    f.setWarning(true);
    await f.tick();
    await f.tick(); // source send blocked -> fallback
    f.state().stage="request_unknown"; // simulate a service-worker crash mid-click
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.state().reason,"INTERRUPTED_UNCERTAIN_NO_REPLAY");
    await f.tick();
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,1);
    f.setStatusFail(true);
    await f.tick(); // never repeats uncertain actions, offline
    assert.equal(f.tabs.length,1);
  }finally{f.cleanup()}
});
test("title rename ambiguity halts cutover without falsely resuming automatic messages",async()=>{
  const f=fixture();
  try{
    await f.configure();
    for(let i=0;i<5;i++)await f.tick();
    f.tabs[1].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    await f.tick();
    f.state().stableAt=Date.now()-7000;
    f.setRename(false);
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.state().reason,"MIGRATION_TITLE_CHAT_MENU_NOT_FOUND");
    assert.equal(f.effects.includes("schedule-resumed"),false);
    assert.equal(f.current().sessions[0].tabId,9);
  }finally{f.cleanup()}
});


test("explicit one-shot synthetic warning triggers real migration pipeline without a real limit banner",async()=>{
  const f=fixture();
  try {
    f.setWarning(false);
    await f.configure();
    const test=await f.test();
    assert.equal(test.accepted,true);
    assert.equal(test.reason,"ONE_SHOT_WARNING_SIMULATED_ON_NEXT_SYNC");
    assert.equal(f.session[AUTO_MIGRATION_TEST_KEY].saju.url,
      "https://chatgpt.com/g/g-p-saju-project/c/old");
    await assert.rejects(f.test(),/AUTO_MIGRATION_TEST_ALREADY_QUEUED/);
    await f.tick();
    assert.equal(f.state().stage,"request_pending");
    assert.equal(f.state().syntheticTrigger,true);
    assert.equal(f.effects[0],"schedule-paused");
    assert.equal(f.session[AUTO_MIGRATION_TEST_KEY].saju,undefined);
    // One actual migration, not a simulated transfer.
    await f.tick();
    assert.equal(f.calls.some(c=>c.name==="submitToExistingChatGPT"),true);
    await f.tick();
    await f.tick();
    assert.equal(f.effects.includes("tab-created"),true);
    assert.equal(f.tabs[1].url,"https://chatgpt.com/g/g-p-saju-project/project");
    await assert.rejects(f.test(),/AUTO_MIGRATION_TEST_ALREADY_USED_ON_CHAT/);
  }finally{f.cleanup()}
});

test("synthetic warning requires opt-in registered existing project chat; no hidden automatic trigger",async()=>{
  const f=fixture();
  try {
    f.setWarning(false);
    await assert.rejects(f.test(),/AUTO_MIGRATION_TEST_REQUIRES_ENABLED_TRACK/);
    await f.configure();
    await f.tick();
    assert.equal(f.state(),undefined);
    assert.equal(f.effects.length,0);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,0);
  }finally{f.cleanup()}
});

test("synthetic test token expires and cannot start after TTL",async()=>{
  const f=fixture();
  try {
    f.setWarning(false);
    await f.configure();
    await f.test();
    f.session[AUTO_MIGRATION_TEST_KEY].saju.createdAt=Date.now()-6*60*1000;
    await f.tick();
    assert.equal(f.state(),undefined);
    assert.equal(f.effects.length,0);
  }finally{f.cleanup()}
});
