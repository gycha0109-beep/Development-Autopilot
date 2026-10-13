import { sessionStatus, applyAction, STORAGE_KEY } from "./core.js";
import { classifyChatGPTRoute } from "./chat-routes.js";
import {
  MIGRATION_SESSION_KEY, MAX_HANDOFF_CHARS, MIGRATION_MARKER,
  incrementTrackTitle, migrationPrompt, targetIsNewProject,
  migratedIntoSameProject
} from "./migration-core.js";
import {
  inspectMigrationSource, copyLastMigrationAssistant,
  inspectMigrationTarget, renameMigrationConversation
} from "./migration-page.js";
import { submitToExistingChatGPT } from "./chat-page.js";

const serializable=s=>s ? ({
  stage:s.stage,reason:s.reason||null,sourceKey:s.sourceKey,targetKey:s.targetKey,
  trackTitle:s.trackTitle,nextTitle:s.nextTitle,repository:s.repository,
  sourceAtLimit:Boolean(s.sourceAtLimit),promptLength:s.body?.length||0,
  promptPreview:s.stage==="review" ? s.body : undefined,
  firstReplySeen:Boolean(s.firstReplySeen),
  titleResult:s.titleResult||null,
  projectUrlChanged:Boolean(s.projectUrlChanged),
  continuationSent:Boolean(s.continuationSent)
}) : null;
const requireSession=(key,registry,snapshot,epoch)=>{
  const session=registry.sessions.find(s=>s.key===key);
  if(!session||sessionStatus(session,registry,snapshot,epoch)!=="connected")
    throw Error("MIGRATION_REGISTERED_TAB_NOT_CONNECTED");
  const group=registry.groups.find(g=>g.key===session.groupKey);
  if(session.paused||group?.paused)throw Error("MIGRATION_TAB_PAUSED");
  const live=snapshot.tabs.find(t=>t.id===session.tabId);
  if(!live)throw Error("MIGRATION_TAB_MISSING");
  return {session,tab:live,group};
};
const inject=async(tabId,func,args=[])=>{
  const result=await chrome.scripting.executeScript({
    target:{tabId,allFrames:false},world:"ISOLATED",func,args
  });
  if(result.length!==1||!result[0]?.result)throw Error("MIGRATION_PAGE_INJECTION_UNCERTAIN");
  return result[0].result;
};
const get=async()=> (await chrome.storage.session.get(MIGRATION_SESSION_KEY))[MIGRATION_SESSION_KEY]||null;
const set=async value=>chrome.storage.session.set({[MIGRATION_SESSION_KEY]:value});
const stateRequired=async()=>{const s=await get();if(!s)throw Error("MIGRATION_NOT_STARTED");return s};

// Track the same Chrome tab through expected first-message navigation. Never
// treat a different project/tab ID as the approved migration target.
function targetLive(s,snapshot,registry,epoch){
  const record=registry.sessions.find(x=>x.key===s.targetKey);
  const group=registry.groups.find(x=>x.key===record?.groupKey);
  const tab=snapshot.tabs.find(x=>x.id===s.targetTabId);
  if(!record||record.tabId!==s.targetTabId || !tab||!group||
     group.groupId!==tab.groupId||group.windowId!==tab.windowId ||
     record.sessionToken!==epoch||group.sessionToken!==epoch||
     record.paused||group.paused)
    throw Error("MIGRATION_TARGET_IDENTITY_CHANGED");
  if(tab.url!==s.targetUrl && !migratedIntoSameProject(s.targetUrl,tab.url))
    throw Error("MIGRATION_TARGET_PROJECT_CHANGED");
  return tab;
}

