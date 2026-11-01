import {
  STORAGE_KEY, SESSION_KEY, normalizedRegistry, applyAction, overview,
  groupStatus, sessionStatus
} from "./core.js";


import { BRIDGE_BASE, BRIDGE_CONFIG_KEY, bridgePayload } from "./bridge-core.js";
import { restoreExactRegistrations, exportPortableRegistry, importPortableRegistry } from "./registry-portable.js";
import { discoverChatCandidates, enrollApprovedCandidate } from "./remote-enrollment.js";
import { submitToExistingChatGPT, diagnoseExistingChatGPTComposer, CHAT_COMPOSER_BUILD } from "./chat-page.js";
import { classifyChatGPTRoute } from "./chat-routes.js";
import { attachChatToExistingGroup } from "./popup-group.js";
import {readRequestedObservation} from "./observation-worker.js";
import {dispatchRegisteredChatCommand} from "./chat-dispatch.js";
import {executeRecoveryCommand} from "./disconnect-worker.js";
import {RECOVERY_WORKER_BUILD,clickVerifiedDisconnectStop} from "./disconnect-page.js";
import {LOADING_WORKER_BUILD} from './loading-page.js';
import {executeLoadingReload} from './loading-worker.js';
import {MIGRATION_SESSION_KEY} from './migration-core.js';
import {AUTO_MIGRATION_PROGRESS_KEY} from './migration-auto.js';
import {runGenericMigrations} from "./generic-migration.js";
import { handleMigrationMessage } from "./migration-service.js";
import {readRegisteredChatTitle} from "./migration-page.js";
import {
  autoMigrationCommand,runAutoMigrations,cleanupAutoMigrationWatchers,
  ensureAutoMigrationWatchers,
  getAutoMigrationWatchSessionKeys
} from "./migration-auto.js";

const SYNC_ALARM = "autopilot-bridge-sync";
const DIRTY_ALARM = "autopilot-bridge-change";

async function bridgeInfo() {
  return (await chrome.storage.local.get(BRIDGE_CONFIG_KEY))[BRIDGE_CONFIG_KEY] || null;
}

