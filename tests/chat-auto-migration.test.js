import test from "node:test";
import assert from "node:assert/strict";
import {autoMigrationCommand,runAutoMigrations,AUTO_MIGRATION_KEY,
  AUTO_MIGRATION_PROGRESS_KEY,AUTO_MIGRATION_TEST_KEY,
  AUTO_MIGRATION_REMOVED_URLS_KEY,cleanupAutoMigrationWatchers,
  getAutoMigrationWatchSessionKeys} from "../extension/migration-auto.js";
import {eligibleAutoMigrationSessions} from "../extension/migration-auto-ui.js";

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
  let blockFirst=false;
  let sourceReplyReady=false;
  let unattributed=false;
  let unstructured=false;
  let writingBlock=false;
  let sourceContextMatches=true;
  let renameOk=true;
  let handoffProof=true;
  let titleDomUnreadable=false;
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
        case "readRegisteredChatTitle":
          response=payload.args?.[0] && titleDomUnreadable?
            {ok:false,reason:"CHAT_TITLE_NO_MATCHING_CONVERSATION_LINK",
              diagnostic:{
                currentConversationLinks:0,sidebarConversationLinks:0,
                renderedConversationLinks:0,numberedTitleCandidates:0,
                browserTitleNumbered:true,expectedInLinkedTitle:false,
                expectedInBrowserTitle:false}}:
            payload.args?.[0] && payload.args[0]!==tabs[0].title?
            {ok:false,reason:"CHAT_TITLE_LINK_TITLE_MISMATCH",diagnostic:{
              currentConversationLinks:1,sidebarConversationLinks:1,
              renderedConversationLinks:1,numberedTitleCandidates:1,
              browserTitleNumbered:false,expectedInLinkedTitle:false,
              expectedInBrowserTitle:false}}:
            {ok:true,title:tabs[0].title,source:"chat-sidebar-exact"};
          break;
        case "inspectChatLengthLimit":response={eligible:true,warning};break;
        case "inspectAuthoredHandoffDomShape":
          response={ok:true,readOnly:true,version:1,
            counts:{markers:2,requests:2,pre:0,code:0,textNodes:328}};
          break;
        case "inspectMigrationSource":
          response={ok:true,assistantCount:2,atLimit:true,
            lastAssistantId:"assistant-before",lastUserId:"user-before"};break;
        case "submitToExistingChatGPT":
          assert.equal(payload.target.tabId,9);
          if(payload.args?.[1]==="handoff"){
            assert.match(payload.args[0],/현행 로드맵/);
            response={clicked:true,reason:"SEND_BUTTON_CLICKED_UNVERIFIED"};
          }else{
            response=blockFirst?{clicked:false,reason:"COMPOSER_NOT_FOUND"}:
              {clicked:true,reason:"SEND_BUTTON_CLICKED_UNVERIFIED"};
          }
          break;
        case "copyLastMigrationAssistant":
          if(payload.args?.[6]){
            assert.deepEqual(payload.args[6],{
              repository:"owner/Saju",trackTitle:"사주 범용화 및 권한 통합 3"
            });
          }
          response=!sourceContextMatches && payload.args?.[6]?
            {ok:false,reason:"MIGRATION_SOURCE_REQUEST_MISMATCH"}:
            sourceReplyReady?
            {ok:true,body:"원본 대화가 작성한 실제 이관 프롬프트 · 현행 로드맵 근거 ".repeat(15),
              sourceContextVerified:!!payload.args?.[6],
              evidence:writingBlock?"UNATTRIBUTED_SOURCE_REQUEST_WRITING_BLOCK":
                unstructured?"UNATTRIBUTED_SOURCE_REQUEST_MARKER_TEXT":
                unattributed?"UNATTRIBUTED_SOURCE_REQUEST_MARKER_CODEBLOCK":payload.args?.[0]===null?
                (payload.args?.[3]?"NEW_ASSISTANT_ID":"ORIGINAL_USER_REQUEST_PRECEDES_ASSISTANT"):"NEW_ASSISTANT_COUNT"}:
            {ok:false,reason:"MIGRATION_NEW_RESPONSE_NOT_FOUND"};break;
        case "inspectAlreadyTransferredHandoff":
          assert.deepEqual(payload.args,[
            "AUTOPILOT_MIGRATION_HANDOFF","owner/Saju",
            "사주 범용화 및 권한 통합 3","사주 범용화 및 권한 통합 4"
          ]);
          response=handoffProof?
            {ok:true,evidence:"VISIBLE_TRANSFERRED_HANDOFF_CONTEXT"}:
            {ok:false,reason:"MIGRATION_REPAIR_HANDOFF_PROVENANCE_NOT_VISIBLE"};
          break;
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
      create:async ()=>{
        throw Error("SAME_TAB_MIGRATION_MUST_NOT_CREATE_TABS");
      },
      update:async (id,{url})=>{
        assert.equal(id,9);
        assert.equal(url,"https://chatgpt.com/g/g-p-saju-project/project");
        const tab=tabs.find(t=>t.id===id);
        tab.url=url;
        tab.status="complete";
        effects.push("tab-navigated");
        return tab;
      },
      group:async ()=>{throw Error("SAME_TAB_MIGRATION_MUST_NOT_REGROUP_TABS");}
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
    setHandoffProof:v=>handoffProof=v,
    setTitleDomUnreadable:v=>titleDomUnreadable=v,
    setFirst:v=>blockFirst=v,setSourceReply:v=>sourceReplyReady=v,
    setUnattributed:v=>unattributed=v,
    setUnstructured:v=>unstructured=v,
    setWritingBlock:v=>writingBlock=v,
    setSourceContextMatches:v=>sourceContextMatches=v,
    current:()=>registry,
    test:()=>autoMigrationCommand({type:"AP_AUTO_MIGRATION_TEST",sessionKey:"saju"},
      {registry,snapshot:{groups:[group],tabs},epoch:token}),
    inspect:()=>autoMigrationCommand({type:"AP_AUTO_MIGRATION_INSPECT",sessionKey:"saju"},
      {registry,snapshot:{groups:[group],tabs},epoch:token}),
    start:(confirm=true)=>autoMigrationCommand({type:"AP_AUTO_MIGRATION_START",
      sessionKey:"saju",confirm},{registry,snapshot:{groups:[group],tabs},epoch:token}),
    reset:(confirm=true)=>autoMigrationCommand({type:"AP_AUTO_MIGRATION_RESET_FAILED",
      sessionKey:"saju",confirm},{registry,snapshot:{groups:[group],tabs},epoch:token}),
    recover:(confirm=true)=>autoMigrationCommand({type:"AP_AUTO_MIGRATION_RECOVER",
      sessionKey:"saju",confirm},{registry,snapshot:{groups:[group],tabs},epoch:token}),
    confirmReply:(confirm=true)=>autoMigrationCommand({
      type:"AP_AUTO_MIGRATION_CONFIRM_FIRST_REPLY",sessionKey:"saju",confirm
    },{registry,snapshot:{groups:[group],tabs},epoch:token}),
    confirmTitle:(confirm=true,operatorTitle)=>autoMigrationCommand({
      type:"AP_AUTO_MIGRATION_CONFIRM_TITLE",sessionKey:"saju",confirm,
      operatorTitle
    },{registry,snapshot:{groups:[group],tabs},epoch:token}),
    view:()=>autoMigrationCommand({type:"AP_AUTO_MIGRATION_STATE"},
      {registry,snapshot:{groups:[group],tabs},epoch:token}),
    diagnose:()=>autoMigrationCommand({type:"AP_AUTO_MIGRATION_DOM_DIAGNOSE",
      sessionKey:"saju"},{registry,snapshot:{groups:[group],tabs},epoch:token}),
    remove:(confirm=true)=>autoMigrationCommand({
      type:"AP_AUTO_MIGRATION_REMOVE",sessionKey:"saju",confirm},
      {registry,snapshot:{groups:[group],tabs},epoch:token}),
    simulateWorkerReload:()=>{delete session[AUTO_MIGRATION_PROGRESS_KEY]},
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
    assert.equal(f.state().stage,"awaiting_source_reply");
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,1);
    await f.tick();
    assert.equal(f.state().stage,"awaiting_source_reply");
    assert.equal(f.tabs.length,1);
    f.setSourceReply(true);
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
    assert.match(f.state().body,/원본 대화가 작성한 실제 이관 프롬프트/);
    await f.tick();
    assert.equal(f.state().stage,"awaiting_target_page");
    assert.equal(f.tabs.length,1);
    assert.equal(f.tabs[0].url,"https://chatgpt.com/g/g-p-saju-project/project");
    await f.tick();
    assert.equal(f.state().stage,"awaiting_first_reply");
    assert.equal(f.state().body,null);
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,2);
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    await f.tick();
    assert.equal(f.state().stage,"awaiting_first_reply");
    assert.equal(f.calls.filter(c=>c.name==="renameMigrationConversation").length,0);
    f.state().stableAt=Date.now()-7000;
    await f.tick();
    assert.equal(f.state().stage,"rename_pending");
    await f.tick();
    assert.equal(f.state().stage,"rebind_pending");
    assert.equal(f.calls.filter(c=>c.name==="renameMigrationConversation").length,1);
    await f.tick();
    assert.equal(f.state().stage,"resync_pending");
    assert.equal(f.current().sessions[0].key,"saju");
    assert.equal(f.current().sessions[0].tabId,9);
    assert.equal(f.current().sessions[0].url,f.tabs[0].url);
    assert.equal(f.current().sessions[0].title,"사주 범용화 및 권한 통합 4");
    await f.tick();
    assert.equal(f.state().stage,"resume_pending");
    await f.tick();
    assert.equal(f.state().stage,"completed");
    assert.equal(f.settings().trackTitle,"사주 범용화 및 권한 통합 4");
    assert.ok(f.effects.indexOf("schedule-paused")<f.effects.indexOf("tab-navigated"));
    assert.ok(f.effects.indexOf("bridge-synced")<f.effects.indexOf("schedule-resumed"));
    assert.equal(f.effects.filter(x=>x==="schedule-resumed").length,1);
    f.setWarning(true);
    await f.tick();
    assert.equal(f.tabs.length,1); // No repeated migration on already-handled conversation
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
    assert.equal(f.state().stage,"request_pending");
    f.state().stage="request_unknown"; // simulate a service-worker crash mid-click
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.state().reason,"INTERRUPTED_UNCERTAIN_NO_REPLAY");
    await f.tick();
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,0);
    f.setStatusFail(true);
    await f.tick(); // never repeats uncertain actions, offline
    assert.equal(f.tabs.length,1);
  }finally{f.cleanup()}
});
test("title rename ambiguity halts cutover without falsely resuming automatic messages",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick(); // detect
    await f.tick(); // ask source to author handoff
    f.setSourceReply(true);
    await f.tick(); // capture ONLY author's response
    await f.tick(); // create target
    await f.tick(); // send handoff
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    await f.tick();
    f.state().stableAt=Date.now()-7000;
    f.setRename(false);
    await f.tick();
    assert.equal(f.state().stage,"rename_pending");
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
    assert.equal(f.state().stage,"awaiting_source_reply");
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,1);
    await f.tick();
    assert.equal(f.tabs.length,1,"No new project chat before original ChatGPT handoff");
    f.setSourceReply(true);
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
    await f.tick();
    assert.equal(f.effects.includes("tab-navigated"),true);
    assert.equal(f.tabs[0].url,"https://chatgpt.com/g/g-p-saju-project/project");
    await assert.rejects(f.test(),/AUTO_MIGRATION_TEST_REQUIRES_CONNECTED_PROJECT_CHAT/);
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