export async function handleMigrationMessage(message,{registry,snapshot,epoch}){
  const type=message.type;
  if(type==="AP_MIGRATION_STATE")return {migration:serializable(await get())};
  if(type==="AP_MIGRATION_CANCEL"){
    await chrome.storage.session.remove(MIGRATION_SESSION_KEY);
    return {migration:null};
  }
  if(type==="AP_MIGRATION_PREPARE"){
    if(await get())throw Error("MIGRATION_ACTIVE_CANCEL_FIRST");
    const {sourceKey,targetKey,trackTitle,repository}=message;
    if(!sourceKey||!targetKey||sourceKey===targetKey)
      throw Error("MIGRATION_REQUIRES_TWO_DIFFERENT_REGISTERED_TABS");
    const source=requireSession(sourceKey,registry,snapshot,epoch);
    const target=requireSession(targetKey,registry,snapshot,epoch);
    if(classifyChatGPTRoute(source.tab.url)!=="existing"||
       !targetIsNewProject(target.tab.url))
      throw Error("MIGRATION_SOURCE_EXISTING_AND_TARGET_PROJECT_NEW_REQUIRED");
    const instruction=migrationPrompt({repository,trackTitle});
    const details=await inject(source.tab.id,inspectMigrationSource);
    if(!details.ok)throw Error(details.reason);
    const state={
      stage:"request_unknown",sourceKey,targetKey,trackTitle,
      nextTitle:incrementTrackTitle(trackTitle),repository,
      sourceTabId:source.tab.id,targetTabId:target.tab.id,
      sourceUrl:source.tab.url,targetUrl:target.tab.url,
      sourceAtLimit:details.atLimit,sourceAssistantCount:details.assistantCount,
      createdAt:Date.now(),reason:null
    };
    // A crash after scheduling an injection cannot lead to duplicate request.
    await set(state);
    let response;
    try { response=await inject(source.tab.id,submitToExistingChatGPT,[instruction]);}
    catch { response={clicked:false,reason:"MIGRATION_SOURCE_SUBMISSION_UNKNOWN"};}
    state.stage=response.clicked?"awaiting_source_reply":"awaiting_manual";
    state.reason=response.clicked?"MIGRATION_REQUEST_SENT_UNVERIFIED":
      response.reason||"MIGRATION_SOURCE_CANNOT_SEND";
    await set(state);
    return {migration:serializable(state)};
  }
  const s=await stateRequired();
  if(type==="AP_MIGRATION_CAPTURE"){
    if(s.stage!=="awaiting_source_reply")throw Error("MIGRATION_NOT_AWAITING_REPLY");
    const source=requireSession(s.sourceKey,registry,snapshot,epoch);
    if(source.tab.id!==s.sourceTabId||source.tab.url!==s.sourceUrl)
      throw Error("MIGRATION_SOURCE_IDENTITY_CHANGED");
    const result=await inject(source.tab.id,copyLastMigrationAssistant,[
      s.sourceAssistantCount,MIGRATION_MARKER,MAX_HANDOFF_CHARS
    ]);
    if(!result.ok)return {migration:serializable(s),error:result.reason};
    s.body=result.body;s.stage="review";s.reason=null;
    await set(s);
    return {migration:serializable(s)};
  }
  if(type==="AP_MIGRATION_MANUAL"){
    if(!["awaiting_manual","awaiting_source_reply"].includes(s.stage))
      throw Error("MIGRATION_MANUAL_STAGE_INVALID");
    const body=typeof message.body==="string"?message.body.trim():"";
    if(body.length<80||body.length>MAX_HANDOFF_CHARS)throw Error("MIGRATION_PROMPT_LENGTH_INVALID");
    s.body=body;s.stage="review";s.reason="OPERATOR_PROVIDED_HANDOFF";
    await set(s);return {migration:serializable(s)};
  }
  if(type==="AP_MIGRATION_EDIT"){
    if(s.stage!=="review")throw Error("MIGRATION_PROMPT_NOT_REVIEWED");
    const body=typeof message.body==="string"?message.body.trim():"";
    if(body.length<80||body.length>MAX_HANDOFF_CHARS)throw Error("MIGRATION_PROMPT_LENGTH_INVALID");
    s.body=body;s.reason="OPERATOR_REVIEWED_AND_EDITED";
    await set(s);return {migration:serializable(s)};
  }
  if(type==="AP_MIGRATION_TRANSFER"){
    if(s.stage!=="review"||!s.body)throw Error("MIGRATION_PROMPT_NOT_REVIEWED");
    const target=requireSession(s.targetKey,registry,snapshot,epoch);
    if(target.tab.id!==s.targetTabId||target.tab.url!==s.targetUrl||
       !targetIsNewProject(target.tab.url))
      throw Error("MIGRATION_TARGET_NOT_REGISTERED_PROJECT_NEW");
    s.stage="transfer_unknown";s.reason="SINGLE_TARGET_SEND_ATTEMPT";
    await set(s);
    let sent;
    try{sent=await inject(target.tab.id,submitToExistingChatGPT,[s.body,"handoff"]);}
    catch{sent={clicked:false,reason:"MIGRATION_TRANSFER_UNKNOWN"};}
    s.stage=sent.clicked?"awaiting_first_reply":"transfer_blocked";
    s.reason=sent.reason;
    s.body=null; // Handoff text is not persisted after the transfer attempt.
    s.targetSubmittedAt=Date.now();
    await set(s);
    return {migration:serializable(s)};
  }
  if(type==="AP_MIGRATION_POLL"){
    if(s.stage!=="awaiting_first_reply")return {migration:serializable(s)};
    const target=targetLive(s,snapshot,registry,epoch);
    if(!migratedIntoSameProject(s.targetUrl,target.url))
      return {migration:serializable(s),reason:"MIGRATION_WAIT_PROJECT_CHAT_CREATION"};
    const state=await inject(target.id,inspectMigrationTarget);
    if(!state.ok || !state.projectConversation)return {
      migration:serializable(s),reason:state.reason||"MIGRATION_WAIT_PROJECT_CONVERSATION"
    };
    if(state.busy || state.assistantCount<1){
      s.firstReplySeen=false;await set(s);
      return {migration:serializable(s),reason:"MIGRATION_WAIT_FIRST_ASSISTANT_REPLY"};
    }
    const now=Date.now();
    if(!s.firstReplySeen){
      s.firstReplySeen=now;s.projectUrlChanged=true;await set(s);
      return {migration:serializable(s),reason:"MIGRATION_FIRST_REPLY_STABILIZING"};
    }
    if(now-s.firstReplySeen<2000)return {
      migration:serializable(s),reason:"MIGRATION_FIRST_REPLY_STABILIZING"
    };
    // The rename step is at-most-once after the first reply. If the UI has
    // changed, fail closed and offer the exact title for manual application.
    s.stage="rename_unknown";s.reason="RENAME_ATTEMPT_STARTED";await set(s);
    let renamed;
    try{renamed=await inject(target.id,renameMigrationConversation,[s.nextTitle]);}
    catch{renamed={ok:false,reason:"MIGRATION_RENAME_INJECTION_UNCERTAIN"};}
    s.stage=renamed.ok?"title_verified":"manual_title_required";
    s.titleResult=renamed.reason;
    s.reason=renamed.reason;
    await set(s);
    return {migration:serializable(s)};
  }
  if(type==="AP_MIGRATION_CONFIRM_TITLE"){
    if(s.stage!=="manual_title_required")throw Error("MIGRATION_TITLE_CONFIRM_STAGE_INVALID");
    const live=targetLive(s,snapshot,registry,epoch);
    if(!migratedIntoSameProject(s.targetUrl,live.url))
      throw Error("MIGRATION_TARGET_PROJECT_CHANGED");
    s.stage="title_verified";s.titleResult="OPERATOR_CONFIRMED_TITLE";
    s.reason=s.titleResult;
    await set(s);return {migration:serializable(s)};
  }
  if(type==="AP_MIGRATION_REBIND"){
    if(s.stage!=="title_verified")throw Error("MIGRATION_TITLE_NOT_VERIFIED");
    const live=targetLive(s,snapshot,registry,epoch);
    if(!migratedIntoSameProject(s.targetUrl,live.url))
      throw Error("MIGRATION_TARGET_PROJECT_CHANGED");
    const next=applyAction(registry,{type:"rebindTab",
      sessionKey:s.targetKey,tabId:s.targetTabId},snapshot,epoch,
      ()=>crypto.randomUUID(),Date.now());
    await chrome.storage.local.set({[STORAGE_KEY]:next});
    s.stage="completed";s.reason="PROJECT_CHAT_REBOUND_READY_FOR_CONTINUATION";
    await set(s);
    return {migration:serializable(s),registered:true};
  }
  throw Error("UNKNOWN_MIGRATION_OPERATION");
}
