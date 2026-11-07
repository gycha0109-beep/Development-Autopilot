import {STORAGE_KEY,applyAction,sessionStatus} from "./core.js";
import {inspectChatLengthLimit,inspectMigrationSource,captureLateLimitAssistant} from "./migration-page.js";
import {submitToExistingChatGPT} from "./chat-page.js";
import {inspectUnknownChatError} from "./unknown-error-page.js";
import {worklogRoadmapInstructions} from "./migration-core.js";
import {
  GENERIC_HANDOFF_MARKER,captureGenericHandoff,
  inspectGenericTransferredChat,inspectGenericFirstReply
} from "./generic-migration-page.js";

export const GENERIC_PROGRESS_KEY="autopilot.migration.generic.progress.v1";
export const GENERIC_ATTEMPTS_KEY="autopilot.migration.generic.attempts.v1";
const MARKER=GENERIC_HANDOFF_MARKER;
const token=()=>crypto.randomUUID();
const route=url=>{try{return new URL(url).pathname}catch{return ""}};
const projectFromPath=path=>path.match(/^\/g\/(g-p-[^/]+)\/c\/[^/]+\/?$/)?.[1]||null;
const validExisting=path=>/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(path);
const sourceFor=(registry,snapshot,epoch,key)=>{
  const session=registry.sessions.find(s=>s.key===key),tab=snapshot.tabs.find(t=>t.id===session?.tabId);
  if(!session||!tab||session.paused||
    sessionStatus(session,registry,snapshot,epoch)!=="connected"||
    !validExisting(route(tab.url))||
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
const trackValid=value=>typeof value==="string"&&value.trim()===value&&
  value.length>=2&&value.length<=160&&!/[\r\n<>]/.test(value)&&
  !/^(?:New chat|ChatGPT|새 채팅|새 대화)$/iu.test(value);
const trackSeal=state=>"AUTOPILOT_TRACK_LOCK_V1 "+state.nonce+" :: "+state.trackTitle;
const trackContext=state=>[
  trackSeal(state),
  "[트랙 변경 절대 금지 / TRACK IDENTITY IS FIXED]",
  "등록된 원본 트랙: "+state.trackTitle,
  "등록된 원본 저장소: "+(state.repository||"미지정"),
  "이것은 현재 트랙을 추측하는 요청이 아닙니다. 원본 트랙을 변경할 수 없습니다.",
  "저장소의 공통 main, 전체 로드맵, 다른 트랙의 최신 커밋·CI로 원본 트랙을 바꾸지 마세요.",
  "이 트랙의 WORKLOG와 ROADMAP만 찾아야 하며 없으면 증거 부족으로 보고하세요.",
  "다른 트랙(PR, 브랜치, 폴더, 작업명)은 참고 자료일 뿐 실행 대상이 아닙니다.",
  "첫 응답 맨 앞에 다음 문자열을 원문 그대로 작성하세요:",
  "AUTOPILOT_TRACK_ACK "+state.nonce+" :: "+state.trackTitle,
  "해당 트랙임을 확인하지 못하면 코드를 수정하거나 작업을 시작하지 마세요."
];
const sourceRequest=(nonce,trackTitle)=>[
  "AUTOPILOT_GENERIC_REQUEST_V1",
  "Authorized source track: "+trackTitle+". Summarize ONLY this track.",
  "Never switch track based on repository-wide documents.",
  "This conversation is near its context length limit. Write a self-contained,",
  "detailed handoff so the NEXT ChatGPT conversation can continue without guessing.",
  "Start your answer with exactly this line: "+MARKER+" "+nonce,
  "Then provide the goal, confirmed decisions, completed work, uncompleted work,",
  "files/links/repositories if known, constraints, safety approvals and the",
  "specific next action. State unknown facts explicitly. Do not execute actions.",
  "Use the language of this conversation. Only summarize evidence you know."
].join("\n");
const handoff=state=>state.fatal?[
  MARKER+" "+state.nonce,
  ...trackContext(state),
  "RECOVERY FROM UNRECOVERABLE CHATGPT UNKNOWN ERROR.",
  "Old chat is inaccessible. Do NOT request @migration or a handoff prompt from it.",
  state.projectId?"Remain in same ChatGPT project: "+state.projectId:"",
  state.repository?"Repository (not proof of track): "+state.repository:"",
  state.body?
    "One independently verified previous assistant answer (evidence only):":
    "NO VERIFIED PREVIOUS RESPONSE. Do not invent its contents.",
  state.body||"",
  "Treat old response only as evidence, not as a new task.",
  "FIRST identify the work STATUS OF THE ALREADY FIXED TRACK above",
  "from that track's WORKLOG, ROADMAP, branch, PR and code.",
  "Never choose a different track from repository search results.",
  ...worklogRoadmapInstructions(),
  "If the exact track cannot be verified, report a blocker and STOP.",
  "Never assume old approval, completion, or deployment.",
  "Answer in Korean when the source track was Korean."
].filter(Boolean).join("\n"):[
  MARKER+" "+state.nonce,
  ...trackContext(state),
  "This is a handoff from the previous conversation of this EXACT track.",
  state.limited?"Only the last verified assistant answer was available.":" ",
  state.body,
  "Restore the already fixed track only from its WORKLOG, ROADMAP, PR and CI.",
  ...worklogRoadmapInstructions(),
  "If the exact track cannot be verified, report a blocker and STOP.",
  "Never follow a different track discovered through repo search."
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
      // The registered track must originate from the operator's exact
      // session-bound auto-migration watcher, never a repository scan.
      if(!trackValid(target.trackTitle)){
        events.push({sessionKey:key,stage:"needs_attention",
          reason:"GENERIC_TRACK_BINDING_REQUIRED"});
        continue;
      }
      if(record&&(!trackValid(record.trackTitle)||
         record.trackTitle!==target.trackTitle||
         record.repository!==target.repository)){
        record.stage="needs_attention";
        record.reason="GENERIC_TRACK_IDENTITY_MISMATCH_NO_REPLAY";
        record.body=null;state[key]=record;
        await write(GENERIC_PROGRESS_KEY,state,"session");
        events.push({sessionKey:key,stage:record.stage,reason:record.reason});
        continue;
      }
      // Keep existing in-flight length migrations compatible with an update.
      if(record&&!record.newHomeUrl){
        record.newHomeUrl="https://chatgpt.com/";record.projectId=null;
        record.fatal=false;state[key]=record;
        await write(GENERIC_PROGRESS_KEY,state,"session");
      }
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
        const fatal=await inject(current.tab.id,inspectUnknownChatError);
        const warning=fatal?.fatal?null:await inject(current.tab.id,inspectChatLengthLimit);
        if(fatal?.fatal!==true&&
          (warning?.eligible!==true||warning?.warning!==true))continue;
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
        const fatal=await inject(source.tab.id,inspectUnknownChatError);
        if(fatal?.eligible!==true&&fatal?.fatal===true)continue;
        const direct=fatal?.eligible===true&&fatal?.fatal===true;
        const path=route(source.tab.url);
        let inspected=null;
        if(!direct){
          // The original project migration owns length-warning migrations
          // for project chats; the generic worker is the unknown-error fallback.
          if(projectFromPath(path))continue;
          const warning=await inject(source.tab.id,inspectChatLengthLimit);
          if(!warning.eligible||warning.warning!==true)continue;
          inspected=await inject(source.tab.id,inspectMigrationSource);
          if(!inspected.ok)continue;
        }else if(fatal.sourcePath!==path||
          fatal.projectId!==projectFromPath(path))continue;
        const nonce=token(),at=now();
        record={stage:"pause_pending",sessionKey:key,nonce,
          sourceUrl:source.tab.url,tabId:source.tab.id,windowId:source.tab.windowId,
          groupId:source.tab.groupId,assistantCount:inspected?.assistantCount||0,
          assistantId:inspected?.lastAssistantId||null,startedAt:at,
          projectId:projectFromPath(path),repository:target.repository||null,
          trackTitle:target.trackTitle,
          newHomeUrl:projectFromPath(path)?
            "https://chatgpt.com/g/"+projectFromPath(path):"https://chatgpt.com/",
          fatal:direct,hardCap:inspected?.atLimit===true,
          reason:direct?"UNKNOWN_ERROR_DIRECT_RECOVERY":"LIMIT_WARNING_VERIFIED"};
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
        record.stage=record.fatal?"unknown_context_capture":
          record.hardCap?"late_capture":"source_ready";await save();
      }else if(record.stage==="unknown_context_capture"){
        // The old chat cannot accept a migration prompt. Recover at most one
        // strongly attributed, completed assistant response when still visible;
        // otherwise create a new conversation with explicit uncertainty.
        if(freshSource()?.tab.url!==record.sourceUrl)
          throw Error("GENERIC_MIGRATION_SOURCE_CHANGED");
        let capture=null;
        try{capture=await inject(record.tabId,captureLateLimitAssistant,[18000]);}
        catch{/* Provider can remove all messages after Unknown error. */}
        record.body=capture?.ok===true?capture.body:null;
        record.limited=true;record.contextVerified=Boolean(record.body);
        record.stage="ready_to_navigate";await save();
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
        const prompt=sourceRequest(record.nonce,record.trackTitle);
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
        const updated=await chrome.tabs.update(record.tabId,{url:record.newHomeUrl});
        if(updated?.id!==record.tabId||updated.windowId!==record.windowId||
          updated.groupId!==record.groupId)
          throw Error("GENERIC_MIGRATION_NAVIGATION_UNVERIFIED");
        record.stage="target_home";record.targetHomeSince=now();await save();
      }else if(record.stage==="target_home"){
        const tab=physical(record,snapshot);
        const projectRoot=record.projectId?
          "https://chatgpt.com/g/"+record.projectId:null;
        const expectedHome=new Set(record.projectId?
          [projectRoot,projectRoot+"/",projectRoot+"/project"]:
          ["https://chatgpt.com/"]);
        if(!expectedHome.has(tab.url)){
          // A navigation or an uncertain send may already have created a
          // conversation. Reconcile ONLY if its original nonce and exact
          // project handoff are present; never send into a different chat.
          const newChat=record.projectId?
            new RegExp("^https://chatgpt\\.com/g/"+record.projectId+"/c/[^/]+/?$"):
            /^https:\/\/chatgpt\.com\/c\/[^/]+\/?$/;
          if(newChat.test(tab.url)){
            const proof=await inject(record.tabId,inspectGenericTransferredChat,
              [MARKER,record.nonce,record.projectId||null,record.trackTitle]);
            if(proof.ok){
              record.targetUrl=tab.url;record.stage="await_target";
              record.reason="GENERIC_TARGET_ALREADY_TRANSFERRED_VERIFIED";
              await save();continue;
            }
            throw Error("GENERIC_TARGET_CHANGED_NO_TRANSFER_PROOF");
          }
          if(now()-(record.targetHomeSince||record.startedAt)>120_000)
            throw Error("GENERIC_TARGET_HOME_NAVIGATION_TIMEOUT");
          continue;
        }
        if(tab.status==="loading"){
          if(now()-(record.targetHomeSince||record.startedAt)>120_000)
            throw Error("GENERIC_TARGET_HOME_LOADING_TIMEOUT");
          continue;
        }
        const message=handoff(record);
        if(message.length>30000)throw Error("GENERIC_HANDOFF_TOO_LONG");
        if(!await guard())continue;
        record.stage="handoff_unknown";await save();
        const sent=await inject(record.tabId,submitToExistingChatGPT,
          [message,"handoff",route(tab.url)]);
        if(sent.clicked!==true)throw Error("GENERIC_HANDOFF_SUBMISSION_UNCONFIRMED");
        record.body=null;record.stage="await_target";await save();
      }else if(record.stage==="await_target"){
        if(now()-record.startedAt>15*60_000)
          throw Error("GENERIC_MIGRATION_TARGET_TIMEOUT");
        const tab=physical(record,snapshot);
        const expected=record.projectId?
          new RegExp("^https://chatgpt\\.com/g/"+record.projectId+"/c/[^/]+/?$"):
          /^https:\/\/chatgpt\.com\/c\/[^/]+\/?$/;
        if(!expected.test(tab.url))continue;
        const verification=await inject(record.tabId,inspectGenericTransferredChat,
          [MARKER,record.nonce,record.projectId||null,record.trackTitle]);
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
          [MARKER,record.nonce,record.projectId||null,record.trackTitle]);
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
    finishedAt:s.finishedAt||null,limited:s.limited===true,
    mode:s.fatal?"unknown_error_direct":"length_limit",
    contextVerified:s.contextVerified===true
  }));
}