test("actual max warning does not fabricate handoff or create project when original source cannot send",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.setFirst(true);
    await f.tick();
    assert.equal(f.state().stage,"request_pending");
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.match(f.state().reason,/SOURCE_MIGRATION_REQUEST_NOT_SENT_COMPOSER_NOT_FOUND/);
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(x=>x.name==="copyLastAssistantContext").length,0);
    for(let i=0;i<5;i++)await f.tick();
    assert.equal(f.tabs.length,1);
    assert.equal(f.effects.includes("schedule-resumed"),false);
  }finally{f.cleanup()}
});
test("legacy fallback stage cannot silently fabricate a replacement prompt",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick();
    f.state().stage="fallback_pending";
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.state().reason,"LEGACY_FALLBACK_REMOVED_SOURCE_HANDOFF_REQUIRED");
    assert.equal(f.tabs.length,1);
  }finally{f.cleanup()}
});

test("operator can reset failed original handoff but cannot reset an in-flight source request",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await assert.rejects(f.reset(),/AUTO_MIGRATION_RESET_REQUIRES_FAILED_TRACK/);
    await f.tick();
    await assert.rejects(f.reset(),/AUTO_MIGRATION_RESET_REQUIRES_FAILED_TRACK/);
    f.setFirst(true);
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    await assert.rejects(f.reset(false),/AUTO_MIGRATION_RESET_CONFIRM_REQUIRED/);
    const cleaned=await f.reset(true);
    assert.equal(cleaned.reset,true);
    assert.equal(f.state(),undefined);
    assert.equal(f.settings().lastTriggeredUrl,null);
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,1);
    // Retry is an explicit new decision. No old command was replayed.
    f.setFirst(false);
    await f.tick();
    assert.equal(f.state().stage,"request_pending");
    await f.tick();
    assert.equal(f.state().stage,"awaiting_source_reply");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,2);
  }finally{f.cleanup()}
});
test("no response from original chat never copies last unrelated reply or creates new project chat",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick(); // detect
    await f.tick(); // send original authoring request
    assert.equal(f.state().stage,"awaiting_source_reply");
    f.state().startedAt=Date.now()-11*60_000;
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.match(f.state().reason,/SOURCE_MIGRATION_RESPONSE_NOT_RECEIVED/);
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(x=>x.name==="copyLastAssistantContext").length,0);
  }finally{f.cleanup()}
});

