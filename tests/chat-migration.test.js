import test from "node:test";
import assert from "node:assert/strict";
import {
  incrementTrackTitle, migrationPrompt, projectIdFromUrl,
  targetIsNewProject,migratedIntoSameProject, MAX_HANDOFF_CHARS
} from "../extension/migration-core.js";
import {handleMigrationMessage} from "../extension/migration-service.js";

test("increments only a grounded numeric track suffix and demands repository roadmap",()=>{
  assert.equal(incrementTrackTitle("사주 범용화 및 권한 통합 3"),"사주 범용화 및 권한 통합 4");
  assert.equal(incrementTrackTitle("BuildMap 009"),"BuildMap 10");
  for(const value of ["no number","", "name 999", "name -1", "name a", "name 1000"])
    assert.throws(()=>incrementTrackTitle(value));
  const prompt=migrationPrompt({repository:"owner/Repo",trackTitle:"Track 3"});
  assert.ok(prompt.length<=800);
  assert.match(prompt,/로드맵/);
  assert.match(prompt,/로드맵이 없거나/);
  assert.match(prompt,/AUTOPILOT_MIGRATION_HANDOFF/);
  assert.match(prompt,/Track 4/);
  assert.throws(()=>migrationPrompt({repository:"invalid repo",trackTitle:"Track 3"}));
});

test("project identity is exact and no other project/chat route is automatically treated as target",()=>{
  const home="https://chatgpt.com/g/g-p-myeongha-abc/project";
  const created="https://chatgpt.com/g/g-p-myeongha-abc/c/created-id";
  assert.equal(projectIdFromUrl(home),"g-p-myeongha-abc");
  assert.equal(targetIsNewProject(home),true);
  assert.equal(migratedIntoSameProject(home,created),true);
  assert.equal(migratedIntoSameProject(home,"https://chatgpt.com/g/g-p-other/c/id"),false);
  assert.equal(migratedIntoSameProject(home,"https://chatgpt.com/c/random"),false);
  assert.equal(migratedIntoSameProject(home,"https://evil.test/g/g-p-myeongha-abc/c/id"),false);
  assert.equal(targetIsNewProject(created),false);
  assert.equal(MAX_HANDOFF_CHARS,30000);
});

