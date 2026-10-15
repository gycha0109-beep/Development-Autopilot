import {STORAGE_KEY,sessionStatus,applyAction} from "./core.js";
import {
  incrementTrackTitle,migrationPrompt,
  MIGRATION_MARKER,MAX_HANDOFF_CHARS,migratedIntoSameProject,
  projectIdFromUrl
} from "./migration-core.js";
import {
  inspectChatLengthLimit,inspectMigrationSource,copyLastMigrationAssistant,
  inspectMigrationTarget,renameMigrationConversation,
  readRegisteredChatTitle,inspectAuthoredHandoffDomShape,
  inspectAlreadyTransferredHandoff
} from "./migration-page.js";
import {submitToExistingChatGPT} from "./chat-page.js";

export const AUTO_MIGRATION_KEY="autopilot.migration.auto.config.v1";
export const AUTO_MIGRATION_PROGRESS_KEY="autopilot.migration.auto.progress.v1";
export const AUTO_MIGRATION_TEST_KEY="autopilot.migration.auto.test-trigger.v1";
export const AUTO_MIGRATION_REMOVED_URLS_KEY="autopilot.migration.removed-url-guards.v1";
const TEST_TRIGGER_TTL_MS=5*60_000;
const limited=(value,max)=>typeof value==="string"&&value.trim().length>0&&value.length<=max;
const repoValid=r=>limited(r,160)&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r);
const visibleState=s=>s?({
  stage:s.stage,reason:s.reason||null,trackTitle:s.trackTitle,
  nextTitle:s.nextTitle,sourceSessionKey:s.sessionKey,
  sourceAtLimit:!s.syntheticTrigger,syntheticTrigger:Boolean(s.syntheticTrigger),startedAt:s.startedAt||null,
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
const readTriggers=async()=>{
  const row=await chrome.storage.session.get(AUTO_MIGRATION_TEST_KEY);
  return row[AUTO_MIGRATION_TEST_KEY]||{};
};
const writeTriggers=async value=>chrome.storage.session.set({[AUTO_MIGRATION_TEST_KEY]:value});
export async function getAutoMigrationWatchSessionKeys(){
  return (await storedSettings()).map(x=>x.sessionKey);
}
// Keep the pre-existing same-URL no-replay guard after a monitor is removed.
// Removing a watcher must never authorize another original-chat instruction.
async function removeWatchEntries(keys){
  if(!keys.size)return [];
  const configs=await storedSettings();
  const removed=configs.filter(c=>keys.has(c.sessionKey));
  const guard=(await chrome.storage.local.get(AUTO_MIGRATION_REMOVED_URLS_KEY))[
    AUTO_MIGRATION_REMOVED_URLS_KEY]||{};
  for(const item of removed){
    if(item.lastTriggeredUrl)guard[item.sessionKey]=item.lastTriggeredUrl;
  }
  const kept=configs.filter(c=>!keys.has(c.sessionKey));
  if(removed.length){
    await chrome.storage.local.set({
      [AUTO_MIGRATION_REMOVED_URLS_KEY]:guard,
      [AUTO_MIGRATION_KEY]:kept
    });
  }
  const progress=await storedProgress();
  const triggers=await readTriggers();
  let progressChanged=false,triggerChanged=false;
  for(const key of keys){
    if(Object.hasOwn(progress,key)){delete progress[key];progressChanged=true;}
    if(Object.hasOwn(triggers,key)){delete triggers[key];triggerChanged=true;}
  }
  if(progressChanged)await writeProgress(progress);
  if(triggerChanged)await writeTriggers(triggers);
  return removed.map(c=>c.sessionKey);
}
// Reconcile only keys that were explicitly deregistered or revoked by the
// authenticated local bridge. A temporarily disconnected tab stays enrolled.
export async function cleanupAutoMigrationWatchers(registry,{revokedSessionKeys=[]}={}){
  const valid=new Set(registry.sessions.map(s=>s.key));
  const configured=await storedSettings();
  const dead=new Set(configured.filter(c=>!valid.has(c.sessionKey))
    .map(c=>c.sessionKey));
  for(const key of revokedSessionKeys){
    if(typeof key==="string")dead.add(key);
  }
  await removeWatchEntries(dead);
  return view(await storedSettings(),await storedProgress());
}
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
  // Lock the newly created conversation; an unrelated sidebar click in this
  // project must never become the target of a handoff or rename.
  if(state.targetConversationUrl && tab.url!==state.targetConversationUrl)
    throw Error("AUTO_MIGRATION_TARGET_CONVERSATION_CHANGED");
  return tab;
}
async function persist(progress,key,state){
  progress[key]=state;
  await writeProgress(progress);
}
async function verifyRepairTitle(tabId,expected,sourceTitle,repository,operatorTitle){
  const actual=await inject(tabId,readRegisteredChatTitle,[expected]);
  if(actual.ok && actual.title===expected)
    return {method:"CHATGPT_DOM_VERIFIED"};
  const error=actual.ok?"AUTO_MIGRATION_TITLE_MISMATCH":
    "AUTO_MIGRATION_TITLE_READ_"+actual.reason+
      (actual.diagnostic?" ("+
        Object.entries(actual.diagnostic).map(([k,v])=>k+"="+v).join(",")+")":"");
  if(operatorTitle===undefined || operatorTitle===null)throw Error(error);
  // A human can attest an exact visible title when the current ChatGPT
  // sidebar does not render a URL-bearing chat link and document.title has
  // not updated. The user's explicit input is not browser verification.
  if(typeof operatorTitle!=="string" || operatorTitle.trim()!==expected)
    throw Error("AUTO_MIGRATION_OPERATOR_TITLE_NOT_EXPECTED");
  if(actual.ok || ![
    "CHAT_TITLE_NO_MATCHING_CONVERSATION_LINK",
    "CHAT_TITLE_LINK_TITLE_NOT_READABLE"
  ].includes(actual.reason))
    throw Error("AUTO_MIGRATION_OPERATOR_TITLE_CONFLICTING_DOM_PROOF");
  // The exact registered target tab/project is verified by the caller; even
  // operator attestation cannot substitute a title for the actual handoff.
  const proof=await inject(tabId,inspectAlreadyTransferredHandoff,[
    MIGRATION_MARKER,repository,sourceTitle,expected
  ]);
  if(!proof.ok)
    throw Error("AUTO_MIGRATION_OPERATOR_TITLE_"+proof.reason);
  return {method:"OPERATOR_ATTESTED_VISIBLE_TITLE"};
}
export async function autoMigrationCommand(message,{registry,snapshot,epoch}){
  const configs=await storedSettings();
  const progress=await storedProgress();
  if(message.type==="AP_AUTO_MIGRATION_STATE")
    return cleanupAutoMigrationWatchers(registry);
  if(message.type==="AP_AUTO_MIGRATION_REMOVE"){
    if(message.confirm!==true)throw Error("AUTO_MIGRATION_REMOVE_CONFIRM_REQUIRED");
    const entry=configs.find(c=>c.sessionKey===message.sessionKey);
    if(!entry)throw Error("AUTO_MIGRATION_MONITOR_NOT_FOUND");
    await removeWatchEntries(new Set([entry.sessionKey]));
    return view(await storedSettings(),await storedProgress());
  }
  if(message.type==="AP_AUTO_MIGRATION_RESET_FAILED"){
    const key=message.sessionKey;
    const config=configs.find(x=>x.sessionKey===key);
    const failed=progress[key];
    if(!config||!failed || failed.stage!=="needs_attention")
      throw Error("AUTO_MIGRATION_RESET_REQUIRES_FAILED_TRACK");
    // Previous send or tab creation may have been uncertain. An operator
    // must consciously clear the old failure and inspect the old composer
    // before a new request can be attempted.
    if(message.confirm!==true)throw Error("AUTO_MIGRATION_RESET_CONFIRM_REQUIRED");
    delete progress[key];
    await writeProgress(progress);
    await writeSettings(configs.map(item=>item.sessionKey===key?
      {...item,lastTriggeredUrl:null}:item));
    const triggers=await readTriggers();
    delete triggers[key];await writeTriggers(triggers);
    return {reset:true,tracks:view(await storedSettings(),progress).tracks};
  }
  if(message.type==="AP_AUTO_MIGRATION_DOM_DIAGNOSE"){
    // Diagnostic never mutates the watch/progress state, pauses schedules,
    // or sends any messages to either the source or the destination.
    const live=source(registry,snapshot,epoch,message.sessionKey);
    if(!live)throw Error("AUTO_MIGRATION_DIAGNOSTIC_CONNECTED_CHAT_REQUIRED");
    return inject(live.tab.id,inspectAuthoredHandoffDomShape,[MIGRATION_MARKER]);
  }
  if(message.type==="AP_AUTO_MIGRATION_CONFIRM_FIRST_REPLY"){
    if(message.confirm!==true)
      throw Error("AUTO_MIGRATION_REPLY_CONFIRM_REQUIRED");
    const state=progress[message.sessionKey];
    if(!state||state.stage!=="awaiting_first_reply")
      throw Error("AUTO_MIGRATION_NOT_AWAITING_FIRST_REPLY");
    // The operator can certify an answer when ChatGPT renders no assistant
    // role attributes. This cannot authorize another send or another chat.
    const target=checkedTarget(state,snapshot);
    if(!migratedIntoSameProject(state.projectNewUrl,target.url) ||
       !state.targetConversationUrl ||
       target.url!==state.targetConversationUrl)
      throw Error("AUTO_MIGRATION_TARGET_CONVERSATION_UNVERIFIED");
    const record=registry.sessions.find(x=>x.key===message.sessionKey);
    if(!record||record.tabId!==target.id||record.url!==target.url)
      throw Error("AUTO_MIGRATION_TARGET_REGISTRATION_NOT_READY");
    state.firstReplyConfirmedByOperator=true;
    state.stage="rename_pending";
    state.reason="OPERATOR_VERIFIED_TARGET_FIRST_ASSISTANT_REPLY";
    await persist(progress,message.sessionKey,state);
    return {accepted:true,stage:state.stage,nextTitle:state.nextTitle};
  }
  if(message.type==="AP_AUTO_MIGRATION_CONFIRM_TITLE"){
    if(message.confirm!==true)
      throw Error("AUTO_MIGRATION_TITLE_CONFIRM_REQUIRED");
    const key=message.sessionKey;
    const state=progress[key];
    if(!state){
      // chrome.storage.session is lost on extension reload. Do not force a
      // second enrollment: recover ONLY the existing original session/tab.
      const cfg=configs.find(x=>x.sessionKey===key&&x.enabled);
      const record=registry.sessions.find(x=>x.key===key);
      const group=registry.groups.find(x=>x.key===record?.groupKey);
      const target=snapshot.tabs.find(x=>x.id===record?.tabId);
      const liveGroup=snapshot.groups.find(g=>
        g.id===group?.groupId && g.windowId===group?.windowId);
      const targetProject=projectIdFromUrl(target?.url);
      const recordedProject=projectIdFromUrl(record?.url);
      const triggerProject=projectIdFromUrl(cfg?.lastTriggeredUrl);
      // A reload may have lost the trigger URL while retaining the original
      // registered tab and monitor. Missing trigger history alone cannot
      // disqualify a read-only, operator-confirmed content-verified repair.
      // Retain stronger source-or-target URL matching when it *is* present.
      const proofs={
        enabledWatch:!!cfg,
        existingSession:!!record,
        existingGroup:!!group,
        originalTabPresent:!!target,
        physicalGroupPresent:!!liveGroup,
        samePhysicalTab:!!(record&&target&&record.tabId===target.id),
        sameWindowAndGroup:!!(record&&group&&target&&
          target.groupId===group.groupId &&
          target.windowId===group.windowId),
        targetIsProjectConversation:!!(targetProject &&
          /^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(target.url||"")),
        recordedProjectMatches:!!(targetProject&&recordedProject===targetProject),
        triggerProjectMatches:!cfg?.lastTriggeredUrl ||
          !!(targetProject&&triggerProject===targetProject),
        knownTriggerURLMatches:!cfg?.lastTriggeredUrl ||
          !!(record&&[cfg.lastTriggeredUrl,target?.url].includes(record.url))
      };
      const failed=Object.entries(proofs).filter(([,ok])=>!ok).map(([name])=>name);
      if(failed.length)
        throw Error("AUTO_MIGRATION_REPAIR_ORIGINAL_SESSION_PROOF_REQUIRED ("+
          failed.join(",")+")");
      const nextTitle=incrementTrackTitle(cfg.trackTitle);
      const titleProof=await verifyRepairTitle(target.id,nextTitle,
        cfg.trackTitle,cfg.repository,message.operatorTitle);
      const proof=await inject(target.id,inspectAlreadyTransferredHandoff,[
        MIGRATION_MARKER,cfg.repository,cfg.trackTitle,nextTitle
      ]);
      if(!proof.ok)
        throw Error("AUTO_MIGRATION_REPAIR_"+proof.reason);
      // Reload invalidates the previous browser epoch. Restoring the entire
      // group via rebindGroup would mark all sibling workstreams for rebinding.
      // Repair only the proven original group and selected tab; never activate
      // another session or change any of its stored identifiers.
      const nextRegistry=structuredClone(registry);
      const sameGroup=nextRegistry.groups.find(g=>g.key===group.key);
      if(nextRegistry.groups.some(g=>g.key!==group.key &&
         g.groupId===group.groupId && g.windowId===group.windowId))
        throw Error("AUTO_MIGRATION_REPAIR_GROUP_AMBIGUOUS");
      sameGroup.sessionToken=epoch;
      const next=applyAction(nextRegistry,{
        type:"rebindTab",sessionKey:key,tabId:target.id
      },snapshot,epoch,()=>crypto.randomUUID(),Date.now());
      const repaired=next.sessions.find(x=>x.key===key);
      repaired.title=nextTitle;
      const nextSettings=configs.map(x=>x.sessionKey===key?
        {...x,trackTitle:nextTitle}:x);
      // No previous progress survives; restoring a prior schedule without
      // proof of its pause/resume state would be unsafe. The local bridge is
      // synced by the caller, and the operator reviews schedule status.
      await chrome.storage.local.set({
        [STORAGE_KEY]:next,[AUTO_MIGRATION_KEY]:nextSettings
      });
      return {accepted:true,stage:"registration_repaired_schedule_review",
        nextTitle,sessionKey:key,tabId:target.id,scheduleRestored:false,
        titleVerification:titleProof.method};
    }
    const titleBlocked=state?.stage==="needs_attention" &&
      /^MIGRATION_TITLE_(?:CHAT_MENU_NOT_FOUND|RENAME_ACTION_NOT_FOUND|EDITOR_NOT_FOUND|SAVE_NOT_FOUND|SAVE_UNVERIFIED|EDITOR_UNSUPPORTED|TEXT_MISMATCH)$/.test(state.reason||"");
    if(!state || !(
      ["awaiting_first_reply","rename_pending","rebind_pending"].includes(state.stage) ||
      titleBlocked))
      throw Error("AUTO_MIGRATION_TITLE_CONFIRM_NOT_ELIGIBLE");
    // Only the *same* registered Chrome tab and exact already observed target
    // conversation can be recovered. Do not silently claim another tab.
    const target=checkedTarget(state,snapshot);
    if(!state.targetConversationUrl || target.url!==state.targetConversationUrl ||
       state.targetTabId!==state.sourceTabId ||
       !migratedIntoSameProject(state.projectNewUrl,target.url))
      throw Error("AUTO_MIGRATION_TARGET_CONVERSATION_UNVERIFIED");
    const record=registry.sessions.find(session=>session.key===key);
    const group=registry.groups.find(g=>g.key===record?.groupKey);
    if(!record || !group || record.tabId!==target.id ||
       group.groupId!==state.groupId || group.windowId!==state.windowId ||
       group.sessionToken!==epoch || record.sessionToken!==epoch ||
       ![state.sourceUrl,state.targetConversationUrl].includes(record.url))
      throw Error("AUTO_MIGRATION_EXISTING_REGISTRATION_REQUIRED");
    const cfg=configs.find(c=>c.sessionKey===key&&c.enabled);
    if(!cfg || cfg.repository!==state.repository ||
       cfg.trackTitle!==state.trackTitle)
      throw Error("AUTO_MIGRATION_OPERATOR_TITLE_SOURCE_CONFIG_CHANGED");
    const titleProof=await verifyRepairTitle(target.id,state.nextTitle,
      state.trackTitle,state.repository,message.operatorTitle);
    // Title alone is insufficient to identify the target; we have also
    // proved exact tab, group, original session and conversation URL.
    // Persist the potentially side-effecting repair intent first. If the
    // worker dies midway, STOP rather than attempting an unverified replay.
    state.stage="rebind_unknown";
    state.reason="OPERATOR_VERIFIED_TITLE_AND_EXISTING_TARGET";
    await persist(progress,key,state);
    const next=applyAction(registry,{
      type:"rebindTab",sessionKey:key,tabId:target.id
    },snapshot,epoch,()=>crypto.randomUUID(),Date.now());
    const updated=next.sessions.find(session=>session.key===key);
    updated.title=state.nextTitle;
    await chrome.storage.local.set({[STORAGE_KEY]:next});
    state.registryRebound=true;
    state.firstReplyConfirmedByOperator=true;
    state.stage="resync_pending";
    state.reason="OPERATOR_VERIFIED_TITLE_REGISTRATION_REPAIRED";
    await persist(progress,key,state);
    return {accepted:true,stage:state.stage,nextTitle:state.nextTitle,
      sessionKey:key,tabId:target.id,titleVerification:titleProof.method};
  }
  if(message.type==="AP_AUTO_MIGRATION_RECOVER"){
    if(message.confirm!==true)throw Error("AUTO_MIGRATION_RECOVERY_CONFIRM_REQUIRED");
    const key=message.sessionKey;
    const cfg=configs.find(item=>item.sessionKey===key&&item.enabled);
    if(!cfg)throw Error("AUTO_MIGRATION_RECOVERY_ENABLED_TRACK_REQUIRED");
    const live=source(registry,snapshot,epoch,key);
    if(!live)throw Error("AUTO_MIGRATION_RECOVERY_CONNECTED_PROJECT_CHAT_REQUIRED");
    const old=progress[key];
    // A previous conversation's in-flight response cannot authorize a new tab.
    if(old && (old.sourceUrl!==live.tab.url ||
       old.sourceTabId!==live.tab.id || old.projectId!==live.projectId))
      throw Error("AUTO_MIGRATION_RECOVERY_ORIGINAL_CHANGED");
    // A reset or monitor re-registration may lose the in-flight trigger.
    // Never replay the original instruction: recover only after proving the
    // assistant handoff and the exact original repository/track request.
    const missingTriggerSnapshot=!old && cfg.lastTriggeredUrl!==live.tab.url;
    if(old && !(
      old.stage==="awaiting_source_reply" ||
      (old.stage==="needs_attention" &&
        /^SOURCE_MIGRATION_RESPONSE_NOT_RECEIVED_/.test(old.reason||""))
    ))throw Error("AUTO_MIGRATION_RECOVERY_ACTIVE_OR_UNSAFE_STAGE");
    if(old?.targetTabId || old?.body)
      throw Error("AUTO_MIGRATION_RECOVERY_TARGET_ALREADY_STARTED");
    const title=await inject(live.tab.id,readRegisteredChatTitle);
    if(!title.ok)throw Error(title.reason);
    const nextTitle=incrementTrackTitle(title.title);
    // Prefer matching original request and assistant. If the request was
    // virtualized, use only a saved pre-send assistant ID from this exact
    // original in-flight chat, not a count of mounted DOM turns.
    const priorAssistantId=old?.sourceLastAssistantId||null;
    const reply=await inject(live.tab.id,copyLastMigrationAssistant,[
      null,MIGRATION_MARKER,MAX_HANDOFF_CHARS,
      priorAssistantId,old?.sourceLastUserId||null,true,
      missingTriggerSnapshot?{repository:cfg.repository,trackTitle:title.title}:null
    ]);
    if(!reply.ok){
      // Only shape counts, never transcript text or payload contents.
      const shape=reply.diagnostic?
        " ("+Object.entries(reply.diagnostic)
          .map(([key,value])=>key+"="+String(value)).join(",")+")":"";
      throw Error("AUTO_MIGRATION_RECOVERY_"+reply.reason+shape);
    }
    if(reply.evidence!=="ORIGINAL_USER_REQUEST_PRECEDES_ASSISTANT" &&
       reply.evidence!=="UNATTRIBUTED_SOURCE_REQUEST_MARKER_CODEBLOCK" &&
       reply.evidence!=="UNATTRIBUTED_SOURCE_REQUEST_MARKER_TEXT" &&
       reply.evidence!=="UNATTRIBUTED_SOURCE_REQUEST_WRITING_BLOCK" &&
       !(priorAssistantId && reply.evidence==="NEW_ASSISTANT_ID"))
      throw Error("AUTO_MIGRATION_RECOVERY_REQUEST_PROVENANCE_REQUIRED");
    if(missingTriggerSnapshot && !(reply.sourceContextVerified===true &&
       ["ORIGINAL_USER_REQUEST_PRECEDES_ASSISTANT",
        "UNATTRIBUTED_SOURCE_REQUEST_MARKER_CODEBLOCK",
        "UNATTRIBUTED_SOURCE_REQUEST_MARKER_TEXT",
         "UNATTRIBUTED_SOURCE_REQUEST_WRITING_BLOCK"].includes(reply.evidence)))
      throw Error("AUTO_MIGRATION_RECOVERY_MISSING_TRIGGER_PROOF_REQUIRED");
    const restored={
      stage:"recovered_pause_pending",sessionKey:key,trackTitle:title.title,
      nextTitle,repository:cfg.repository,sourceTabId:live.tab.id,
      sourceUrl:live.tab.url,groupId:live.group.groupId,
      windowId:live.tab.windowId,projectId:live.projectId,
      projectNewUrl:"https://chatgpt.com/g/"+encodeURIComponent(live.projectId)+"/project",
      startedAt:Date.now(),body:reply.body,
      reason:missingTriggerSnapshot?
        "ORIGINAL_AUTHORED_HANDOFF_RECOVERED_WITHOUT_TRIGGER_SNAPSHOT":
        "ORIGINAL_AUTHORED_HANDOFF_RECOVERED",
      recovered:true,restoredWithoutTriggerSnapshot:missingTriggerSnapshot
    };
    await writeSettings(configs.map(item=>item.sessionKey===key?
      {...item,lastTriggeredUrl:live.tab.url}:item));
    await persist(progress,key,restored);
    return {accepted:true,stage:restored.stage,sourceTitle:title.title,
      nextTitle,reason:restored.reason};
  }
  if(message.type==="AP_AUTO_MIGRATION_INSPECT" ||
     message.type==="AP_AUTO_MIGRATION_START"){
    const key=message.sessionKey;
    const cfg=configs.find(x=>x.sessionKey===key && x.enabled);
    if(!cfg)throw Error("AUTO_MIGRATION_ENABLED_TRACK_REQUIRED");
    const live=source(registry,snapshot,epoch,key);
    if(!live)throw Error("AUTO_MIGRATION_REGISTERED_PROJECT_CHAT_NOT_CONNECTED");
    const detection=await inject(live.tab.id,inspectChatLengthLimit);
    if(message.type==="AP_AUTO_MIGRATION_INSPECT")
      return {sessionKey:key,sourceTitle:cfg.trackTitle,
        sourceUrl:live.tab.url,eligible:detection.eligible,
        warning:detection.warning,reason:detection.reason||null,
        progress:visibleState(progress[key])};
    if(message.confirm!==true)
      throw Error("AUTO_MIGRATION_MANUAL_CONFIRM_REQUIRED");
    if(!detection.eligible)throw Error("AUTO_MIGRATION_CHAT_NOT_ELIGIBLE");
    if(cfg.lastTriggeredUrl===live.tab.url)
      throw Error("AUTO_MIGRATION_ALREADY_ATTEMPTED_ON_CHAT");
    const previous=progress[key];
    if(previous && previous.stage!=="completed")
      throw Error("AUTO_MIGRATION_ALREADY_RUNNING_OR_FAILED");
    const triggers=await readTriggers();
    if(triggers[key] && Date.now()-triggers[key].createdAt<TEST_TRIGGER_TTL_MS)
      throw Error("AUTO_MIGRATION_TRIGGER_ALREADY_QUEUED");
    triggers[key]={url:live.tab.url,createdAt:Date.now(),kind:"manual"};
    await writeTriggers(triggers);
    return {accepted:true,sessionKey:key,
      reason:detection.warning?"VISIBLE_WARNING_OPERATOR_CONFIRMED":
        "REGISTERED_CHAT_OPERATOR_CONFIRMED_NO_VISIBLE_WARNING"};
  }
  if(message.type==="AP_AUTO_MIGRATION_TEST"){
    const config=configs.find(c=>c.sessionKey===message.sessionKey && c.enabled);
    if(!config)throw Error("AUTO_MIGRATION_TEST_REQUIRES_ENABLED_TRACK");
    const live=source(registry,snapshot,epoch,config.sessionKey);
    if(!live)throw Error("AUTO_MIGRATION_TEST_REQUIRES_CONNECTED_PROJECT_CHAT");
    if(config.lastTriggeredUrl===live.tab.url)
      throw Error("AUTO_MIGRATION_TEST_ALREADY_USED_ON_CHAT");
    const old=progress[config.sessionKey];
    if(old && old.stage!=="completed")throw Error("AUTO_MIGRATION_TEST_ALREADY_RUNNING");
    const triggers=await readTriggers();
    if(triggers[config.sessionKey] && Date.now()-triggers[config.sessionKey].createdAt<TEST_TRIGGER_TTL_MS)
      throw Error("AUTO_MIGRATION_TEST_ALREADY_QUEUED");
    triggers[config.sessionKey]={url:live.tab.url,createdAt:Date.now()};
    await writeTriggers(triggers);
    return {accepted:true,sessionKey:config.sessionKey,reason:"ONE_SHOT_WARNING_SIMULATED_ON_NEXT_SYNC"};
  }
  if(message.type!=="AP_AUTO_MIGRATION_CONFIG")
    throw Error("AUTO_MIGRATION_UNSUPPORTED_COMMAND");
  const {sessionKey,enabled,repository}=message;
  if(!limited(sessionKey,80)||typeof enabled!=="boolean")
    throw Error("AUTO_MIGRATION_INVALID_CONFIG");
  const existing=configs.find(c=>c.sessionKey===sessionKey);
  if(enabled){
    if(!repoValid(repository))throw Error("AUTO_MIGRATION_REPOSITORY_REQUIRED");
    const registered=source(registry,snapshot,epoch,sessionKey);
    if(!registered)throw Error("AUTO_MIGRATION_PROJECT_CONVERSATION_REQUIRED");
    const detected=await inject(registered.tab.id,readRegisteredChatTitle);
    if(!detected.ok)throw Error(detected.reason);
    const trackTitle=detected.title;
    incrementTrackTitle(trackTitle);
    if(progress[sessionKey] && !["completed","needs_attention"].includes(progress[sessionKey].stage))
      throw Error("AUTO_MIGRATION_ALREADY_RUNNING");
    const removedGuards=(await chrome.storage.local.get(AUTO_MIGRATION_REMOVED_URLS_KEY))[
      AUTO_MIGRATION_REMOVED_URLS_KEY]||{};
    const next={sessionKey,repository,trackTitle,enabled:true,
      lastTriggeredUrl:existing?.lastTriggeredUrl||removedGuards[sessionKey]||null};
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
  await cleanupAutoMigrationWatchers(registry);
  const configs=await storedSettings();
  if(!configs.some(c=>c.enabled))return [];
  const progress=await storedProgress();
  const testTriggers=await readTriggers();
  const events=[];
  for(const cfg of configs.filter(c=>c.enabled)){
    const key=cfg.sessionKey;
    const prev=progress[key];
    try{
      // Unknown side effects are never retried after background-worker restart.
      if(prev && ["request_unknown","creating_target_unknown",
        "navigating_target_unknown","transfer_unknown","rename_unknown",
        "rebind_unknown"].includes(prev.stage)){
        prev.stage="needs_attention";prev.reason="INTERRUPTED_UNCERTAIN_NO_REPLAY";
        prev.body=null;await persist(progress,key,prev);
        events.push({sessionKey:key,stage:prev.stage,reason:prev.reason});
        continue;
      }
      // Read-only stopped/paired check on every tick. No action when offline.
      const status=await bridgeCommand("/api/v1/bridge/status",{});
      if(status.stopped)continue;
      const src=source(registry,snapshot,epoch,key);
      let state=progress[key];
      if(!state || ["completed","needs_attention"].includes(state.stage)){
        if(state?.stage==="needs_attention")continue;
        if(!src || cfg.lastTriggeredUrl===src.tab.url)continue;
        const alert=await inject(src.tab.id,inspectChatLengthLimit);
        if(!alert.eligible)continue;
        const queued=testTriggers[key]?.url===src.tab.url &&
          Date.now()-testTriggers[key].createdAt>=0 &&
          Date.now()-testTriggers[key].createdAt<TEST_TRIGGER_TTL_MS;
        const testing=queued && testTriggers[key].kind!=="manual";
        const manual=queued && testTriggers[key].kind==="manual";
        if(!alert.warning && !testing && !manual)continue;
        // Read the live source title, not the cached title from when this
        // monitor was enabled. ChatGPT may have renamed it in the meantime.
        const detected=await inject(src.tab.id,readRegisteredChatTitle);
        if(!detected.ok){
          events.push({sessionKey:key,stage:"needs_attention",reason:detected.reason});
          continue;
        }
        const currentTitle=detected.title;
        incrementTrackTitle(currentTitle);
        // Consume before first side effect. Cannot re-run by refresh/crash.
        if(testTriggers[key]){
          delete testTriggers[key];
          await writeTriggers(testTriggers);
        }
        state={
          stage:"pause_pending",sessionKey:key,trackTitle:currentTitle,
          nextTitle:incrementTrackTitle(currentTitle),repository:cfg.repository,
          startedAt:Date.now(),sourceUrl:src.tab.url,sourceTabId:src.tab.id,
          groupId:src.group.groupId,windowId:src.tab.windowId,
          projectId:src.projectId,
          projectNewUrl:"https://chatgpt.com/g/"+encodeURIComponent(src.projectId)+"/project",
          reason:manual?"OPERATOR_CONFIRMED_SOURCE_FIRST_MIGRATION":
            testing?"SIMULATED_LENGTH_LIMIT_TRIGGER":"LENGTH_LIMIT_DETECTED",
          syntheticTrigger:testing,manualTrigger:manual
        };
        // Prevent a second migration on this same URL, even after restart.
        await writeSettings((await storedSettings()).map(c=>c.sessionKey===key?
          {...c,lastTriggeredUrl:src.tab.url}:c));
        await persist(progress,key,state);
        // Halt the already-approved repeat campaign in the SAME heartbeat.
        // No normal command should be claimed after this banner is discovered.
        const pause=await bridgeCommand("/api/v1/bridge/migration-pause",
          {sessionKey:key});
        state.stage="request_pending";
        state.reason=pause.previouslyScheduled?
          "SCHEDULE_PAUSED_FOR_MIGRATION":"LENGTH_LIMIT_MIGRATION_STARTED";
        const page=await inject(src.tab.id,inspectMigrationSource);
        if(!page.ok)throw Error(page.reason);
        state.sourceAssistantCount=page.assistantCount;
        state.sourceLastAssistantId=page.lastAssistantId||null;
        state.sourceLastUserId=page.lastUserId||null;
        // Real and synthetic warning follow the SAME source-first protocol.
        // We do not create a new conversation before ChatGPT writes the
        // migration handoff in this exact existing chat.
        await persist(progress,key,state);
        events.push({sessionKey:key,stage:state.stage});
        continue;
      }
      if(state.stage==="recovered_pause_pending"){
        if(!src||src.tab.id!==state.sourceTabId||src.tab.url!==state.sourceUrl)
          throw Error("AUTO_MIGRATION_SOURCE_CHANGED");
        await bridgeCommand("/api/v1/bridge/migration-pause",{sessionKey:key});
        state.stage="ready_to_create";
        state.reason="SOURCE_HANDOFF_RECOVERED_AND_WORKSTREAM_PAUSED";
        await persist(progress,key,state);
      }else if(state.stage==="pause_pending"){
        await bridgeCommand("/api/v1/bridge/migration-pause",{sessionKey:key});
        if(!src || src.tab.id!==state.sourceTabId ||
          src.tab.url!==state.sourceUrl)
          throw Error("AUTO_MIGRATION_SOURCE_CHANGED");
        const page=await inject(src.tab.id,inspectMigrationSource);
        if(!page.ok)throw Error(page.reason);
        state.sourceAssistantCount=page.assistantCount;
        state.sourceLastAssistantId=page.lastAssistantId||null;
        state.sourceLastUserId=page.lastUserId||null;
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
        state.stage=sent.clicked?"awaiting_source_reply":"needs_attention";
        state.reason=sent.clicked?"SOURCE_MIGRATION_REQUEST_SUBMITTED_WAIT_FOR_REPLY":
          "SOURCE_MIGRATION_REQUEST_NOT_SENT_"+(sent.reason||"UNKNOWN");
        await persist(progress,key,state);
      }else if(state.stage==="awaiting_source_reply"){
        if(!src||src.tab.id!==state.sourceTabId||src.tab.url!==state.sourceUrl)
          throw Error("AUTO_MIGRATION_SOURCE_CHANGED");
        const result=await inject(src.tab.id,copyLastMigrationAssistant,[
          state.sourceAssistantCount,MIGRATION_MARKER,MAX_HANDOFF_CHARS,
          state.sourceLastAssistantId||null,state.sourceLastUserId||null,
          true,{repository:cfg.repository,trackTitle:state.trackTitle}
        ]);
        if(result.ok){
          // Writing blocks stream text incrementally; accept only after two
          // identical full-body snapshots at least six seconds apart.
          if(result.evidence==="UNATTRIBUTED_SOURCE_REQUEST_WRITING_BLOCK"){
            const fingerprint=result.body.length+":"+
              [...result.body].reduce((h,c)=>
                Math.imul(h^c.charCodeAt(0),16777619)>>>0,2166136261);
            if(state.writingBlockFingerprint!==fingerprint ||
               !state.writingBlockStableAt){
              state.writingBlockFingerprint=fingerprint;
              state.writingBlockStableAt=Date.now();
              state.reason="WAITING_FOR_WRITING_BLOCK_STABLE";
              await persist(progress,key,state);
              continue;
            }
            if(Date.now()-state.writingBlockStableAt<6000)continue;
          }
          state.body=result.body;
          state.reason="SOURCE_ASSISTANT_HANDOFF_CAPTURED";
          state.stage="ready_to_create";
          await persist(progress,key,state);
        }else if(Date.now()-state.startedAt>10*60_000){
          state.stage="needs_attention";
          state.reason="SOURCE_MIGRATION_RESPONSE_NOT_RECEIVED_"+result.reason;
          await persist(progress,key,state);
        }else {
          state.reason="WAITING_FOR_ORIGINAL_ASSISTANT_HANDOFF_"+result.reason;
          await persist(progress,key,state);
        }
      }else if(state.stage==="fallback_pending"){
        // Compatibility with older installed workers: never turn a
        // previously blocked original request into a fabricated handoff.
        state.stage="needs_attention";
        state.reason="LEGACY_FALLBACK_REMOVED_SOURCE_HANDOFF_REQUIRED";
        state.body=null;
        await persist(progress,key,state);
      }else if(state.stage==="ready_to_create"){
        // Reuse the already registered Chrome tab. Its ChatGPT source
        // conversation remains available by its previous URL.
        if(!src || src.tab.id!==state.sourceTabId ||
           src.tab.url!==state.sourceUrl)
          throw Error("AUTO_MIGRATION_SOURCE_CHANGED_BEFORE_NAVIGATION");
        state.targetTabId=state.sourceTabId;
        state.stage="navigating_target_unknown";await persist(progress,key,state);
        const target=await chrome.tabs.update(state.sourceTabId,{
          url:state.projectNewUrl
        });
        if(target?.id!==state.sourceTabId ||
           target.windowId!==state.windowId ||
           target.groupId!==state.groupId)
          throw Error("AUTO_MIGRATION_SAME_TAB_NAVIGATION_UNCERTAIN");
        state.stage="awaiting_target_page";await persist(progress,key,state);
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
        // Bind the generated /c/ URL as soon as it is observed. The old
        // registered source URL is no longer current after same-tab navigation.
        if(!state.targetConversationUrl){
          state.targetConversationUrl=target.url;
          await persist(progress,key,state);
        }
        const record=registry.sessions.find(s=>s.key===key);
        if(!record || record.tabId!==state.sourceTabId)
          throw Error("AUTO_MIGRATION_ORIGINAL_REGISTRATION_CHANGED");
        if(record.url===state.sourceUrl || record.url===target.url){
          if(record.url!==target.url || record.tabId!==target.id){
            state.stage="rebind_unknown";await persist(progress,key,state);
            const next=applyAction(registry,{type:"rebindTab",
              sessionKey:key,tabId:target.id},snapshot,epoch,
              ()=>crypto.randomUUID(),Date.now());
            await chrome.storage.local.set({[STORAGE_KEY]:next});
            state.stage="awaiting_first_reply";await persist(progress,key,state);
          }
          state.registryRebound=true;
          await persist(progress,key,state);
        }else throw Error("AUTO_MIGRATION_ORIGINAL_REGISTRATION_CHANGED");
        if(state.firstReplyConfirmedByOperator===true){
          state.stage="rename_pending";await persist(progress,key,state);
          continue;
        }
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
        state.stage="rename_pending";await persist(progress,key,state);
      }else if(state.stage==="rename_pending"){
        const target=checkedTarget(state,snapshot);
        if(!state.targetConversationUrl ||
           target.url!==state.targetConversationUrl)
          throw Error("AUTO_MIGRATION_TARGET_CONVERSATION_UNVERIFIED");
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
        if(!record || ![state.sourceTabId,state.targetTabId].includes(record.tabId) ||
           ![state.sourceUrl,target.url].includes(record.url))
          throw Error("AUTO_MIGRATION_ORIGINAL_REGISTRATION_CHANGED");
        // Even if early URL rebinding already connected this tab, the
        // verified N+1 title must replace ChatGPT's temporary auto-title in
        // the local registry and bridge payload. No title is trusted before
        // rename succeeds or the operator verifies it from the actual UI.
        state.stage="rebind_unknown";await persist(progress,key,state);
        const next=applyAction(registry,{type:"rebindTab",sessionKey:key,
          tabId:target.id},snapshot,epoch,()=>crypto.randomUUID(),Date.now());
        next.sessions.find(session=>session.key===key).title=state.nextTitle;
        await chrome.storage.local.set({[STORAGE_KEY]:next});
        state.registryRebound=true;
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