test("Face Lab manual inspection reports missing warning; explicit start still asks original source first",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.setWarning(false);
    const inspected=await f.inspect();
    assert.equal(inspected.eligible,true);
    assert.equal(inspected.warning,false);
    assert.equal(inspected.sourceTitle,"사주 범용화 및 권한 통합 3");
    await f.tick();
    assert.equal(f.state(),undefined,"Automatic monitor cannot infer missing banner");
    await assert.rejects(f.start(false),/AUTO_MIGRATION_MANUAL_CONFIRM_REQUIRED/);
    const start=await f.start(true);
    assert.equal(start.accepted,true);
    assert.equal(start.reason,"REGISTERED_CHAT_OPERATOR_CONFIRMED_NO_VISIBLE_WARNING");
    await f.tick();
    assert.equal(f.state().stage,"request_pending");
    assert.equal(f.state().manualTrigger,true);
    assert.equal(f.state().syntheticTrigger,false);
    assert.equal(f.tabs.length,1);
    await f.tick();
    assert.equal(f.state().stage,"awaiting_source_reply");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,1);
    await f.tick();
    assert.equal(f.tabs.length,1,"Never create target before original assistant answers");
    f.setSourceReply(true);
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
    await f.tick();
    assert.equal(f.tabs.length,1);
  }finally{f.cleanup()}
});
test("manual start refuses disabled track, duplicate pending trigger and same original URL",async()=>{
  const f=fixture();
  try{
    await assert.rejects(f.inspect(),/AUTO_MIGRATION_ENABLED_TRACK_REQUIRED/);
    await assert.rejects(f.start(),/AUTO_MIGRATION_ENABLED_TRACK_REQUIRED/);
    await f.configure();
    await f.start();
    await assert.rejects(f.start(),/AUTO_MIGRATION_TRIGGER_ALREADY_QUEUED/);
    await f.tick();
    await assert.rejects(f.start(),/AUTO_MIGRATION_ALREADY_ATTEMPTED_ON_CHAT/);
  }finally{f.cleanup()}
});