async function chatBridgeRequest(route,payload,token){
  const response=await fetch(BRIDGE_BASE+route,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},
    body:JSON.stringify(payload)
  });
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||"Chat bridge request failed");
  return result;
}
// One verified physical dispatch path for both legacy Workstream sends
// and first-class chat macros. Either ledger may claim a message only once.
async function claimAndDispatch({config,claimRoute,ackRoute,claimPayload={}}){
  if(!config?.token)return;
  let command;
  try{
    command=(await chatBridgeRequest(claimRoute,claimPayload,config.token)).command;
  }catch{return;}
  if(!command)return;
  const adapters={
    load,snapshot:browserSnapshot,epoch:ensureSessionToken,
    getTab:id=>chrome.tabs.get(id),
    execute:options=>chrome.scripting.executeScript(options),
    authorized:async()=>{
      const result=await chatBridgeRequest("/api/v1/bridge/status",{},config.token);
      return result.authenticated===true&&result.stopped===false;
    }
  };
  const {status,reason}=await dispatchRegisteredChatCommand(command,adapters,{
    allowNew:claimRoute==="/api/v1/bridge/commands"
  });
  try{
    await chatBridgeRequest(ackRoute,{id:command.id,status,reason},config.token);
  }catch{
    // Missing ACK remains an uncertain terminal command. Never replay it.
  }
}
async function processChatCommand(){
  const config=await bridgeInfo();
  return claimAndDispatch({
    config,claimRoute:"/api/v1/bridge/commands",
    ackRoute:"/api/v1/bridge/ack",
    claimPayload:{observationProtocol:"observation-worker-1"}
  });
}
async function processMacroCommand(config){
  return claimAndDispatch({
    config,claimRoute:"/api/v1/bridge/macro-claim",
    ackRoute:"/api/v1/bridge/macro-ack"
  });
}
// Automatic network recovery reuses the same verified disconnected-stop action
// as existing Workstream recovery. No prompt is replayed on an uncertain send.
async function processMacroRecoveryAction(command,config){
  if(command?.kind!=="verified-disconnect-stop"||
     !/^[a-f0-9-]{36}$/.test(command?.operationId||""))return;
  let outcome="refused";
  try{
    const [registry,snapshot,epoch]=await Promise.all([load(),browserSnapshot(),ensureSessionToken()]);
    const session=registry.sessions.find(x=>x.key===command.sessionKey);
    const group=registry.groups.find(x=>x.key===session?.groupKey);
    const tab=snapshot.tabs.find(x=>x.id===session?.tabId);
    if(!session||!tab||sessionStatus(session,registry,snapshot,epoch)!=="connected"||
      session.paused||group?.paused)throw Error("MACRO_RECOVERY_CHAT_UNAVAILABLE");
    const observation=await readRequestedObservation({
      sessionKey:command.sessionKey,workstreamId:"macro:"+command.sessionKey,
      permitted:true,recoveryOperationId:command.operationId},observationAdapters());
    const safe=o=>o?.verified===true&&o.bindingFingerprint===command.bindingFingerprint&&
      o.connectionWarning===true&&o.connectionWarningKind==="disconnect"&&
      o.recoveryWarningSafe===true&&
      o.assistantBusy===true&&o.stopControlVerified===true&&
      o.composerHasDraft===false&&o.humanActionCue===false&&
      o.providerRestriction===false;
    if(!safe(observation))throw Error("MACRO_RECOVERY_SAFETY_FAILED");
    const authorized=await chatBridgeRequest("/api/v1/bridge/macro-recovery-authorize",{
      operationId:command.operationId,sessionKey:command.sessionKey,
      bindingFingerprint:command.bindingFingerprint,observation
    },config.token);
    if(authorized.authorized!==true)throw Error("MACRO_RECOVERY_AUTH_DENIED");
    outcome="unknown";
    const recheck=await readRequestedObservation({
      sessionKey:command.sessionKey,workstreamId:"macro:"+command.sessionKey,
      permitted:true,recoveryOperationId:command.operationId},observationAdapters());
    if(!safe(recheck)||JSON.stringify(registry.sessions.find(x=>x.key===command.sessionKey))!==
      JSON.stringify((await load()).sessions.find(x=>x.key===command.sessionKey)))
      throw Error("MACRO_RECOVERY_RECHECK_CHANGED");
    const status=await chatBridgeRequest("/api/v1/bridge/status",{},config.token);
    if(status.stopped!==false)throw Error("MACRO_RECOVERY_GLOBAL_STOP");
    const latest=await chrome.tabs.get(session.tabId);
    if(latest.url!==tab.url)throw Error("MACRO_RECOVERY_NAVIGATION_CHANGED");
    const output=await chrome.scripting.executeScript({
      target:{tabId:session.tabId,allFrames:false},world:"ISOLATED",
      func:clickVerifiedDisconnectStop,
      args:[{permitted:true,operationId:command.operationId,
        expectedPath:new URL(tab.url).pathname}]
    });
    outcome=output.length===1&&output[0]?.result?.clicked===true?"clicked":"refused";
  }catch{ /* Never retry a potentially executed stop. */ }
  try{await chatBridgeRequest("/api/v1/bridge/macro-recovery-ack",
    {operationId:command.operationId,outcome},config.token);}catch{
    // A missing acknowledgement is terminal for this operation.
  }
}
async function approvedConversationPayload(registry,snapshot,token){
  const payload=bridgePayload(registry,snapshot,token);
  await Promise.all(payload.sessions.map(async item=>{
    if(!["connected","paused"].includes(item.status))return;
    const record=registry.sessions.find(s=>s.key===item.sessionKey);
    const live=snapshot.tabs.find(t=>t.id===record?.tabId);
    if(!record||!live||live.url!==record.url||
       classifyChatGPTRoute(live.url)!=="existing")return;
    // Never send a private conversation URL to the local server.
    const parsed=new URL(live.url);
    const bytes=new TextEncoder().encode(parsed.origin+parsed.pathname);
    const hash=await crypto.subtle.digest("SHA-256",bytes);
    item.urlHash=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
  }));
  return payload;
}
async function reportBridgeRegistry(config,registry,snapshot,token){
  return chatBridgeRequest("/api/v1/bridge/sync",{
    ...await approvedConversationPayload(registry,snapshot,token),
    composerBuild:CHAT_COMPOSER_BUILD,
    recoveryBuild:RECOVERY_WORKER_BUILD,
    loadingBuild:LOADING_WORKER_BUILD,
    migrationWatchSessionKeys:await getAutoMigrationWatchSessionKeys(),
    candidates:await discoverChatCandidates(registry,snapshot,token)
  },config.token);
}
async function processRecoveryCommand(config){
  let command;
  try{command=(await chatBridgeRequest("/api/v1/bridge/recovery-commands",{protocol:RECOVERY_WORKER_BUILD},config.token)).command;}
  catch{return;}
  if(!command)return;
  const receipt=await executeRecoveryCommand(command,{...observationAdapters(),
    authorize:(operationId,observation)=>chatBridgeRequest("/api/v1/bridge/recovery-authorize",{operationId,observation},config.token)});
  try{await chatBridgeRequest("/api/v1/bridge/recovery-ack",receipt,config.token);}catch{ /* Never reclaim an uncertain effect. */ }
}
async function processLoadingCommand(config){
  let command;
  try{command=(await chatBridgeRequest('/api/v1/bridge/loading-commands',{protocol:LOADING_WORKER_BUILD},config.token)).command;}
  catch{return;} // Older/offline reload transport must not suppress other axes.
  if(!command)return;
  const receipt=await executeLoadingReload(command,{...observationAdapters(),
    authorize:(operationId,observation)=>chatBridgeRequest('/api/v1/bridge/loading-authorize',{operationId,observation},config.token),
    busy:async key=>{
      const stored=await chrome.storage.session.get([MIGRATION_SESSION_KEY,AUTO_MIGRATION_PROGRESS_KEY]);
      const manual=stored[MIGRATION_SESSION_KEY],auto=stored[AUTO_MIGRATION_PROGRESS_KEY]?.[key];
      return !!((manual&&[manual.sourceKey,manual.targetKey].includes(key)&&manual.stage!=='completed')||(auto&&auto.stage!=='completed'));
    },
    markAttempt:async id=>{
      const key='autopilot.loading-reload.attempt.'+id;
      if((await chrome.storage.local.get(key))[key])return false;
      await chrome.storage.local.set({[key]:Date.now()});return true;
    },reload:tabId=>chrome.tabs.reload(tabId,{bypassCache:false})});
  try{await chatBridgeRequest('/api/v1/bridge/loading-ack',receipt,config.token);}catch{ /* No reclaim of uncertain navigation. */ }
}
async function processApprovedEnrollments(requests,config){
  for(const request of requests||[]){
    try{
      const enrolled=await enrollApprovedCandidate(request,{
        load,snapshot:browserSnapshot,epoch:ensureSessionToken,
        save:next=>chrome.storage.local.set({[STORAGE_KEY]:next})
      });
      const [registry,live,token]=await Promise.all([
        load(),browserSnapshot(),ensureSessionToken()
      ]);
      // The server must see a separately authenticated, connected session
      // before accepting an ACK and linking a workstream.
      await reportBridgeRegistry(config,registry,live,token);
      await chatBridgeRequest("/api/v1/bridge/enrollment-ack",{
        id:request.id,status:"applied",sessionKey:enrolled.sessionKey,urlHash:enrolled.urlHash
      },config.token);
    }catch(error){
      const reason=String(error?.message||"");
      if(/^ENROLLMENT_[A-Z_]+$/.test(reason)){
        try{
          await chatBridgeRequest("/api/v1/bridge/enrollment-ack",{
            id:request.id,status:"refused",reason
          },config.token);
        }catch{ /* Preserve pending for reconciliation if ACK is uncertain. */ }
      }
      // Network or ACK uncertainty: do not create a new registration intent.
      // Next heartbeat reconciles by the original stable request/session key.
    }
  }
}
async function bridgeSync() {
  const config = await bridgeInfo();
  if (!config?.token) return { connected: false, message: "로컬 프로그램과 연결되지 않았습니다." };
  try {
    const [rawRegistry, snapshot, token] = await Promise.all([load(), browserSnapshot(), ensureSessionToken()]);
    const recovered=restoreExactRegistrations(rawRegistry,snapshot,token);
    const registry=recovered.registry;
    if(recovered.changed)await chrome.storage.local.set({[STORAGE_KEY]:registry});
    const result=await reportBridgeRegistry(config,registry,snapshot,token);
    await processApprovedEnrollments(result.enrollmentRequests,config);
    for(const request of result.observationRequests||[]){
      const observation=await readRequestedObservation(request,observationAdapters());
      await chatBridgeRequest("/api/v1/bridge/observations",{requestId:request.requestId,observation},config.token);
    }
    for(const request of result.macroObservationRequests||[]){
      const observation=await readRequestedObservation(request,observationAdapters());
      const response=await chatBridgeRequest("/api/v1/bridge/macro-observation",
        {requestId:request.requestId,observation},config.token);
      if(response.recoveryAction)
        await processMacroRecoveryAction(response.recoveryAction,config);
    }
    await processRecoveryCommand(config);
    await processLoadingCommand(config);
    await cleanupAutoMigrationWatchers(await load(),{
      revokedSessionKeys:result.revokedWatchSessionKeys||[]
    });
    await ensureAutoMigrationWatchers(await load(),await browserSnapshot(),token,
      result.migrationTargets||[]);
    const next = { ...config, lastSyncedAt: Date.now(), error: "" };
    await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: next });
    // Detect/stop overlong registered chats BEFORE claiming any new regular
    // scheduled prompt. Auto handoff is enabled only per explicitly set track.
    const syncMigrationRegistry=async()=>{
        const synced=await fetch(BRIDGE_BASE+"/api/v1/bridge/sync",{
          method:"POST",headers:{
            "Content-Type":"application/json","Authorization":"Bearer "+config.token
          },body:JSON.stringify({
            ...await approvedConversationPayload(await load(),await browserSnapshot(),await ensureSessionToken()),
            composerBuild:CHAT_COMPOSER_BUILD,
            recoveryBuild:RECOVERY_WORKER_BUILD,
            loadingBuild:LOADING_WORKER_BUILD,
            migrationWatchSessionKeys:await getAutoMigrationWatchSessionKeys()
          })
        });
        return synced.ok?{connected:true}:{connected:false};
    };
    const bridgeCommand=(route,payload)=>chatBridgeRequest(route,payload,config.token);
    await runAutoMigrations({
      registry:await load(),snapshot:await browserSnapshot(),epoch:token,
      migrationTargets:result.migrationTargets||[],
      bridgeCommand,syncRegistry:syncMigrationRegistry
    });
    const genericEvents=await runGenericMigrations({
      registry:await load(),snapshot:await browserSnapshot(),epoch:token,
      targets:result.generalMigrationTargets||[],
      bridgeCommand,syncRegistry:syncMigrationRegistry
    });
    for(const event of genericEvents.filter(x=>x.stage==="needs_attention")){
      await chatBridgeRequest("/api/v1/bridge/macro-migration-failure",{
        sessionKey:event.sessionKey,reason:"GENERIC_MIGRATION_NEEDS_ATTENTION"
      },config.token);
    }
    await processChatCommand();
    await processMacroCommand(config);
    return { connected: true, lastSyncedAt: next.lastSyncedAt, accepted: result.accepted };
  } catch (error) {
    const message = error?.message || "로컬 연결 오류";
    await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: { ...config, error: message } });
    return { connected: false, message };
  }
}
function observationAdapters(){return {load,snapshot:browserSnapshot,epoch:ensureSessionToken,
  getTab:id=>chrome.tabs.get(id),execute:options=>chrome.scripting.executeScript(options)};}
