import {STORAGE_KEY,applyAction,sessionStatus} from "./core.js";
import {inspectChatLengthLimit,inspectMigrationSource,captureLateLimitAssistant} from "./migration-page.js";
import {submitToExistingChatGPT} from "./chat-page.js";
import {
  GENERIC_HANDOFF_MARKER,captureGenericHandoff,
  inspectGenericTransferredChat,inspectGenericFirstReply
} from "./generic-migration-page.js";

export const GENERIC_PROGRESS_KEY="autopilot.migration.generic.progress.v1";
export const GENERIC_ATTEMPTS_KEY="autopilot.migration.generic.attempts.v1";
const MARKER=GENERIC_HANDOFF_MARKER;
const token=()=>crypto.randomUUID();
const route=url=>{try{return new URL(url).pathname}catch{return ""}};
const sourceFor=(registry,snapshot,epoch,key)=>{
  const session=registry.sessions.find(s=>s.key===key),tab=snapshot.tabs.find(t=>t.id===session?.tabId);
  if(!session||!tab||session.paused||
    sessionStatus(session,registry,snapshot,epoch)!=="connected"||
    !/^\/c\/[^/]+\/?$/.test(route(tab.url))||
    tab.url!==session.url)return null;
  return {session,tab};
};
const read=async(key,area)=>((await chrome.storage[area].get(key))||{})[key]||{};
const write=(key,value,area)=>chrome.storage[area].set({[key]:value});
const inject=async(tabId,func,args=[])=>{
  const values=await chrome.scripting.executeScript({
    target:{tabId,allFrames:false},world:"ISOLATED",func,args
  });
  if(values.length!==1||!values[0]?.result)throw Error("GENERIC_MIGRATION_PAGE_UNCONFIRMED");
  return values[0].result;
};
const sourceRequest=nonce=>[
  "AUTOPILOT_GENERIC_REQUEST_V1",
  "This conversation is near its context length limit. Write a self-contained,",
  "detailed handoff so the NEXT ChatGPT conversation can continue without guessing.",
  "Start your answer with exactly this line: "+MARKER+" "+nonce,
  "Then provide the goal, confirmed decisions, completed work, uncompleted work,",
  "files/links/repositories if known, constraints, safety approvals and the",
  "specific next action. State unknown facts explicitly. Do not execute actions.",
  "Use the language of this conversation. Only summarize evidence you know."
].join("\n");
const handoff=state=>[
  MARKER+" "+state.nonce,
  "This is a handoff from an earlier ChatGPT conversation.",
  state.limited?"IMPORTANT: Only the last verified assistant answer was available; this is INCOMPLETE context.":"",
  state.body,
  "Check uncertainties and continue only the next safe, uncompleted task.",
  "Retain the earlier language and ask for approval before risky actions."
].filter(Boolean).join("\n");
function physical(state,snapshot){
  const tab=snapshot.tabs.find(t=>t.id===state.tabId);
  if(!tab||tab.windowId!==state.windowId||tab.groupId!==state.groupId)
    throw Error("GENERIC_MIGRATION_PHYSICAL_TAB_CHANGED");
  return tab;
}
const terminal=new Set(["source_send_unknown","navigation_unknown","handoff_unknown",
  "rebind_unknown","resume_unknown"]);