test("Face Lab already-authored handoff continues after count mismatch without asking original again",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick(); // observed original max-length warning
    await f.tick(); // source authoring request sent
    assert.equal(f.state().stage,"awaiting_source_reply");
    const sends=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    f.setSourceReply(true);
    const recovery=await f.recover();
    assert.equal(recovery.accepted,true);
    assert.equal(recovery.stage,"recovered_pause_pending");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends);
    await f.tick(); // mandatory pause first
    assert.equal(f.state().stage,"ready_to_create");
    await f.tick();
    assert.equal(f.state().stage,"awaiting_target_page");
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends);
    await f.tick(); // handoff transfer to NEW project chat
    assert.equal(f.state().stage,"awaiting_first_reply");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends+1);
  }finally{f.cleanup()}
});
test("recovery survives extension-session reset by revalidating the original user request and authored assistant reply",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick();
    await f.tick();
    f.setSourceReply(true);
    f.simulateWorkerReload();
    assert.equal(f.state(),undefined);
    const recovery=await f.recover();
    assert.equal(recovery.stage,"recovered_pause_pending");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,1);
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
  }finally{f.cleanup()}
});
test("recovery will not silently fabricate, re-send, or run after target creation",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await assert.rejects(f.recover(),/AUTO_MIGRATION_RECOVERY_MIGRATION_NEW_RESPONSE_NOT_FOUND/);
    await f.tick();
    await f.tick();
    await assert.rejects(f.recover(false),/AUTO_MIGRATION_RECOVERY_CONFIRM_REQUIRED/);
    await assert.rejects(f.recover(),/AUTO_MIGRATION_RECOVERY_MIGRATION_NEW_RESPONSE_NOT_FOUND/);
    assert.equal(f.tabs.length,1);
    f.setSourceReply(true);
    await f.recover();
    await assert.rejects(f.recover(),/AUTO_MIGRATION_RECOVERY_ACTIVE_OR_UNSAFE_STAGE/);
    await f.tick();
    await f.tick();
    assert.equal(f.tabs.length,1);
    await assert.rejects(f.recover(),/AUTO_MIGRATION_RECOVERY_CONNECTED_PROJECT_CHAT_REQUIRED/);
  }finally{f.cleanup()}
});

test("recovery refuses different chat after original request submitted",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick();
    await f.tick();
    assert.equal(f.state().stage,"awaiting_source_reply");
    const sends=f.calls.filter(c=>c.name==="submitToExistingChatGPT").length;
    const moved="https://chatgpt.com/g/g-p-saju-project/c/different-chat";
    f.tabs[0].url=moved;
    f.current().sessions[0].url=moved;
    f.setSourceReply(true);
    await assert.rejects(f.recover(),/AUTO_MIGRATION_RECOVERY_ORIGINAL_CHANGED/);
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,sends);
  }finally{f.cleanup()}
});

test("recover verifies saved pre-send assistant ID without resending original",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick();
    await f.tick();
    f.setSourceReply(true);
    const result=await f.recover();
    assert.equal(result.accepted,true);
    const capture=f.calls.filter(x=>x.name==="copyLastMigrationAssistant").at(-1);
    assert.equal(capture.args[3],"assistant-before");
    assert.equal(capture.args[4],"user-before");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,1);
  }finally{f.cleanup()}
});

test("operator recovery permits proved unattributed source marker without resending",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick();
    await f.tick();
    f.setUnattributed(true);
    f.setSourceReply(true);
    const r=await f.recover();
    assert.equal(r.accepted,true);
    const capture=f.calls.filter(x=>x.name==="copyLastMigrationAssistant").at(-1);
    assert.equal(capture.args[5],true);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,1);
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
  }finally{f.cleanup()}
});

test("deleting registered tab prunes watcher settings and all transient states",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.test();
    await f.tick();
    assert.equal(f.state().stage,"request_pending");
    assert.equal((await getAutoMigrationWatchSessionKeys()).length,1);
    f.current().sessions.splice(0,1);
    const result=await f.view();
    assert.equal(result.tracks.length,0);
    assert.deepEqual(await getAutoMigrationWatchSessionKeys(),[]);
    assert.equal(f.state(),undefined);
    assert.equal(f.session[AUTO_MIGRATION_TEST_KEY].saju,undefined);
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,0);
  }finally{f.cleanup()}
});
test("group registration deletion prunes affected monitor but not others",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.local[AUTO_MIGRATION_KEY].push({
      sessionKey:"other",trackTitle:"Other 3",repository:"owner/other",
      enabled:true,lastTriggeredUrl:null
    });
    f.current().sessions.push({
      key:"other",groupKey:"group-other",tabId:11,sessionToken:"epoch",
      url:"https://chatgpt.com/g/g-p-other/c/a",paused:false
    });
    f.current().groups.push({
      key:"group-other",groupId:88,windowId:4,sessionToken:"epoch",paused:false
    });
    f.current().groups.splice(0,1);
    f.current().sessions=f.current().sessions.filter(s=>s.groupKey!=="group");
    const result=await f.view();
    assert.deepEqual(result.tracks.map(t=>t.sessionKey),["other"]);
  }finally{f.cleanup()}
});
test("unpaired/temporarily disconnected but still registered watcher is retained",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.current().sessions[0].paused=true;
    assert.equal((await f.view()).tracks.length,1);
  }finally{f.cleanup()}
});
test("explicit watch removal is confirmed, immediate and cannot reset same-chat send guard",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.test();
    await f.tick();
    await f.tick();
    const before=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    assert.equal(before,1);
    await assert.rejects(f.remove(false),/AUTO_MIGRATION_REMOVE_CONFIRM_REQUIRED/);
    assert.equal((await f.remove()).tracks.length,0);
    assert.equal(f.state(),undefined);
    assert.equal(f.local[AUTO_MIGRATION_REMOVED_URLS_KEY].saju,
      "https://chatgpt.com/g/g-p-saju-project/c/old");
    await f.configure();
    assert.equal(f.settings().lastTriggeredUrl,
      "https://chatgpt.com/g/g-p-saju-project/c/old");
    await f.tick();
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,before);
    assert.equal(f.tabs.length,1);
  }finally{f.cleanup()}
});
test("authenticated bridge-revoked watcher disappears, other registered monitor stays",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.local[AUTO_MIGRATION_KEY].push({
      sessionKey:"other",trackTitle:"Other 3",repository:"owner/other",
      enabled:true,lastTriggeredUrl:null
    });
    f.current().sessions.push({
      key:"other",groupKey:"group",tabId:11,sessionToken:"epoch",paused:false,
      url:"https://chatgpt.com/g/g-p-other/c/a"
    });
    const result=await cleanupAutoMigrationWatchers(f.current(),{
      revokedSessionKeys:["saju"]
    });
    assert.deepEqual(result.tracks.map(t=>t.sessionKey),["other"]);
    assert.equal(f.settings().sessionKey,"other");
  }finally{f.cleanup()}
});