async function bridgePair(code,{metadataOnly=false}={}) {
  if (typeof code !== "string" || !/^[a-fA-F0-9]{20}$/.test(code.trim())) {
    throw new Error("로컬 관리 화면에서 발급받은 20자리 연결 코드를 입력하십시오.");
  }
  const res = await fetch(BRIDGE_BASE + "/api/v1/bridge/pair", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim() })
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error(data.error || "로컬 프로그램 연결 실패");
  const pairedAt=Date.now();
  await chrome.storage.local.set({
    [BRIDGE_CONFIG_KEY]: { token: data.token, pairedAt, lastSyncedAt: null, error: "" }
  });
  if(!metadataOnly)return bridgeSync();
  // Pairing from the popup registers only metadata; it must not claim or
  // submit scheduled chat prompts as a side effect of entering a code.
  let syncPending=true;
  try {
    const [registry,snapshot,epoch]=await Promise.all([
      load(),browserSnapshot(),ensureSessionToken()
    ]);
    await reportBridgeRegistry({token:data.token},registry,snapshot,epoch);
    await chrome.storage.local.set({
      [BRIDGE_CONFIG_KEY]:{token:data.token,pairedAt,lastSyncedAt:Date.now(),error:""}
    });
    syncPending=false;
  } catch {
    planBridgeSync();
  }
  return {connected:true,paired:true,syncPending};
}

