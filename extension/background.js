import {
  STORAGE_KEY, SESSION_KEY, normalizedRegistry, applyAction, overview,
  groupStatus, sessionStatus
} from "./core.js";


import { BRIDGE_BASE, BRIDGE_CONFIG_KEY, bridgePayload } from "./bridge-core.js";
import { submitToExistingChatGPT, diagnoseExistingChatGPTComposer, CHAT_COMPOSER_BUILD } from "./chat-page.js";
import { classifyChatGPTRoute } from "./chat-routes.js";

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
async function processChatCommand(){
  const config=await bridgeInfo();
  if(!config?.token)return;
  let claim;
  try{claim=await chatBridgeRequest("/api/v1/bridge/commands",{},config.token);}
  catch{return;}
  const command=claim.command;
  if(!command)return;
  // A claimed command is NEVER automatically retried. If the extension crashes
  // or the acknowledgement is lost, the local server marks it UNKNOWN.
  let status="unknown",reason="EXTENSION_UNCERTAIN";
  try{
    const [registry,snapshot,epoch]=await Promise.all([load(),browserSnapshot(),ensureSessionToken()]);
    const enrolled=registry.sessions.find(s=>s.key===command.sessionKey);
    if(!enrolled || sessionStatus(enrolled,registry,snapshot,epoch)!=="connected" ||
       enrolled.paused || registry.groups.find(g=>g.key===enrolled.groupKey)?.paused){
      status="blocked";reason="SESSION_NOT_CONNECTED";
    }else{
      const live=snapshot.tabs.find(t=>t.id===enrolled.tabId);
      const u=new URL(live?.url||"about:blank");
      if(!classifyChatGPTRoute(u.href)){
        status="blocked";reason="UNSUPPORTED_CHATGPT_PAGE";
      }else{
        const results=await chrome.scripting.executeScript({
          target:{tabId:enrolled.tabId,allFrames:false},
          world:"ISOLATED",
          func:submitToExistingChatGPT,args:[command.message]
        });
        if(results.length!==1||!results[0]?.result){
          status="unknown";reason="INJECTION_RESULT_MISSING";
        }else{
          status=results[0].result.clicked===true?"sent":"blocked";
          reason=results[0].result.reason||"EXTENSION_UNCERTAIN";
        }
      }
    }
  }catch{
    status="unknown";reason="INJECTION_OR_NAVIGATION_ERROR";
  }
  try{
    await chatBridgeRequest("/api/v1/bridge/ack",
      {id:command.id,status,reason},config.token);
  }catch{
    // Unknown whether the page was changed; never re-claim this command.
  }
}
async function bridgeSync() {
  const config = await bridgeInfo();
  if (!config?.token) return { connected: false, message: "로컬 프로그램과 연결되지 않았습니다." };
  try {
    const [registry, snapshot, token] = await Promise.all([load(), browserSnapshot(), ensureSessionToken()]);
    const response = await fetch(BRIDGE_BASE + "/api/v1/bridge/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.token
      },
      body: JSON.stringify({...bridgePayload(registry, snapshot, token),composerBuild:CHAT_COMPOSER_BUILD})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "브리지 동기화 실패");
    const next = { ...config, lastSyncedAt: Date.now(), error: "" };
    await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: next });
    await processChatCommand();
    return { connected: true, lastSyncedAt: next.lastSyncedAt, accepted: result.accepted };
  } catch (error) {
    const message = error?.message || "로컬 연결 오류";
    await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: { ...config, error: message } });
    return { connected: false, message };
  }
}
async function bridgePair(code) {
  if (typeof code !== "string" || !/^[a-fA-F0-9]{20}$/.test(code.trim())) {
    throw new Error("로컬 관리 화면에서 발급받은 20자리 연결 코드를 입력하십시오.");
  }
  const res = await fetch(BRIDGE_BASE + "/api/v1/bridge/pair", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim() })
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error(data.error || "로컬 프로그램 연결 실패");
  await chrome.storage.local.set({
    [BRIDGE_CONFIG_KEY]: { token: data.token, pairedAt: Date.now(), lastSyncedAt: null, error: "" }
  });
  return bridgeSync();
}

function planBridgeSync() {
  chrome.alarms.create(DIRTY_ALARM, { delayInMinutes: 1 })
    .catch(error => console.error("Chrome bridge alarm failed:", error));
}
async function initBridgeAlarms() {
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
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
    tabs: tabs.filter(t => Number.isInteger(t.id) && t.groupId >= 0)
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
  const [snapshot, token, registry] = await Promise.all([
    browserSnapshot(), ensureSessionToken(), load()
  ]);
  if (message.type === "AP_GET") {
    return { registry, snapshot, token, overview: overview(registry, snapshot, token) };
  }
  if (message.type === "AP_CHAT_DIAGNOSE") {
    const registered = registry.sessions.filter(session=>
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
    planBridgeSync();
    return { registry: next, snapshot, token, overview: overview(next, snapshot, token) };
  }
  throw new Error("잘못된 요청입니다.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore notifications so the worker does not process its own broadcast.
  if (!message || !["AP_GET", "AP_MUTATE", "AP_BRIDGE_STATUS", "AP_BRIDGE_PAIR", "AP_BRIDGE_SYNC", "AP_BRIDGE_DISCONNECT", "AP_CHAT_DIAGNOSE"].includes(message.type)) return false;
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