test("operator recovers original completed handoff after trigger URL and session state are both lost",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.setUnattributed(true);
    f.setSourceReply(true);
    assert.equal(f.settings().lastTriggeredUrl,null);
    assert.equal(f.state(),undefined);
    const result=await f.recover();
    assert.equal(result.accepted,true);
    assert.equal(result.stage,"recovered_pause_pending");
    assert.equal(result.reason,"ORIGINAL_AUTHORED_HANDOFF_RECOVERED_WITHOUT_TRIGGER_SNAPSHOT");
    const capture=f.calls.filter(c=>c.name==="copyLastMigrationAssistant").at(-1);
    assert.deepEqual(capture.args[6],{
      repository:"owner/Saju",trackTitle:"사주 범용화 및 권한 통합 3"
    });
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,0);
    assert.equal(f.tabs.length,1);
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
    assert.deepEqual(f.effects,["schedule-paused"]);
  }finally{f.cleanup()}
});
test("lost trigger with unrelated authoring request cannot recover or create target",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.setUnattributed(true);
    f.setSourceReply(true);
    f.setSourceContextMatches(false);
    await assert.rejects(f.recover(),/AUTO_MIGRATION_RECOVERY_MIGRATION_SOURCE_REQUEST_MISMATCH/);
    assert.equal(f.settings().lastTriggeredUrl,null);
    assert.equal(f.state(),undefined);
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,0);
    assert.deepEqual(f.effects,[]);
  }finally{f.cleanup()}
});
test("missing trigger snapshot refuses fake handoff evidence without source verification",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.setSourceReply(true);
    // A malicious page may return a valid-looking marker/body but omit
    // independently verified source context or authoring request proof.
    f.setSourceContextMatches(false);
    await assert.rejects(f.recover(),/AUTO_MIGRATION_RECOVERY_MIGRATION_SOURCE_REQUEST_MISMATCH/);
    assert.equal(f.state(),undefined);
    assert.equal(f.tabs.length,1);
  }finally{f.cleanup()}
});

test("operator-confirmed styled-text reply without PRE/CODE resumes with original provenance and zero source resends",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.setUnstructured(true);
    f.setSourceReply(true);
    assert.equal(f.settings().lastTriggeredUrl,null);
    assert.equal(f.state(),undefined);
    const result=await f.recover();
    assert.equal(result.accepted,true);
    assert.equal(result.reason,
      "ORIGINAL_AUTHORED_HANDOFF_RECOVERED_WITHOUT_TRIGGER_SNAPSHOT");
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,0);
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
    await f.tick();
    assert.equal(f.state().stage,"awaiting_target_page");
    assert.equal(f.calls.filter(c=>c.name==="submitToExistingChatGPT").length,0);
  }finally{f.cleanup()}
});

test("read-only original handoff DOM diagnosis never changes state or re-sends prompts",async()=>{
  const f=fixture();
  try{
    await f.configure();
    const settings=JSON.stringify(f.local[AUTO_MIGRATION_KEY]);
    const result=await f.diagnose();
    assert.deepEqual(result.counts,{markers:2,requests:2,
      pre:0,code:0,textNodes:328});
    assert.equal(result.readOnly,true);
    assert.equal(JSON.stringify(f.local[AUTO_MIGRATION_KEY]),settings);
    assert.equal(f.state(),undefined);
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,0);
    assert.equal(f.effects.length,0);
  }finally{f.cleanup()}
});

test("same-tab migration never creates another tab and rebinds the registered URL before detecting assistant DOM",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick();
    await f.tick();
    f.setSourceReply(true);
    await f.tick();
    await f.tick();
    assert.equal(f.tabs.length,1);
    assert.equal(f.tabs[0].id,9);
    assert.equal(f.tabs[0].groupId,8);
    assert.equal(f.effects.includes("tab-navigated"),true);
    assert.equal(f.effects.includes("tab-created"),false);
    await f.tick();
    assert.equal(f.state().stage,"awaiting_first_reply");
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/next";
    await f.tick();
    assert.equal(f.state().stage,"awaiting_first_reply");
    assert.equal(f.current().sessions[0].tabId,9);
    assert.equal(f.current().sessions[0].url,f.tabs[0].url);
    assert.equal(f.settings().lastTriggeredUrl,
      "https://chatgpt.com/g/g-p-saju-project/c/old");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,2);
  }finally{f.cleanup()}
});
test("role-less new ChatGPT reply may be explicitly confirmed without resending handoff",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/next";
    await f.tick();
    const sends=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    await assert.rejects(f.confirmReply(false),/AUTO_MIGRATION_REPLY_CONFIRM_REQUIRED/);
    const result=await f.confirmReply();
    assert.equal(result.stage,"rename_pending");
    await f.tick();
    assert.equal(f.state().stage,"rebind_pending");
    await f.tick();await f.tick();await f.tick();
    assert.equal(f.state().stage,"completed");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends);
    assert.equal(f.tabs.length,1);
    assert.equal(f.current().sessions[0].tabId,9);
  }finally{f.cleanup()}
});
test("unverified title blocks schedule, verified manual ChatGPT rename resumes without replay",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/next";
    await f.tick();
    const sends=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    f.setRename(false);
    await f.confirmReply();
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.effects.includes("schedule-resumed"),false);
    await assert.rejects(f.confirmTitle(false),/AUTO_MIGRATION_TITLE_CONFIRM_REQUIRED/);
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_TITLE_READ_CHAT_TITLE_LINK_TITLE_MISMATCH/);
    assert.equal(f.state().stage,"needs_attention");
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    const confirmation=await f.confirmTitle();
    assert.equal(confirmation.stage,"resync_pending");
    await f.tick();await f.tick();
    assert.equal(f.state().stage,"completed");
    assert.equal(f.current().sessions[0].tabId,9);
    assert.equal(f.current().sessions[0].title,"사주 범용화 및 권한 통합 4");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends);
  }finally{f.cleanup()}
});
test("interrupted same-tab navigation never retries or creates extra target",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();
    f.state().stage="navigating_target_unknown";
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.state().reason,"INTERRUPTED_UNCERTAIN_NO_REPLAY");
    assert.equal(f.tabs.length,1);
    assert.equal(f.effects.includes("tab-navigated"),false);
  }finally{f.cleanup()}
});
test("changed project conversation URL after initial binding halts cutover",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/next";
    await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/unrelated";
    await f.tick();
    assert.equal(f.state().stage,"needs_attention");
    assert.equal(f.state().reason,"AUTO_MIGRATION_TARGET_CONVERSATION_CHANGED");
    assert.equal(f.effects.includes("schedule-resumed"),false);
  }finally{f.cleanup()}
});