function planBridgeSync() {
  chrome.alarms.create(DIRTY_ALARM, { delayInMinutes: 0.5 })
    .catch(error => console.error("Chrome bridge alarm failed:", error));
}
async function initBridgeAlarms() {
  // Chrome MV3 currently supports a 30-second minimum recurring alarm.
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
  planBridgeSync();
}
chrome.runtime.onInstalled.addListener(() => void initBridgeAlarms());
chrome.runtime.onStartup.addListener(() => void initBridgeAlarms());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SYNC_ALARM || alarm.name === DIRTY_ALARM) {
    void enqueue(bridgeSync);
  }
});

let serialized = Promise.resolve();

function enqueue(task) {
  const current = serialized.then(task, task);
  serialized = current.catch(() => undefined);
  return current;
}

async function ensureSessionToken() {
  const existing = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  if (typeof existing === "string" && existing) return existing;
  const token = crypto.randomUUID();
  await chrome.storage.session.set({ [SESSION_KEY]: token });
  return token;
}

async function browserSnapshot() {
  const [groups, tabs] = await Promise.all([
    chrome.tabGroups.query({}),
    chrome.tabs.query({})
  ]);
  return {
    groups: groups.map(g => ({
      id: g.id, windowId: g.windowId, title: g.title || "",
      color: g.color || "grey", collapsed: g.collapsed === true
    })).sort((a, b) => a.windowId - b.windowId || a.id - b.id),
    tabs: tabs.filter(t => Number.isInteger(t.id) && Number.isInteger(t.windowId))
      .map(t => ({
        id: t.id, windowId: t.windowId, groupId: t.groupId,
        title: t.title || "", url: t.url || "", active: t.active === true
      }))
  };
}

