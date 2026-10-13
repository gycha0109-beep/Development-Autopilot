import {STORAGE_KEY,sessionStatus,applyAction} from "./core.js";
import {
  incrementTrackTitle,migrationPrompt,fallbackRoadmapHandoff,
  MIGRATION_MARKER,MAX_HANDOFF_CHARS,migratedIntoSameProject,
  projectIdFromUrl
} from "./migration-core.js";
import {
  inspectChatLengthLimit,inspectMigrationSource,copyLastMigrationAssistant,
  copyLastAssistantContext,inspectMigrationTarget,renameMigrationConversation
} from "./migration-page.js";
import {submitToExistingChatGPT} from "./chat-page.js";

export const AUTO_MIGRATION_KEY="autopilot.migration.auto.config.v1";
export const AUTO_MIGRATION_PROGRESS_KEY="autopilot.migration.auto.progress.v1";
const limited=(value,max)=>typeof value==="string"&&value.trim().length>0&&value.length<=max;
const repoValid=r=>limited(r,160)&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r);
const visibleState=s=>s?({
  stage:s.stage,reason:s.reason||null,trackTitle:s.trackTitle,
  nextTitle:s.nextTitle,sourceSessionKey:s.sessionKey,
  sourceAtLimit:true,startedAt:s.startedAt||null,
  newTabId:s.targetTabId||null,finishedAt:s.finishedAt||null
}):null;
const storedSettings=async()=>{
  const r=await chrome.storage.local.get(AUTO_MIGRATION_KEY);
  return Array.isArray(r[AUTO_MIGRATION_KEY])?r[AUTO_MIGRATION_KEY]:[];
};
const storedProgress=async()=>{
  const r=await chrome.storage.session.get(AUTO_MIGRATION_PROGRESS_KEY);
  return r[AUTO_MIGRATION_PROGRESS_KEY]||{};
};
const writeProgress=async progress=>chrome.storage.session.set({
  [AUTO_MIGRATION_PROGRESS_KEY]:progress
});
const writeSettings=async data=>chrome.storage.local.set({[AUTO_MIGRATION_KEY]:data});
const inject=async(tabId,func,args=[])=>{
  const r=await chrome.scripting.executeScript({
    target:{tabId,allFrames:false},world:"ISOLATED",func,args
  });
  if(r.length!==1||!r[0]?.result)throw Error("AUTO_MIGRATION_PAGE_RESULT_UNCERTAIN");
  return r[0].result;
};
const view=(configs,progress)=>({
  tracks:configs.map(x=>({
    sessionKey:x.sessionKey,repository:x.repository,trackTitle:x.trackTitle,
    enabled:x.enabled,lastTriggeredUrlPresent:!!x.lastTriggeredUrl,
    progress:visibleState(progress[x.sessionKey])
  }))
});
function source(registry,snapshot,epoch,key){
  const session=registry.sessions.find(s=>s.key===key);
  const group=registry.groups.find(g=>g.key===session?.groupKey);
  const tab=snapshot.tabs.find(t=>t.id===session?.tabId);
  if(!session||!group||!tab||session.paused||group.paused ||
     sessionStatus(session,registry,snapshot,epoch)!=="connected")
    return null;
  const id=projectIdFromUrl(tab.url);
  if(!id || !/^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(tab.url))
    return null;
  return {session,group,tab,projectId:id};
}
function checkedTarget(state,snapshot){
  const tab=snapshot.tabs.find(t=>t.id===state.targetTabId);
  if(!tab||tab.windowId!==state.windowId||tab.groupId!==state.groupId)
    throw Error("AUTO_MIGRATION_TARGET_TAB_CHANGED");
  if(tab.url!==state.projectNewUrl &&
     !migratedIntoSameProject(state.projectNewUrl,tab.url))
    throw Error("AUTO_MIGRATION_TARGET_PROJECT_CHANGED");
  return tab;
}
async function persist(progress,key,state){
  progress[key]=state;
  await writeProgress(progress);
}
export async function autoMigrationCommand(message,{registry,snapshot,epoch}){
  const configs=await storedSettings();
  const progress=await storedProgress();
  if(message.type==="AP_AUTO_MIGRATION_STATE")return view(configs,progress);
  if(message.type!=="AP_AUTO_MIGRATION_CONFIG")
    throw Error("AUTO_MIGRATION_UNSUPPORTED_COMMAND");
  const {sessionKey,enabled,repository,trackTitle}=message;
  if(!limited(sessionKey,80)||typeof enabled!=="boolean")
    throw Error("AUTO_MIGRATION_INVALID_CONFIG");
  const existing=configs.find(c=>c.sessionKey===sessionKey);
  if(enabled){
    if(!repoValid(repository)||!limited(trackTitle,160))
      throw Error("AUTO_MIGRATION_TRACK_AND_REPO_REQUIRED");
    incrementTrackTitle(trackTitle);
    if(!source(registry,snapshot,epoch,sessionKey))
      throw Error("AUTO_MIGRATION_PROJECT_CONVERSATION_REQUIRED");
    if(progress[sessionKey] && !["completed","needs_attention"].includes(progress[sessionKey].stage))
      throw Error("AUTO_MIGRATION_ALREADY_RUNNING");
    const next={sessionKey,repository,trackTitle,enabled:true,
      lastTriggeredUrl:existing?.lastTriggeredUrl||null};
    await writeSettings([...configs.filter(c=>c.sessionKey!==sessionKey),next]);
  }else{
    if(!existing)throw Error("AUTO_MIGRATION_TRACK_NOT_FOUND");
    await writeSettings(configs.map(c=>c.sessionKey===sessionKey ?
      {...c,enabled:false}:c));
  }
  return view(await storedSettings(),progress);
}