test("automatic watcher recovers a real authored Writing Block without manual source replay",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick();
    await f.tick();
    f.setSourceReply(true);
    f.setWritingBlock(true);
    const pre=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    assert.equal(pre,1,"only original authoring request sent");
    await f.tick();
    assert.equal(f.state().stage,"awaiting_source_reply");
    assert.equal(f.state().reason,"WAITING_FOR_WRITING_BLOCK_STABLE");
    const capture=f.calls.filter(x=>x.name==="copyLastMigrationAssistant").at(-1);
    assert.equal(capture.args[5],true);
    assert.deepEqual(capture.args[6],{
      repository:"owner/Saju",trackTitle:"사주 범용화 및 권한 통합 3"
    });
    assert.equal(f.tabs.length,1);
    f.state().writingBlockStableAt=Date.now()-7000;
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,pre);
    await f.tick();
    assert.equal(f.state().stage,"awaiting_target_page");
    assert.equal(f.tabs.length,1);
    assert.equal(f.tabs[0].id,9,"same registered Chrome tab is reused");
  }finally{f.cleanup()}
});
test("manual operator recovery accepts Writing Block with genuine source request and no new authoring instruction",async()=>{
  const f=fixture();
  try{
    await f.configure();
    f.setSourceReply(true);
    f.setWritingBlock(true);
    const recovered=await f.recover();
    assert.equal(recovered.stage,"recovered_pause_pending");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,0);
    await f.tick();
    assert.equal(f.state().stage,"ready_to_create");
  }finally{f.cleanup()}
});

test("verified title repairs stale old source URL in same registered tab without re-registering or resending",async()=>{
  const f=fixture();
  try{
    await f.configure();
    await f.tick();await f.tick();
    f.setSourceReply(true);
    await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    await f.tick();
    const id=f.current().sessions[0].key;
    // Model the actual Windows issue: a non-current original URL is left
    // registered after a same-tab ChatGPT conversation navigation.
    f.current().sessions[0].url=
      "https://chatgpt.com/g/g-p-saju-project/c/old";
    assert.equal(f.state().stage,"awaiting_first_reply");
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    const sends=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    const repaired=await f.confirmTitle();
    assert.equal(repaired.accepted,true);
    assert.equal(repaired.stage,"resync_pending");
    assert.equal(repaired.tabId,9);
    assert.equal(repaired.sessionKey,id);
    assert.equal(f.current().sessions[0].key,id);
    assert.equal(f.current().sessions[0].tabId,9);
    assert.equal(f.current().sessions[0].url,f.tabs[0].url);
    assert.equal(f.current().sessions[0].title,"사주 범용화 및 권한 통합 4");
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends);
    await f.tick();await f.tick();
    assert.equal(f.state().stage,"completed");
    assert.equal(f.settings().trackTitle,"사주 범용화 및 권한 통합 4");
  }finally{f.cleanup()}
});
test("verified title can repair while rename_pending, no needs_attention prerequisite",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    await f.tick();
    f.state().stage="rename_pending";
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    assert.equal((await f.confirmTitle()).stage,"resync_pending");
    await f.tick();await f.tick();
    assert.equal(f.state().stage,"completed");
  }finally{f.cleanup()}
});
test("manual title repair refuses unrelated URL, tab, inaccurate title or unsafe failure",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    await f.tick();
    await assert.rejects(f.confirmTitle(false),/AUTO_MIGRATION_TITLE_CONFIRM_REQUIRED/);
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_TITLE_READ_CHAT_TITLE_LINK_TITLE_MISMATCH/);
    assert.equal(f.state().stage,"awaiting_first_reply");
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/other";
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_TARGET_CONVERSATION_CHANGED/);
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.current().sessions[0].tabId=31;
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_EXISTING_REGISTRATION_REQUIRED/);
    f.current().sessions[0].tabId=9;
    f.state().stage="needs_attention";
    f.state().reason="AUTO_MIGRATION_SEND_UNCERTAIN";
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_TITLE_CONFIRM_NOT_ELIGIBLE/);
    assert.equal(f.effects.includes("schedule-resumed"),false);
  }finally{f.cleanup()}
});