export async function runGenericMigrations({
  registry,snapshot,epoch,targets=[],bridgeCommand,syncRegistry,
  now=()=>Date.now()
}){
  const state=await read(GENERIC_PROGRESS_KEY,"session");
  const attempted=await read(GENERIC_ATTEMPTS_KEY,"local");
  const events=[];
  for(const target of targets.filter(t=>t?.sourceKind==="chat-macro-general"&&
    typeof t.sessionKey==="string")){
    const key=target.sessionKey;
    let record=state[key];
    try{
      // chrome.storage.session can be cleared on browser restart or extension
      // reload. A still-migrating server macro plus a durable attempt marker
      // means the old effect may have occurred. Never restart a new handoff.
      if(!record&&attempted[key]&&target.migrationStatus==="migrating"){
        events.push({sessionKey:key,stage:"needs_attention",
          reason:"MIGRATION_PROGRESS_LOST_NO_REPLAY"});
        continue;
      }
      if(record&&terminal.has(record.stage)){
        record.stage="needs_attention";record.reason="UNCERTAIN_EFFECT_NEVER_REPLAY";
        record.body=null;state[key]=record;
        await write(GENERIC_PROGRESS_KEY,state,"session");
        events.push({sessionKey:key,stage:"needs_attention",reason:record.reason});
      }
      if(record?.stage==="needs_attention")continue;
      if(record?.stage==="completed"){
        const current=sourceFor(registry,snapshot,epoch,key);
        if(!current||current.tab.url!==record.targetUrl||attempted[key]===current.tab.url)continue;
        const warning=await inject(current.tab.id,inspectChatLengthLimit);
        if(warning.eligible!==true||warning.warning!==true)continue;
        delete state[key];record=null;
        await write(GENERIC_PROGRESS_KEY,state,"session");
      }
      let status=null;
      try{status=await bridgeCommand("/api/v1/bridge/status",{});}
      catch{continue;} // Transient server outage does not consume a send.
      if(status?.stopped!==false||status?.authenticated!==true)continue;
      if(!record){
        const source=sourceFor(registry,snapshot,epoch,key);
        if(!source||attempted[key]===source.tab.url)continue;
        const warning=await inject(source.tab.id,inspectChatLengthLimit);
        if(!warning.eligible||warning.warning!==true)continue;
        const inspected=await inject(source.tab.id,inspectMigrationSource);
        if(!inspected.ok)continue;
        const nonce=token(),at=now();
        record={stage:"pause_pending",sessionKey:key,nonce,
          sourceUrl:source.tab.url,tabId:source.tab.id,windowId:source.tab.windowId,
          groupId:source.tab.groupId,assistantCount:inspected.assistantCount,
          assistantId:inspected.lastAssistantId||null,startedAt:at,
          hardCap:inspected.atLimit===true,reason:"LIMIT_WARNING_VERIFIED"};
        attempted[key]=source.tab.url;
        state[key]=record;
        await write(GENERIC_ATTEMPTS_KEY,attempted,"local");
        await write(GENERIC_PROGRESS_KEY,state,"session");
      }
      const save=async()=>{state[key]=record;await write(GENERIC_PROGRESS_KEY,state,"session")};
      const guard=async()=>{
        try{
          const live=await bridgeCommand("/api/v1/bridge/status",{});
          return live?.stopped===false&&live?.authenticated===true;
        }catch{return false;}
      };
      const freshSource=()=>sourceFor(registry,snapshot,epoch,key);
      if(record.stage==="pause_pending"){
        if(freshSource()?.tab.url!==record.sourceUrl)
          throw Error("GENERIC_MIGRATION_SOURCE_CHANGED");
        try{
          // Safe to retry after an ambiguous response: this server command
          // only marks the macro paused and has no browser/ChatGPT side effect.
          await bridgeCommand("/api/v1/bridge/migration-pause",
            {sessionKey:key,generic:true});
        }catch(error){
          if(/^(MACRO_|MIGRATION_)/.test(String(error?.message||"")))
            throw error;
          continue; // Network outage: retry idempotent pause on next heartbeat.
        }
        record.stage=record.hardCap?"late_capture":"source_ready";await save();
      }else if(record.stage==="late_capture"){
        if(freshSource()?.tab.url!==record.sourceUrl)
          throw Error("GENERIC_MIGRATION_SOURCE_CHANGED");
        const capture=await inject(record.tabId,captureLateLimitAssistant,[18000]);
        if(!capture.ok||typeof capture.body!=="string"||capture.body.length<120)
          throw Error("GENERIC_MIGRATION_HARD_LIMIT_NO_VERIFIED_REPLY");
        record.body=capture.body;record.limited=true;
        record.stage="ready_to_navigate";await save();
      }else if(record.stage==="source_ready"){
        if(freshSource()?.tab.url!==record.sourceUrl)
          throw Error("GENERIC_MIGRATION_SOURCE_CHANGED");
        const prompt=sourceRequest(record.nonce);
        if(prompt.length>800)throw Error("GENERIC_SOURCE_PROMPT_LIMIT");
        if(!await guard())continue;
        record.stage="source_send_unknown";await save();
        const sent=await inject(record.tabId,submitToExistingChatGPT,
          [prompt,"continuation",route(record.sourceUrl)]);
        if(sent.clicked!==true)throw Error("GENERIC_SOURCE_SUBMISSION_UNCONFIRMED");
        record.stage="await_source_reply";await save();
      }else if(record.stage==="await_source_reply"){
        if(freshSource()?.tab.url!==record.sourceUrl)
          throw Error("GENERIC_MIGRATION_SOURCE_CHANGED");
        const reply=await inject(record.tabId,captureGenericHandoff,
          [MARKER,record.nonce,record.assistantId]);
        if(!reply.ok){
          if(now()-record.startedAt>12*60_000)
            throw Error("GENERIC_SOURCE_HANDOFF_NOT_VERIFIED_"+reply.reason);
          continue;
        }
        const signature=reply.body.length+":"+reply.body.slice(0,40)+":"+reply.body.slice(-40);
        if(record.signature!==signature){
          record.signature=signature;record.stableAt=now();await save();continue;
        }
        if(now()-record.stableAt<6_000)continue;
        record.body=reply.body;record.limited=false;
        record.stage="ready_to_navigate";await save();
      }else if(record.stage==="ready_to_navigate"){
        if(freshSource()?.tab.url!==record.sourceUrl)
          throw Error("GENERIC_MIGRATION_SOURCE_CHANGED");
        if(!await guard())continue;
        record.stage="navigation_unknown";await save();
        const updated=await chrome.tabs.update(record.tabId,{url:"https://chatgpt.com/"});
        if(updated?.id!==record.tabId||updated.windowId!==record.windowId||
          updated.groupId!==record.groupId)
          throw Error("GENERIC_MIGRATION_NAVIGATION_UNVERIFIED");
        record.stage="target_home";await save();
      }else if(record.stage==="target_home"){
        const tab=physical(record,snapshot);
        if(tab.url!=="https://chatgpt.com/"||tab.status==="loading")continue;
        const message=handoff(record);
        if(message.length>30000)throw Error("GENERIC_HANDOFF_TOO_LONG");
        if(!await guard())continue;
        record.stage="handoff_unknown";await save();
        const sent=await inject(record.tabId,submitToExistingChatGPT,[message,"handoff","/"]);
        if(sent.clicked!==true)throw Error("GENERIC_HANDOFF_SUBMISSION_UNCONFIRMED");
        record.body=null;record.stage="await_target";await save();
      }else if(record.stage==="await_target"){
        if(now()-record.startedAt>15*60_000)
          throw Error("GENERIC_MIGRATION_TARGET_TIMEOUT");
        const tab=physical(record,snapshot);
        if(!/^https:\/\/chatgpt\.com\/c\/[^/]+\/?$/.test(tab.url))continue;
        const verification=await inject(record.tabId,inspectGenericTransferredChat,
          [MARKER,record.nonce]);
        if(!verification.ok)continue;
        const existing=registry.sessions.find(s=>s.key===key);
        if(!existing||existing.tabId!==record.tabId||
          existing.url!==record.sourceUrl)throw Error("GENERIC_SOURCE_REGISTRY_CHANGED");
        if(!await guard())continue;
        record.targetUrl=tab.url;record.stage="rebind_unknown";await save();
        const action={type:existing.groupKey===""?"rebindStandaloneTab":"rebindTab",
          sessionKey:key,tabId:tab.id};
        const next=applyAction(registry,action,snapshot,epoch,token,now());
        await chrome.storage.local.set({[STORAGE_KEY]:next});
        record.stage="resync_target";await save();
      }else if(record.stage==="resync_target"){
        let synced;
        try{synced=await syncRegistry();}
        catch{continue;} // Exact new-chat registry sync is safe to retry.
        if(synced.connected!==true)continue;
        record.stage="await_target_reply";await save();
      }else if(record.stage==="await_target_reply"){
        if(now()-record.startedAt>25*60_000)
          throw Error("GENERIC_MIGRATION_REPLY_TIMEOUT");
        const tab=physical(record,snapshot);
        if(tab.url!==record.targetUrl)throw Error("GENERIC_TARGET_CHANGED");
        const proof=await inject(record.tabId,inspectGenericFirstReply,
          [MARKER,record.nonce]);
        if(!proof.ok)continue;
        if(record.replyFingerprint!==proof.replyFingerprint){
          record.replyFingerprint=proof.replyFingerprint;record.stableAt=now();
          await save();continue;
        }
        if(now()-record.stableAt<6_000)continue;
        if(!await guard())continue;
        record.stage="resume_unknown";await save();
        const result=await bridgeCommand("/api/v1/bridge/migration-resume",{sessionKey:key,generic:true});
        if(result?.resumed!==true)throw Error("GENERIC_MIGRATION_RESUME_NOT_VERIFIED");
        record.stage="completed";record.finishedAt=now();
        record.reason="GENERIC_CHAT_MIGRATION_COMPLETED";await save();
      }
      events.push({sessionKey:key,stage:record.stage,reason:record.reason||null});
    }catch(error){
      if(record){
        record.stage="needs_attention";record.reason=String(error?.message||"UNKNOWN").slice(0,130);
        record.body=null;state[key]=record;await write(GENERIC_PROGRESS_KEY,state,"session");
        events.push({sessionKey:key,stage:record.stage,reason:record.reason});
      }
    }
  }
  return events;
}
export async function readGenericMigrationState(){
  const states=await read(GENERIC_PROGRESS_KEY,"session");
  return Object.entries(states).map(([sessionKey,s])=>({
    sessionKey,stage:s.stage,reason:s.reason||null,startedAt:s.startedAt||null,
    finishedAt:s.finishedAt||null,limited:s.limited===true
  }));
}