async function load() {
  return normalizedRegistry((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
}

async function execute(message) {
  // The version handshake must work even if chrome.tabs, tabGroups, registry
  // storage or registration reconciliation fails. It is the recovery endpoint.
  if (message.type === "AP_BRIDGE_STATUS") {
    const manifestVersion = chrome.runtime.getManifest().version;
    let config = null;
    let storageError = false;
    try { config = await bridgeInfo(); }
    catch { storageError = true; }
    return {
      extensionVersion: manifestVersion,
      composerBuild: CHAT_COMPOSER_BUILD,
      paired: Boolean(config?.token),
      lastSyncedAt: config?.lastSyncedAt || null,
      error: storageError ? "LOCAL_EXTENSION_STORAGE_UNAVAILABLE" : config?.error || ""
    };
  }
  if (message.type==="AP_POPUP_DISCOVER") {
    const [tabs,groups]=await Promise.all([
      chrome.tabs.query({}),chrome.tabGroups.query({})
    ]);
    return {
      tabs:tabs.filter(t=>Number.isInteger(t.id)&&
        classifyChatGPTRoute(t.url)==="existing").map(t=>({
          id:t.id,title:t.title||"",url:t.url,
          groupId:t.groupId,windowId:t.windowId,active:t.active===true
        })),
      groups:groups.filter(g=>Number.isInteger(g.id)&&
        Number.isInteger(g.windowId)).map(g=>({
          id:g.id,title:g.title||"",windowId:g.windowId,color:g.color||"grey"
        }))
    };
  }
  const [snapshot, token, rawRegistry] = await Promise.all([
    browserSnapshot(), ensureSessionToken(), load()
  ]);
  const restored=restoreExactRegistrations(rawRegistry,snapshot,token);
  const registry=restored.registry;
  if(restored.changed){
    await chrome.storage.local.set({[STORAGE_KEY]:registry});
    planBridgeSync();
  }
  if (message.type === "AP_EXPORT_PORTABLE") {
    const portable=exportPortableRegistry(registry,snapshot,token);
    const config=await bridgeInfo();
    if (config?.token) {
      const extra=await chatBridgeRequest("/api/v1/bridge/config-export",{},config.token);
      portable.workstreams=extra.workstreams;
    }
    return portable;
  }
  if (message.type === "AP_IMPORT_PORTABLE") {
    const imported=importPortableRegistry(registry,message.document,snapshot,token,()=>crypto.randomUUID(),Date.now());
    const workstreams=message.document.workstreams;
    const config=await bridgeInfo();
    let serverImport=null;
    if (workstreams !== undefined) {
      if (!config?.token) throw Error("작업축 복원 전에 로컬 서버 연결이 필요합니다.");
      if (!Array.isArray(workstreams)) throw Error("잘못된 작업축 설정 형식입니다.");
      const mapped=workstreams.map(w=>({
        ...w,sessionKey:w.sessionKey == null ? null :
          imported.sessionKeyMapping[w.sessionKey] ?? w.sessionKey
      }));
      serverImport=await chatBridgeRequest("/api/v1/bridge/config-import",
        {workstreams:mapped},config.token);
    }
    await chrome.storage.local.set({[STORAGE_KEY]:imported.registry});
    if(config?.token)await reportBridgeRegistry(config,imported.registry,snapshot,token);
    planBridgeSync();
    return {importedGroups:imported.importedGroups,importedTabs:imported.importedTabs,
      restoredGroups:imported.groupsRestored,restoredTabs:imported.tabsRestored,
      serverImport};
  }
  if(message.type==="AP_POPUP_MACRO"){
    const cfg=await bridgeInfo();
    if(!cfg?.token)throw Error("MACRO_LOCAL_SERVER_PAIRING_REQUIRED");
    const actions={
      state:"macro-state",configure:"macro-configure",
      template:"macro-template",send:"macro-send",stop:"macro-stop"
    };
    if(!actions[message.action])throw Error("MACRO_ACTION_UNKNOWN");
    if(message.action==="configure"||message.action==="send"){
      // Explicitly synchronize the selected physical tab before configuration.
      await reportBridgeRegistry(cfg,registry,snapshot,token);
    }
    return chatBridgeRequest("/api/v1/bridge/"+actions[message.action],
      message.payload||{},cfg.token);
  }
  if(message.type==="AP_POPUP_CONTROL"){
    const cfg=await bridgeInfo();
    if(!cfg?.token)throw Error("로컬 서버 연결이 필요합니다. 관리 화면에서 연결하십시오.");
    const actions={state:"control-state",link:"control-link",configure:"control-configure",send:"control-send-now",stop:"control-stop"};
    const route=actions[message.action];
    if(!route)throw Error("지원하지 않는 팝업 명령입니다.");
    // Popup status requests must never trigger bridge sync or a scheduled send.
    return chatBridgeRequest("/api/v1/bridge/"+route,message.payload||{},cfg.token);
  }
  if(message.type==="AP_POPUP_ATTACH_GROUP"){
    const assigned=await attachChatToExistingGroup(message,{
      getTab:id=>chrome.tabs.get(id),
      getGroup:id=>chrome.tabGroups.get(id),
      groupTabs:opts=>chrome.tabs.group(opts),
      browserSnapshot,load,
      save:next=>chrome.storage.local.set({[STORAGE_KEY]:next}),
      epoch:ensureSessionToken,newKey:()=>crypto.randomUUID(),now:()=>Date.now()
    });
    const config=await bridgeInfo();
    let syncPending=true;
    if(config?.token){
      try{
        await reportBridgeRegistry(config,assigned.registry,assigned.snapshot,assigned.token);
        syncPending=false;
      }catch{
        // Chrome registration already succeeded. Retry metadata sync later.
      }
    }
    planBridgeSync();
    return {
      sessionKey:assigned.sessionKey,groupId:assigned.groupId,
      moved:assigned.moved,preservedSession:assigned.preservedSession,
      groupName:assigned.groupName,syncPending
    };
  }
  if(message.type==="AP_POPUP_CREATE_GROUP"){
    if(!Number.isInteger(message.tabId))throw Error("CHAT_TAB_SELECTION_REQUIRED");
    const current=await chrome.tabs.get(message.tabId);
    if(!current||!Number.isInteger(current.id)||classifyChatGPTRoute(current.url)!=="existing")
      throw Error("현재 Chrome 탭에서 기존 ChatGPT 채팅을 열어 주십시오.");
    if(current.groupId>=0)throw Error("이미 그룹에 속한 탭입니다. 채팅 등록을 사용하십시오.");
    const groupId=await chrome.tabs.group({tabIds:[current.id]});
    await chrome.tabGroups.update(groupId,{title:"Autopilot",color:"blue"});
    const currentSnapshot=await browserSnapshot();
    let next=applyAction(await load(),{type:"enrollGroup",groupId},currentSnapshot,token,
      ()=>crypto.randomUUID(),Date.now());
    const group=next.groups.find(g=>g.groupId===groupId&&g.sessionToken===token);
    next=applyAction(next,{type:"enrollTab",groupKey:group.key,tabId:current.id},
      currentSnapshot,token,()=>crypto.randomUUID(),Date.now());
    await chrome.storage.local.set({[STORAGE_KEY]:next});
    const cfg=await bridgeInfo();
    if(cfg?.token)await reportBridgeRegistry(cfg,next,currentSnapshot,token);
    planBridgeSync();
    return {createdGroup:true,tabId:current.id};
  }
  if(message.type==="AP_POPUP_ENROLL"){
    const tabId=message.tabId;
    if(!Number.isInteger(tabId))throw Error("CHAT_TAB_SELECTION_REQUIRED");
    const current=await chrome.tabs.get(tabId);
    if(classifyChatGPTRoute(current?.url)!=="existing")
      throw Error("EXISTING_CHATGPT_CONVERSATION_REQUIRED");
    // Never group or move a chat without asking; standalone tabs are valid.
    const fresh=await browserSnapshot();
    const live=fresh.tabs.find(t=>t.id===tabId);
    if(!live)throw Error("CHAT_TAB_NO_LONGER_OPEN");
    let next=await load();
    if(live.groupId<0){
      const prior=next.sessions.find(s=>s.groupKey===""&&s.tabId===tabId&&
        s.windowId===live.windowId&&s.sessionToken===token&&s.url===live.url);
      if(!prior){
        if(next.sessions.some(s=>s.tabId===tabId))
          throw Error("STANDALONE_REBIND_REQUIRES_EXPLICIT_ACTION");
        next=applyAction(next,{type:"enrollStandaloneTab",tabId},
          fresh,token,()=>crypto.randomUUID(),Date.now());
      }
      await chrome.storage.local.set({[STORAGE_KEY]:next});
      const cfg=await bridgeInfo();
      if(cfg?.token)await reportBridgeRegistry(cfg,next,fresh,token);
      planBridgeSync();
      return {sessionKey:next.sessions.find(s=>s.groupKey===""&&s.tabId===tabId&&
        s.url===live.url)?.key,existing:Boolean(prior),standalone:true};
    }
    let group=next.groups.find(g=>g.groupId===live.groupId &&
      g.windowId===live.windowId && g.sessionToken===token);
    if(!group){
      next=applyAction(next,{type:"enrollGroup",groupId:live.groupId},
        fresh,token,()=>crypto.randomUUID(),Date.now());
      group=next.groups.find(g=>g.groupId===live.groupId &&
        g.windowId===live.windowId && g.sessionToken===token);
    }
    const prior=next.sessions.find(s=>s.groupKey===group.key &&
      s.tabId===tabId && s.sessionToken===token && s.url===live.url);
    if(!prior)
      next=applyAction(next,{type:"enrollTab",groupKey:group.key,tabId},
        fresh,token,()=>crypto.randomUUID(),Date.now());
    await chrome.storage.local.set({[STORAGE_KEY]:next});
    const cfg=await bridgeInfo();
    if(cfg?.token)await reportBridgeRegistry(cfg,next,fresh,token);
    planBridgeSync();
    return {sessionKey:next.sessions.find(s=>s.tabId===tabId &&
      s.groupKey===group.key && s.url===live.url)?.key,
      existing:Boolean(prior)};
  }
  if (message.type === "AP_GET") {
    return { registry, snapshot, token, overview: overview(registry, snapshot, token) };
  }
  if(message.type==="AP_AUTO_MIGRATION_STATE"||
     message.type==="AP_AUTO_MIGRATION_CONFIG"||
     message.type==="AP_AUTO_MIGRATION_TEST"||
     message.type==="AP_AUTO_MIGRATION_INSPECT"||
     message.type==="AP_AUTO_MIGRATION_START"||
     message.type==="AP_AUTO_MIGRATION_RECOVER"||
     message.type==="AP_AUTO_MIGRATION_CONFIRM_FIRST_REPLY"||
     message.type==="AP_AUTO_MIGRATION_CONFIRM_TITLE"||
     message.type==="AP_AUTO_MIGRATION_REPAIR_PREVIEW"||
     message.type==="AP_AUTO_MIGRATION_DOM_DIAGNOSE"||
     message.type==="AP_AUTO_MIGRATION_RESET_FAILED"||
     message.type==="AP_AUTO_MIGRATION_REMOVE"){
    const config=await bridgeInfo();
    if(!config?.token)throw Error("AUTO_MIGRATION_BRIDGE_NOT_PAIRED");
    if((message.type==="AP_AUTO_MIGRATION_CONFIG" && message.enabled)||
       message.type==="AP_AUTO_MIGRATION_TEST"||
       message.type==="AP_AUTO_MIGRATION_START"||
       message.type==="AP_AUTO_MIGRATION_RECOVER"){
      const state=await chatBridgeRequest("/api/v1/bridge/status",{},config.token);
      if(state.stopped)throw Error("MIGRATION_GLOBAL_STOP_ACTIVE");
    }
    return autoMigrationCommand(message,{registry,snapshot,epoch:token});
  }
  if (message.type.startsWith("AP_MIGRATION_")) {
    const config=await bridgeInfo();
    if(!config?.token)throw Error("MIGRATION_LOCAL_BRIDGE_NOT_PAIRED");
    if(!["AP_MIGRATION_STATE","AP_MIGRATION_CANCEL"].includes(message.type)){
      const result=await chatBridgeRequest("/api/v1/bridge/status",{},config.token);
      if(result.stopped)throw Error("MIGRATION_GLOBAL_STOP_ACTIVE");
    }
    return handleMigrationMessage(message,{registry,snapshot,epoch:token});
  }
  if(message.type==="AP_CHAT_TITLE"){
    const session=registry.sessions.find(s=>s.key===message.sessionKey);
    if(!session||sessionStatus(session,registry,snapshot,token)!=="connected" ||
       session.paused || registry.groups.find(g=>g.key===session.groupKey)?.paused)
      throw Error("CHAT_TITLE_REGISTERED_SESSION_REQUIRED");
    const tab=snapshot.tabs.find(t=>t.id===session.tabId);
    if(!tab || classifyChatGPTRoute(tab.url)!=="existing")
      throw Error("CHAT_TITLE_EXISTING_CHAT_REQUIRED");
    const result=await chrome.scripting.executeScript({
      target:{tabId:tab.id,allFrames:false},world:"ISOLATED",
      func:readRegisteredChatTitle
    });
    if(result.length!==1||!result[0]?.result)
      throw Error("CHAT_TITLE_LOOKUP_FAILED");
    return result[0].result;
  }
  if (message.type === "AP_CHAT_DIAGNOSE") {
    const registered = registry.sessions.filter(session=>
      (!message.sessionKey || session.key===message.sessionKey) &&
      sessionStatus(session,registry,snapshot,token)==="connected" &&
      !session.paused &&
      !registry.groups.find(g=>g.key===session.groupKey)?.paused &&
      snapshot.tabs.some(tab=>tab.id===session.tabId &&
        classifyChatGPTRoute(tab.url)!==null)
    );
    if(registered.length!==1){
      return {
        composerBuild:CHAT_COMPOSER_BUILD,
        reason:registered.length===0?"NO_REGISTERED_CONNECTED_CHAT":
          "SELECT_SINGLE_CHAT_SESSION",
        count:registered.length
      };
    }
    const results=await chrome.scripting.executeScript({
      target:{tabId:registered[0].tabId,allFrames:false},
      world:"ISOLATED",
      func:diagnoseExistingChatGPTComposer
    });
    if(results.length!==1 || !results[0]?.result)
      return {composerBuild:CHAT_COMPOSER_BUILD,reason:"DIAGNOSTIC_INJECTION_FAILED"};
    return results[0].result;
  }
  if (message.type === "AP_POPUP_PAIR") return bridgePair(message.code,{metadataOnly:true});
  if (message.type === "AP_BRIDGE_PAIR") return bridgePair(message.code);
  if (message.type === "AP_BRIDGE_SYNC") return bridgeSync();
  if (message.type === "AP_BRIDGE_DISCONNECT") {
    await chrome.storage.local.remove(BRIDGE_CONFIG_KEY);
    return { paired: false };
  }
  if (message.type === "AP_MUTATE") {
    const next = applyAction(registry, message.action, snapshot, token,
      () => crypto.randomUUID(), Date.now());
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    await cleanupAutoMigrationWatchers(next);
    planBridgeSync();
    return { registry: next, snapshot, token, overview: overview(next, snapshot, token) };
  }
  throw new Error("잘못된 요청입니다.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore notifications so the worker does not process its own broadcast.
  if (!message || !["AP_GET", "AP_POPUP_DISCOVER", "AP_POPUP_PAIR", "AP_POPUP_ATTACH_GROUP", "AP_POPUP_CONTROL", "AP_POPUP_MACRO", "AP_POPUP_ENROLL", "AP_POPUP_CREATE_GROUP", "AP_MUTATE", "AP_EXPORT_PORTABLE", "AP_IMPORT_PORTABLE", "AP_BRIDGE_STATUS", "AP_BRIDGE_PAIR", "AP_BRIDGE_SYNC", "AP_BRIDGE_DISCONNECT", "AP_CHAT_DIAGNOSE", "AP_CHAT_TITLE", "AP_AUTO_MIGRATION_STATE", "AP_AUTO_MIGRATION_CONFIG", "AP_AUTO_MIGRATION_TEST", "AP_AUTO_MIGRATION_INSPECT", "AP_AUTO_MIGRATION_START", "AP_AUTO_MIGRATION_RECOVER", "AP_AUTO_MIGRATION_CONFIRM_FIRST_REPLY", "AP_AUTO_MIGRATION_CONFIRM_TITLE", "AP_AUTO_MIGRATION_REPAIR_PREVIEW", "AP_AUTO_MIGRATION_DOM_DIAGNOSE", "AP_AUTO_MIGRATION_RESET_FAILED", "AP_AUTO_MIGRATION_REMOVE", "AP_MIGRATION_STATE", "AP_MIGRATION_CANCEL", "AP_MIGRATION_PREPARE", "AP_MIGRATION_CAPTURE", "AP_MIGRATION_MANUAL", "AP_MIGRATION_EDIT", "AP_MIGRATION_TRANSFER", "AP_MIGRATION_POLL", "AP_MIGRATION_CONFIRM_TITLE", "AP_MIGRATION_REBIND"].includes(message.type)) return false;
  // Only this extension's UI may request registry mutations.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "요청 권한이 없습니다." });
    return false;
  }
  enqueue(() => execute(message))
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => {
      console.error("Autopilot request rejected:", error);
      sendResponse({ ok: false, error: error?.message || "처리에 실패했습니다." });
    });
  return true;
});

let notifyPending = false;
function notifyChanged() {
  planBridgeSync();
  if (notifyPending) return;
  notifyPending = true;
  // Events may arrive in bursts; the UI reloads the canonical snapshot.
  Promise.resolve().then(async () => {
    notifyPending = false;
    try { await chrome.runtime.sendMessage({ type: "AP_CHANGED" }); }
    catch { /* No open extension UI. */ }
  });
}
chrome.tabGroups.onCreated.addListener(notifyChanged);
chrome.tabGroups.onUpdated.addListener(notifyChanged);
chrome.tabGroups.onRemoved.addListener(notifyChanged);
chrome.tabs.onCreated.addListener(notifyChanged);
chrome.tabs.onUpdated.addListener(notifyChanged);
chrome.tabs.onRemoved.addListener(notifyChanged);
chrome.tabs.onMoved.addListener(notifyChanged);
chrome.tabs.onAttached.addListener(notifyChanged);
chrome.tabs.onDetached.addListener(notifyChanged);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) notifyChanged();
});