test("same-tab URL-changed monitor remains selectable for repair, unrelated sessions do not",()=>{
  const data={token:"epoch",
    registry:{
      groups:[{key:"g",groupId:8,windowId:4,sessionToken:"epoch",paused:false}],
      sessions:[{key:"s",groupKey:"g",tabId:9,
        sessionToken:"epoch",url:"https://chatgpt.com/g/g-p-test/c/old",
        paused:false,title:"이관 테스트 1"}]
    },
    snapshot:{
      groups:[{id:8,windowId:4,title:"project"}],
      tabs:[{id:9,windowId:4,groupId:8,
        url:"https://chatgpt.com/g/g-p-test/c/next",
        title:"이관 테스트 2"}]
    }
  };
  const track={sessionKey:"s",enabled:true,progress:{
    stage:"awaiting_first_reply",newTabId:9}};
  assert.deepEqual(eligibleAutoMigrationSessions(data,[track]).map(x=>x.key),["s"]);
  assert.deepEqual(eligibleAutoMigrationSessions(data,[{
    sessionKey:"s",enabled:true,lastTriggeredUrlPresent:true,progress:null
  }]).map(x=>x.key),["s"]);
  assert.deepEqual(eligibleAutoMigrationSessions(data,[{
    sessionKey:"s",enabled:true,lastTriggeredUrlPresent:false,progress:null
  }]).map(x=>x.key),["s"]);
  data.registry.groups[0].sessionToken="previous-epoch";
  data.registry.sessions[0].sessionToken="previous-epoch";
  assert.deepEqual(eligibleAutoMigrationSessions(data,[{
    sessionKey:"s",enabled:true,lastTriggeredUrlPresent:true,progress:null
  }]).map(x=>x.key),["s"]);
  data.registry.groups[0].sessionToken="epoch";
  data.registry.sessions[0].sessionToken="epoch";
  assert.equal(eligibleAutoMigrationSessions(data,[]).length,0);
  assert.equal(eligibleAutoMigrationSessions(data,[{...track,progress:{
    stage:"completed",newTabId:9}}]).length,0);
  assert.equal(eligibleAutoMigrationSessions(data,[{...track,progress:{
    stage:"awaiting_first_reply",newTabId:11}}]).length,0);
  data.snapshot.tabs[0].url="https://chatgpt.com/g/g-p-foreign/c/other";
  assert.equal(eligibleAutoMigrationSessions(data,[track]).length,0);
});

test("extension reload with lost progress can repair original same-tab enrollment using visible transferred handoff proof",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    const originalSession=f.current().sessions[0].key;
    // Source registration was not yet updated; updating an extension version
    // discards transient progress. No duplicate registration is allowed.
    f.simulateWorkerReload();
    assert.equal(f.state(),undefined);
    assert.equal(f.settings().lastTriggeredUrl,
      "https://chatgpt.com/g/g-p-saju-project/c/old");
    const sends=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    const result=await f.confirmTitle();
    assert.equal(result.accepted,true);
    assert.equal(result.stage,"registration_repaired_schedule_review");
    assert.equal(result.scheduleRestored,false);
    assert.equal(f.current().sessions[0].key,originalSession);
    assert.equal(f.current().sessions[0].tabId,9);
    assert.equal(f.current().sessions[0].url,f.tabs[0].url);
    assert.equal(f.current().sessions[0].title,"사주 범용화 및 권한 통합 4");
    assert.equal(f.settings().trackTitle,"사주 범용화 및 권한 통합 4");
    assert.equal(f.settings().lastTriggeredUrl,
      "https://chatgpt.com/g/g-p-saju-project/c/old");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends);
    assert.equal(f.effects.includes("schedule-resumed"),false);
    assert.equal(f.tabs.length,1);
  }finally{f.cleanup()}
});
test("stateless registration repair refuses wrong context, project or title and never replays",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.simulateWorkerReload();
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_TITLE_READ_CHAT_TITLE_LINK_TITLE_MISMATCH/);
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    f.setHandoffProof(false);
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_REPAIR_MIGRATION_REPAIR_HANDOFF_PROVENANCE_NOT_VISIBLE/);
    f.setHandoffProof(true);
    f.tabs[0].url="https://chatgpt.com/g/g-p-other-project/c/other";
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_REPAIR_ORIGINAL_SESSION_PROOF_REQUIRED/);
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.current().sessions[0].tabId=27;
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_REPAIR_ORIGINAL_SESSION_PROOF_REQUIRED/);
    assert.equal(f.current().sessions.length,1);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,2);
    assert.equal(f.effects.includes("schedule-resumed"),false);
  }finally{f.cleanup()}
});

test("stateless repair also restores only the original session token after extension reload",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    f.simulateWorkerReload();
    const group=f.current().groups[0];
    const session=f.current().sessions[0];
    group.sessionToken="previous-extension-epoch";
    session.sessionToken="previous-extension-epoch";
    const result=await f.confirmTitle();
    assert.equal(result.stage,"registration_repaired_schedule_review");
    assert.equal(f.current().groups[0].sessionToken,"epoch");
    assert.equal(f.current().sessions[0].sessionToken,"epoch");
    assert.equal(f.current().sessions[0].key,"saju");
    assert.equal(f.current().sessions[0].tabId,9);
    assert.equal(f.current().sessions[0].url,f.tabs[0].url);
    assert.equal(f.effects.includes("schedule-resumed"),false);
  }finally{f.cleanup()}
});

