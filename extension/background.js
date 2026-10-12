import {
  STORAGE_KEY, SESSION_KEY, normalizedRegistry, applyAction, overview,
  groupStatus, sessionStatus
} from "./core.js";

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
  if (message.type === "AP_MUTATE") {
    const next = applyAction(registry, message.action, snapshot, token,
      () => crypto.randomUUID(), Date.now());
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return { registry: next, snapshot, token, overview: overview(next, snapshot, token) };
  }
  throw new Error("잘못된 요청입니다.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore notifications so the worker does not process its own broadcast.
  if (!message || !["AP_GET", "AP_MUTATE"].includes(message.type)) return false;
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