// Process one discrete, persisted transition at a time. Side-effect intent is
// persisted BEFORE every Chrome send/new tab/rename, so a crash never replays.
export async function runAutoMigrations({
  registry,snapshot,epoch,bridgeCommand,syncRegistry
}){
  const configs=await storedSettings();
  if(!configs.some(c=>c.enabled))return [];
  const progress=await storedProgress();
  const events=[];
  for(const cfg of configs.filter(c=>c.enabled)){
    const key=cfg.sessionKey;
    const prev=progress[key];
    try{
      // Read-only stopped/paired check on every tick. No action when offline.
      const status=await bridgeCommand("/api/v1/bridge/status",{});
      if(status.stopped)continue;
      const src=source(registry,snapshot,epoch,key);
      let state=progress[key];
      if(!state || ["completed","needs_attention"].includes(state.stage)){
        if(state?.stage==="needs_attention")continue;
        if(!src || cfg.lastTriggeredUrl===src.tab.url)continue;
        const alert=await inject(src.tab.id,inspectChatLengthLimit);
        if(!alert.eligible || !alert.warning)continue;
        state={
          stage:"pause_pending",sessionKey:key,trackTitle:cfg.trackTitle,
          nextTitle:incrementTrackTitle(cfg.trackTitle),repository:cfg.repository,
          startedAt:Date.now(),sourceUrl:src.tab.url,sourceTabId:src.tab.id,
          groupId:src.group.groupId,windowId:src.tab.windowId,
          projectId:src.projectId,
          projectNewUrl:"https://chatgpt.com/g/"+encodeURIComponent(src.projectId)+"/project",
          reason:"LENGTH_LIMIT_DETECTED"
        };
        // Prevent a second migration on this same URL, even after restart.
        await writeSettings(configs.map(c=>c.sessionKey===key?
          {...c,lastTriggeredUrl:src.tab.url}:c));
        await persist(progress,key,state);
        events.push({sessionKey:key,stage:state.stage});
        continue;
      }
      if(state.stage==="pause_pending"){
        await bridgeCommand("/api/v1/bridge/migration-pause",{sessionKey:key});
        if(!src || src.tab.id!==state.sourceTabId ||
          src.tab.url!==state.sourceUrl)
          throw Error("AUTO_MIGRATION_SOURCE_CHANGED");
        const page=await inject(src.tab.id,inspectMigrationSource);
        if(!page.ok)throw Error(page.reason);
        state.sourceAssistantCount=page.assistantCount;
        state.stage="request_pending";await persist(progress,key,state);
      }else if(state.stage==="request_pending"){
        if(!src || src.tab.id!==state.sourceTabId || src.tab.url!==state.sourceUrl)
          throw Error("AUTO_MIGRATION_SOURCE_CHANGED");
        state.stage="request_unknown";await persist(progress,key,state);
        let sent;
        try {sent=await inject(src.tab.id,submitToExistingChatGPT,[
          migrationPrompt({repository:cfg.repository,trackTitle:state.trackTitle})
        ]);}
        catch{throw Error("AUTO_MIGRATION_REQUEST_UNCERTAIN");}
        state.stage=sent.clicked?"awaiting_source_reply":"fallback_pending";
        state.reason=sent.reason;
        await persist(progress,key,state);
      }else if(state.stage==="awaiting_source_reply"){
        if(!src||src.tab.id!==state.sourceTabId||src.tab.url!==state.sourceUrl)
          throw Error("AUTO_MIGRATION_SOURCE_CHANGED");
        const result=await inject(src.tab.id,copyLastMigrationAssistant,[
          state.sourceAssistantCount,MIGRATION_MARKER,MAX_HANDOFF_CHARS
        ]);
        if(result.ok){
          state.body=result.body;
          state.stage="ready_to_create";
          await persist(progress,key,state);
        }else if(Date.now()-state.startedAt>10*60_000){
          state.stage="fallback_pending";state.reason="HANDOFF_RESPONSE_TIMEOUT";
          await persist(progress,key,state);
        }
      }else if(state.stage==="fallback_pending"){
        if(!src||src.tab.id!==state.sourceTabId||src.tab.url!==state.sourceUrl)
          throw Error("AUTO_MIGRATION_SOURCE_CHANGED");
        const last=await inject(src.tab.id,copyLastAssistantContext,[6000]);
        if(!last.ok)throw Error(last.reason);
        state.body=fallbackRoadmapHandoff({
          repository:cfg.repository,trackTitle:state.trackTitle,
          lastAssistant:last.body
        });
        state.reason=last.truncated?"LAST_ASSISTANT_TRUNCATED":
          "LAST_ASSISTANT_ROADMAP_RECHECK";
        state.stage="ready_to_create";await persist(progress,key,state);
      }else if(state.stage==="ready_to_create"){
        state.stage="creating_target_unknown";await persist(progress,key,state);
        const target=await chrome.tabs.create({
          windowId:state.windowId,url:state.projectNewUrl,active:false
        });
        if(!Number.isInteger(target?.id))throw Error("AUTO_MIGRATION_TARGET_CREATE_UNCERTAIN");
        state.targetTabId=target.id;
        await persist(progress,key,state);
        await chrome.tabs.group({tabIds:[target.id],groupId:state.groupId});
        state.stage="awaiting_target_page";
        await persist(progress,key,state);
      }else if(state.stage==="awaiting_target_page"){
        const target=checkedTarget(state,snapshot);
        if(target.url!==state.projectNewUrl)continue;
        if(target.status==="loading")continue;
        state.stage="transfer_unknown";await persist(progress,key,state);
        let sent;
        try{sent=await inject(target.id,submitToExistingChatGPT,[state.body,"handoff"]);}
        catch{throw Error("AUTO_MIGRATION_SEND_UNCERTAIN");}
        if(!sent.clicked)throw Error(sent.reason||"AUTO_MIGRATION_SEND_BLOCKED");
        state.body=null; // Never keep copied text after one send attempt.
        state.reason=sent.reason;state.stage="awaiting_first_reply";
        await persist(progress,key,state);
      }else if(state.stage==="awaiting_first_reply"){
        const target=checkedTarget(state,snapshot);
        if(!migratedIntoSameProject(state.projectNewUrl,target.url))continue;
        const result=await inject(target.id,inspectMigrationTarget);
        if(!result.ok||!result.projectConversation)continue;
        if(result.busy||result.assistantCount<1||!result.lastReplyFingerprint){
          state.stableAt=null;state.replyFingerprint=null;
          await persist(progress,key,state);continue;
        }
        if(state.replyFingerprint!==result.lastReplyFingerprint || !state.stableAt){
          state.stableAt=Date.now();state.replyFingerprint=result.lastReplyFingerprint;
          await persist(progress,key,state);continue;
        }
        if(Date.now()-state.stableAt<6000)continue;
        state.stage="rename_unknown";await persist(progress,key,state);
        let rename;
        try{rename=await inject(target.id,renameMigrationConversation,[state.nextTitle]);}
        catch{throw Error("AUTO_MIGRATION_RENAME_UNCERTAIN");}
        state.stage=rename.ok?"rebind_pending":"needs_attention";
        state.reason=rename.reason||"AUTO_MIGRATION_RENAME_NOT_VERIFIED";
        await persist(progress,key,state);
      }else if(state.stage==="rebind_pending"){
        const target=checkedTarget(state,snapshot);
        if(!migratedIntoSameProject(state.projectNewUrl,target.url))
          throw Error("AUTO_MIGRATION_TARGET_NOT_CREATED");
        const record=registry.sessions.find(s=>s.key===key);
        if(!record || record.tabId!==state.sourceTabId ||
          record.url!==state.sourceUrl)
          throw Error("AUTO_MIGRATION_ORIGINAL_REGISTRATION_CHANGED");
        state.stage="rebind_unknown";await persist(progress,key,state);
        const next=applyAction(registry,{type:"rebindTab",sessionKey:key,
          tabId:target.id},snapshot,epoch,()=>crypto.randomUUID(),Date.now());
        await chrome.storage.local.set({[STORAGE_KEY]:next});
        state.stage="resync_pending";await persist(progress,key,state);
      }else if(state.stage==="resync_pending"){
        const synced=await syncRegistry();
        if(!synced.connected)continue;
        state.stage="resume_pending";await persist(progress,key,state);
      }else if(state.stage==="resume_pending"){
        const resumed=await bridgeCommand("/api/v1/bridge/migration-resume",
          {sessionKey:key});
        state.stage="completed";state.finishedAt=Date.now();
        state.reason=resumed.resumed?"AUTO_CONTINUATION_RESUMED":
          "MIGRATION_COMPLETE_NO_ACTIVE_SCHEDULE";
        state.body=null;await persist(progress,key,state);
        await writeSettings((await storedSettings()).map(x=>x.sessionKey===key?
          {...x,trackTitle:state.nextTitle}:x));
      }
      events.push({sessionKey:key,stage:state.stage});
    }catch(error){
      const current=progress[key];
      if(current){
        current.stage="needs_attention";
        current.reason=String(error?.message||"AUTO_MIGRATION_UNKNOWN").slice(0,130);
        current.body=null;
        await persist(progress,key,current);
        events.push({sessionKey:key,stage:current.stage,reason:current.reason});
      }
    }
  }
  return events;
}