test("missing lastTriggeredUrl alone cannot prevent same-tab title rebind after exact live handoff proof",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    f.simulateWorkerReload();
    f.settings().lastTriggeredUrl=null;
    const oldKey=f.current().sessions[0].key;
    const sends=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    const result=await f.confirmTitle();
    assert.equal(result.accepted,true);
    assert.equal(result.stage,"registration_repaired_schedule_review");
    assert.equal(result.scheduleRestored,false);
    assert.equal(f.current().sessions[0].key,oldKey);
    assert.equal(f.current().sessions[0].tabId,9);
    assert.equal(f.current().sessions[0].url,f.tabs[0].url);
    assert.equal(f.current().sessions[0].title,"사주 범용화 및 권한 통합 4");
    assert.equal(f.effects.includes("schedule-resumed"),false);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends);
  }finally{f.cleanup()}
});
test("repair proof failure identifies failed predicates, never leaks identifiers or sends prompts",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.simulateWorkerReload();
    f.settings().lastTriggeredUrl=null;
    const sends=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    f.current().sessions[0].tabId=27;
    await assert.rejects(f.confirmTitle(),error=>{
      assert.match(error.message,/AUTO_MIGRATION_REPAIR_ORIGINAL_SESSION_PROOF_REQUIRED/);
      assert.match(error.message,/originalTabPresent/);
      assert.doesNotMatch(error.message,/chatgpt.com|saju-project|owner\/Saju/);
      return true;
    });
    assert.equal(f.current().sessions[0].tabId,27);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends);
  }finally{f.cleanup()}
});
test("lost trigger still requires exact verified handoff, not title alone",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    f.simulateWorkerReload();
    f.settings().lastTriggeredUrl=null;
    f.setHandoffProof(false);
    await assert.rejects(f.confirmTitle(),
      /AUTO_MIGRATION_REPAIR_MIGRATION_REPAIR_HANDOFF_PROVENANCE_NOT_VISIBLE/);
    assert.equal(f.current().sessions[0].url,
      "https://chatgpt.com/g/g-p-saju-project/c/old");
    assert.equal(f.effects.includes("schedule-resumed"),false);
  }finally{f.cleanup()}
});

test("title verification rejects wrong rendered title with safe structured evidence and preserves original session",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/next";
    f.simulateWorkerReload();
    const old=f.current().sessions[0].url;
    await assert.rejects(f.confirmTitle(),error=>{
      assert.match(error.message,/AUTO_MIGRATION_TITLE_READ_CHAT_TITLE_LINK_TITLE_MISMATCH/);
      assert.match(error.message,/expectedInLinkedTitle=false/);
      assert.doesNotMatch(error.message,/saju-project|owner\/Saju|사주 범용화/);
      return true;
    });
    assert.equal(f.current().sessions[0].url,old);
    assert.equal(f.effects.includes("schedule-resumed"),false);
  }finally{f.cleanup()}
});

test("stateless same-tab recovery accepts explicit typed title only if DOM has no current URL link and transferred handoff is proven",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    f.simulateWorkerReload();f.setTitleDomUnreadable(true);
    const beforeSendCount=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_TITLE_READ_CHAT_TITLE_NO_MATCHING_CONVERSATION_LINK/);
    assert.equal(f.current().sessions[0].url,
      "https://chatgpt.com/g/g-p-saju-project/c/old");
    const success=await f.confirmTitle(true,"사주 범용화 및 권한 통합 4");
    assert.equal(success.stage,"registration_repaired_schedule_review");
    assert.equal(success.titleVerification,"OPERATOR_ATTESTED_VISIBLE_TITLE");
    assert.equal(success.scheduleRestored,false);
    assert.equal(f.current().sessions[0].url,f.tabs[0].url);
    assert.equal(f.current().sessions[0].key,"saju");
    assert.equal(f.current().sessions[0].tabId,9);
    assert.equal(f.current().sessions[0].title,"사주 범용화 및 권한 통합 4");
    assert.equal(f.tabs.length,1);
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,beforeSendCount);
    assert.equal(f.effects.includes("schedule-resumed"),false);
  }finally{f.cleanup()}
});
test("operator typed title cannot override a different expected title, wrong provenance or conflicting sidebar",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    f.tabs[0].title="사주 범용화 및 권한 통합 4";
    f.simulateWorkerReload();f.setTitleDomUnreadable(true);
    await assert.rejects(f.confirmTitle(true,"사주 범용화 및 권한 통합 5"),
      /AUTO_MIGRATION_OPERATOR_TITLE_NOT_EXPECTED/);
    f.setHandoffProof(false);
    await assert.rejects(f.confirmTitle(true,"사주 범용화 및 권한 통합 4"),
      /AUTO_MIGRATION_OPERATOR_TITLE_MIGRATION_REPAIR_HANDOFF_PROVENANCE_NOT_VISIBLE/);
    f.setHandoffProof(true);f.setTitleDomUnreadable(false);
    f.tabs[0].title="사주 범용화 및 권한 통합 5";
    await assert.rejects(f.confirmTitle(true,"사주 범용화 및 권한 통합 4"),
      /AUTO_MIGRATION_OPERATOR_TITLE_CONFLICTING_DOM_PROOF/);
    assert.equal(f.current().sessions[0].url,
      "https://chatgpt.com/g/g-p-saju-project/c/old");
    assert.equal(f.effects.includes("schedule-resumed"),false);
  }finally{f.cleanup()}
});
test("inflight active migration manual title confirmation preserves target URL and avoids repeat handoff",async()=>{
  const f=fixture();
  try{
    await f.configure();await f.tick();await f.tick();
    f.setSourceReply(true);await f.tick();await f.tick();await f.tick();
    f.tabs[0].url="https://chatgpt.com/g/g-p-saju-project/c/new-4";
    await f.tick();
    const sends=f.calls.filter(x=>x.name==="submitToExistingChatGPT").length;
    f.setTitleDomUnreadable(true);
    await assert.rejects(f.confirmTitle(),/AUTO_MIGRATION_TITLE_READ_CHAT_TITLE_NO_MATCHING_CONVERSATION_LINK/);
    const confirmed=await f.confirmTitle(true,"사주 범용화 및 권한 통합 4");
    assert.equal(confirmed.stage,"resync_pending");
    assert.equal(confirmed.titleVerification,"OPERATOR_ATTESTED_VISIBLE_TITLE");
    assert.equal(f.current().sessions[0].title,"사주 범용화 및 권한 통합 4");
    await f.tick();await f.tick();
    assert.equal(f.state().stage,"completed");
    assert.equal(f.calls.filter(x=>x.name==="submitToExistingChatGPT").length,sends);
  }finally{f.cleanup()}
});