function setup(){
  const old=globalThis.chrome;
  const epoch="browser-epoch";
  const sourceUrl="https://chatgpt.com/c/old";
  const targetUrl="https://chatgpt.com/g/g-p-abc/project";
  const groups=[
    {id:3,windowId:1,title:"Old"},
    {id:4,windowId:1,title:"Project"}
  ];
  const tabs=[
    {id:8,windowId:1,groupId:3,url:sourceUrl,title:"Track 3"},
    {id:9,windowId:1,groupId:4,url:targetUrl,title:"Project"}
  ];
  let storage={};
  let sourceAtLimit=true;
  let resultMode="success";
  let busy=false;
  let fingerprint="25:a";
  let renameResult={ok:true,reason:"MIGRATION_TITLE_VERIFIED"};
  const injected=[];
  const registry={
    version:1,
    groups:[
      {key:"g1",groupId:3,windowId:1,sessionToken:epoch,paused:false},
      {key:"g2",groupId:4,windowId:1,sessionToken:epoch,paused:false}
    ],
    sessions:[
      {key:"s1",groupKey:"g1",tabId:8,sessionToken:epoch,url:sourceUrl,paused:false},
      {key:"s2",groupKey:"g2",tabId:9,sessionToken:epoch,url:targetUrl,paused:false}
    ]
  };
  const replyBody="이관문 본문: "+("로드맵을 기반으로 다음 개발 단계를 수행하십시오. ").repeat(12);
  globalThis.chrome={
    storage:{
      session:{
        get:async()=>({"autopilot.migration.v1":storage.migration||null}),
        set:async value=>{storage.migration=value["autopilot.migration.v1"]},
        remove:async()=>{delete storage.migration}
      },
      local:{set:async value=>{storage.registry=value["autopilot.registry.v1"]}}
    },
    scripting:{executeScript:async args=>{
      injected.push({name:args.func.name,tabId:args.target.tabId,args:args.args});
      let result;
      switch(args.func.name){
        case "inspectMigrationSource":
          result={ok:true,atLimit:sourceAtLimit,assistantCount:10};break;
        case "submitToExistingChatGPT":
          result=resultMode==="blocked"?{clicked:false,reason:"COMPOSER_NOT_FOUND"}:
            {clicked:true,reason:"SEND_BUTTON_CLICKED_UNVERIFIED"};break;
        case "copyLastMigrationAssistant":
          result={ok:true,body:replyBody,length:replyBody.length};break;
        case "inspectMigrationTarget":
          result={ok:true,projectConversation:true,busy,assistantCount:1,
            lastReplyFingerprint:fingerprint};break;
        case "renameMigrationConversation":
          result=renameResult;break;
        default:throw Error("unexpected injection "+args.func.name);
      }
      return [{result}];
    }}
  };
  const ctx={registry,snapshot:{tabs,groups},epoch};
  const call=(type,more={})=>handleMigrationMessage({type,...more},ctx);
  return {
    call,ctx,sourceUrl,targetUrl,tabs,registry,injected,
    setMode:x=>{resultMode=x},setBusy:x=>{busy=x},
    setFingerprint:x=>{fingerprint=x},
    setRename:x=>{renameResult=x},
    setAtLimit:x=>{sourceAtLimit=x},
    get storage(){return storage},
    restore:()=>{globalThis.chrome=old}
  };
}
test("migration copies ONLY the requested last assistant answer and waits for stable first reply before rename",async()=>{
  const s=setup();
  try{
    const prep=await s.call("AP_MIGRATION_PREPARE",{
      sourceKey:"s1",targetKey:"s2",trackTitle:"사주 범용화 및 권한 통합 3",
      repository:"owner/Repo"
    });
    assert.equal(prep.migration.stage,"awaiting_source_reply");
    assert.equal(prep.migration.sourceAtLimit,true);
    assert.equal(s.injected.at(-1).name,"submitToExistingChatGPT");
    const copied=await s.call("AP_MIGRATION_CAPTURE");
    assert.equal(copied.migration.stage,"review");
    assert.match(copied.migration.promptPreview,/로드맵/);
    const pasted=await s.call("AP_MIGRATION_TRANSFER");
    assert.equal(pasted.migration.stage,"awaiting_first_reply");
    assert.equal(s.injected.at(-1).args[1],"handoff");
    assert.equal(s.injected.at(-1).tabId,9);
    assert.equal(s.storage.migration.body,null);
    assert.ok(!JSON.stringify(pasted).includes("로드맵을 기반으로"));
    // The actual first send creates a new project-specific conversation URL.
    s.tabs[1].url="https://chatgpt.com/g/g-p-abc/c/newchat";
    const first=await s.call("AP_MIGRATION_POLL");
    assert.equal(first.reason,"MIGRATION_FIRST_REPLY_STABILIZING");
    assert.equal(s.injected.filter(x=>x.name==="renameMigrationConversation").length,0);
    s.setFingerprint("25:b");
    await s.call("AP_MIGRATION_POLL");
    assert.equal(s.injected.filter(x=>x.name==="renameMigrationConversation").length,0);
    s.storage.migration.firstReplySeen=Date.now()-7000;
    const done=await s.call("AP_MIGRATION_POLL");
    assert.equal(done.migration.stage,"title_verified");
    assert.equal(s.injected.filter(x=>x.name==="renameMigrationConversation").length,1);
    assert.equal(s.injected.at(-1).args[0],"사주 범용화 및 권한 통합 4");
    const rebound=await s.call("AP_MIGRATION_REBIND");
    assert.equal(rebound.migration.stage,"completed");
    assert.equal(s.storage.registry.sessions[1].url,s.tabs[1].url);
    assert.equal(s.injected.filter(x=>x.name==="submitToExistingChatGPT").length,2);
  }finally{s.restore()}
});
test("hard limit blocked prompt uses manual handoff text; cannot accidentally auto-resend",async()=>{
  const s=setup();
  try{
    s.setMode("blocked");
    const prep=await s.call("AP_MIGRATION_PREPARE",{
      sourceKey:"s1",targetKey:"s2",trackTitle:"Track 3",repository:"owner/repo"
    });
    assert.equal(prep.migration.stage,"awaiting_manual");
    assert.equal(prep.migration.reason,"COMPOSER_NOT_FOUND");
    assert.equal(s.injected.filter(x=>x.name==="submitToExistingChatGPT").length,1);
    await assert.rejects(s.call("AP_MIGRATION_PREPARE",{
      sourceKey:"s1",targetKey:"s2",trackTitle:"Track 3",repository:"owner/repo"
    }),/MIGRATION_ACTIVE_CANCEL_FIRST/);
    const saved=await s.call("AP_MIGRATION_MANUAL",{body:"직접 준비한 로드맵 이관문 ".repeat(8)});
    assert.equal(saved.migration.stage,"review");
    assert.match(saved.migration.promptPreview,/로드맵/);
    await s.call("AP_MIGRATION_CANCEL");
    assert.equal((await s.call("AP_MIGRATION_STATE")).migration,null);
  }finally{s.restore()}
});
test("wrong project, wrong registered tab, or premature rebind is always blocked",async()=>{
  const s=setup();
  try{
    await assert.rejects(s.call("AP_MIGRATION_PREPARE",{
      sourceKey:"s2",targetKey:"s1",trackTitle:"Track 3",repository:"owner/repo"
    }),/MIGRATION_SOURCE_EXISTING_AND_TARGET_PROJECT_NEW_REQUIRED/);
    await s.call("AP_MIGRATION_PREPARE",{
      sourceKey:"s1",targetKey:"s2",trackTitle:"Track 3",repository:"owner/repo"
    });
    await assert.rejects(s.call("AP_MIGRATION_REBIND"),/MIGRATION_TITLE_NOT_VERIFIED/);
    await s.call("AP_MIGRATION_CAPTURE");
    s.tabs[1].url="https://chatgpt.com/g/g-p-other/project";
    await assert.rejects(s.call("AP_MIGRATION_TRANSFER"),/MIGRATION_REGISTERED_TAB_NOT_CONNECTED/);
  }finally{s.restore()}
});
test("unknown browser send never retries or silently proceeds to next stage",async()=>{
  const s=setup();
  try{
    await s.call("AP_MIGRATION_PREPARE",{
      sourceKey:"s1",targetKey:"s2",trackTitle:"Track 3",repository:"owner/repo"
    });
    await s.call("AP_MIGRATION_CAPTURE");
    s.setMode("blocked");
    const result=await s.call("AP_MIGRATION_TRANSFER");
    assert.equal(result.migration.stage,"transfer_blocked");
    await assert.rejects(s.call("AP_MIGRATION_TRANSFER"),/MIGRATION_PROMPT_NOT_REVIEWED/);
    assert.equal(s.injected.filter(x=>x.name==="submitToExistingChatGPT").length,2);
  }finally{s.restore()}
});
test("rename fails closed, then explicit manual title confirmation is required before rebind",async()=>{
  const s=setup();
  try{
    await s.call("AP_MIGRATION_PREPARE",{
      sourceKey:"s1",targetKey:"s2",trackTitle:"Track 3",repository:"owner/repo"
    });
    await s.call("AP_MIGRATION_CAPTURE");
    await s.call("AP_MIGRATION_TRANSFER");
    s.tabs[1].url="https://chatgpt.com/g/g-p-abc/c/newchat";
    await s.call("AP_MIGRATION_POLL");
    s.storage.migration.firstReplySeen=Date.now()-8000;
    s.setRename({ok:false,reason:"MIGRATION_TITLE_CHAT_MENU_NOT_FOUND"});
    const result=await s.call("AP_MIGRATION_POLL");
    assert.equal(result.migration.stage,"manual_title_required");
    assert.equal(s.injected.filter(x=>x.name==="renameMigrationConversation").length,1);
    await s.call("AP_MIGRATION_CONFIRM_TITLE");
    const final=await s.call("AP_MIGRATION_REBIND");
    assert.equal(final.migration.stage,"completed");
  }finally{s.restore()}
});
