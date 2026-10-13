import {
  STORAGE_KEY, SESSION_KEY, normalizedRegistry, applyAction, overview,
  groupStatus, sessionStatus
} from "./core.js";


import { BRIDGE_BASE, BRIDGE_CONFIG_KEY, bridgePayload } from "./bridge-core.js";

const SYNC_ALARM = "autopilot-bridge-sync";
const DIRTY_ALARM = "autopilot-bridge-change";

async function bridgeInfo() {
  return (await chrome.storage.local.get(BRIDGE_CONFIG_KEY))[BRIDGE_CONFIG_KEY] || null;
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
      body: JSON.stringify(bridgePayload(registry, snapshot, token))
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "브리지 동기화 실패");
    const next = { ...config, lastSyncedAt: Date.now(), error: "" };
    await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: next });
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
  chrome.alarms.create(DIRTY_ALARM, { delayInMinutes: 0.5 })
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
  const [snapshot, token, registry] = await Promise.all([
    browserSnapshot(), ensureSessionToken(), load()
  ]);
  if (message.type === "AP_GET") {
    return { registry, snapshot, token, overview: overview(registry, snapshot, token) };
  }
  if (message.type === "AP_BRIDGE_STATUS") {
    const config = await bridgeInfo();
    return {
      paired: Boolean(config?.token),
      lastSyncedAt: config?.lastSyncedAt || null,
      error: config?.error || ""
    };
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
  if (!message || !["AP_GET", "AP_MUTATE", "AP_BRIDGE_STATUS", "AP_BRIDGE_PAIR", "AP_BRIDGE_SYNC", "AP_BRIDGE_DISCONNECT"].includes(message.type)) return false;
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
