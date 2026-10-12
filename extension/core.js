// Pure, browser-independent registry and reconciliation logic.
export const STORAGE_KEY = "autopilot.registry.v1";
export const SESSION_KEY = "autopilot.browser-session.v1";
export const SCHEMA_VERSION = 1;

export function emptyRegistry() {
  return { version: SCHEMA_VERSION, groups: [], sessions: [] };
}

export function normalizedRegistry(value) {
  if (!value || value.version !== SCHEMA_VERSION ||
      !Array.isArray(value.groups) || !Array.isArray(value.sessions)) {
    return emptyRegistry();
  }
  // Do not preserve unexpected properties or accept malformed identity records.
  return {
    version: SCHEMA_VERSION,
    groups: value.groups.filter(g => g && typeof g.key === "string" &&
      Number.isInteger(g.groupId) && Number.isInteger(g.windowId) &&
      typeof g.sessionToken === "string").map(g => ({
        key: g.key, groupId: g.groupId, windowId: g.windowId,
        sessionToken: g.sessionToken, label: typeof g.label === "string" ? g.label : "",
        color: typeof g.color === "string" ? g.color : "grey",
        paused: g.paused === true, enrolledAt: Number(g.enrolledAt) || 0
      })),
    sessions: value.sessions.filter(s => s && typeof s.key === "string" &&
      typeof s.groupKey === "string" && Number.isInteger(s.tabId) &&
      typeof s.sessionToken === "string").map(s => ({
        key: s.key, groupKey: s.groupKey, tabId: s.tabId,
        sessionToken: s.sessionToken, url: typeof s.url === "string" ? s.url : "",
        title: typeof s.title === "string" ? s.title : "",
        paused: s.paused === true, enrolledAt: Number(s.enrolledAt) || 0
      }))
  };
}

function findGroup(snapshot, id) {
  return snapshot.groups.find(g => g.id === id);
}
function findTab(snapshot, id) {
  return snapshot.tabs.find(t => t.id === id);
}
function requireGroup(registry, key) {
  const group = registry.groups.find(g => g.key === key);
  if (!group) throw new Error("등록된 그룹을 찾을 수 없습니다.");
  return group;
}
function requireSession(registry, key) {
  const session = registry.sessions.find(s => s.key === key);
  if (!session) throw new Error("등록된 탭을 찾을 수 없습니다.");
  return session;
}
function createKey(makeId) {
  const key = makeId();
  if (typeof key !== "string" || !key) throw new Error("유효하지 않은 식별자입니다.");
  return key;
}

export function groupStatus(group, snapshot, token) {
  if (group.sessionToken !== token) return "needs-rebind";
  const live = findGroup(snapshot, group.groupId);
  return live && live.windowId === group.windowId ? "connected" : "missing";
}

export function sessionStatus(session, registry, snapshot, token) {
  const group = registry.groups.find(g => g.key === session.groupKey);
  if (!group || groupStatus(group, snapshot, token) !== "connected") return "needs-rebind";
  if (session.sessionToken !== token) return "needs-rebind";
  const live = findTab(snapshot, session.tabId);
  if (!live || live.groupId !== group.groupId || live.windowId !== group.windowId) {
    return "missing";
  }
  // Navigation to a different conversation must never inherit enrollment silently.
  if ((live.url || "") !== session.url) return "url-changed";
  return "connected";
}

export function activeGroupFor(registry, snapshot, token, groupId) {
  const live = findGroup(snapshot, groupId);
  return live && registry.groups.find(g =>
    g.groupId === live.id && g.windowId === live.windowId &&
    groupStatus(g, snapshot, token) === "connected");
}

export function activeSessionFor(registry, snapshot, token, tabId) {
  const live = findTab(snapshot, tabId);
  if (!live) return undefined;
  return registry.sessions.find(s =>
    s.tabId === tabId && sessionStatus(s, registry, snapshot, token) === "connected");
}

function duplicateGroup(registry, snapshot, token, live, excludeKey) {
  return registry.groups.some(g => g.key !== excludeKey &&
    g.groupId === live.id && g.windowId === live.windowId &&
    groupStatus(g, snapshot, token) === "connected");
}

function duplicateTab(registry, snapshot, token, live, excludeKey) {
  return registry.sessions.some(s => s.key !== excludeKey &&
    s.tabId === live.id && sessionStatus(s, registry, snapshot, token) === "connected");
}

export function applyAction(raw, action, snapshot, token, makeId, now) {
  const registry = normalizedRegistry(raw);
  if (!token || typeof token !== "string") throw new Error("브라우저 세션을 확인할 수 없습니다.");
  if (!action || typeof action.type !== "string") throw new Error("알 수 없는 요청입니다.");
  // Never trust tab or group IDs coming from a UI without verifying live snapshot.
  switch (action.type) {
    case "enrollGroup": {
      const live = findGroup(snapshot, action.groupId);
      if (!live || !Number.isInteger(live.windowId)) throw new Error("Chrome 그룹이 존재하지 않습니다.");
      if (duplicateGroup(registry, snapshot, token, live)) throw new Error("이미 등록된 그룹입니다.");
      registry.groups.push({
        key: createKey(makeId), groupId: live.id, windowId: live.windowId,
        sessionToken: token, label: live.title || "이름 없는 그룹", color: live.color || "grey",
        paused: false, enrolledAt: now
      });
      break;
    }
    case "removeGroup": {
      requireGroup(registry, action.groupKey);
      registry.groups = registry.groups.filter(g => g.key !== action.groupKey);
      registry.sessions = registry.sessions.filter(s => s.groupKey !== action.groupKey);
      break;
    }
    case "pauseGroup": {
      requireGroup(registry, action.groupKey).paused = action.paused === true;
      break;
    }
    case "rebindGroup": {
      const group = requireGroup(registry, action.groupKey);
      const live = findGroup(snapshot, action.groupId);
      if (!live) throw new Error("다시 연결할 Chrome 그룹을 찾을 수 없습니다.");
      if (duplicateGroup(registry, snapshot, token, live, group.key)) {
        throw new Error("다른 등록에 연결된 그룹입니다.");
      }
      group.groupId = live.id;
      group.windowId = live.windowId;
      group.sessionToken = token;
      group.label = live.title || "이름 없는 그룹";
      group.color = live.color || "grey";
      // Existing tab registrations deliberately remain stale, requiring manual rebind.
      // Even if a tab ID is reused, it will not become active by accident.
      for (const session of registry.sessions.filter(s => s.groupKey === group.key)) {
        session.sessionToken = "pending-manual-rebind";
      }
      break;
    }
    case "enrollTab": {
      const group = requireGroup(registry, action.groupKey);
      if (groupStatus(group, snapshot, token) !== "connected") {
        throw new Error("먼저 그룹 연결을 복구하십시오.");
      }
      const live = findTab(snapshot, action.tabId);
      if (!live || live.groupId !== group.groupId || live.windowId !== group.windowId) {
        throw new Error("선택한 탭이 등록된 그룹에 속하지 않습니다.");
      }
      if (duplicateTab(registry, snapshot, token, live)) throw new Error("이미 등록된 탭입니다.");
      registry.sessions.push({
        key: createKey(makeId), groupKey: group.key, tabId: live.id,
        sessionToken: token, url: live.url || "", title: live.title || "",
        paused: false, enrolledAt: now
      });
      break;
    }
    case "removeTab": {
      requireSession(registry, action.sessionKey);
      registry.sessions = registry.sessions.filter(s => s.key !== action.sessionKey);
      break;
    }
    case "pauseTab": {
      requireSession(registry, action.sessionKey).paused = action.paused === true;
      break;
    }
    case "rebindTab": {
      const session = requireSession(registry, action.sessionKey);
      const group = requireGroup(registry, session.groupKey);
      if (groupStatus(group, snapshot, token) !== "connected") {
        throw new Error("먼저 그룹 연결을 복구하십시오.");
      }
      const live = findTab(snapshot, action.tabId);
      if (!live || live.groupId !== group.groupId || live.windowId !== group.windowId) {
        throw new Error("선택한 탭이 연결된 그룹에 속하지 않습니다.");
      }
      if (duplicateTab(registry, snapshot, token, live, session.key)) {
        throw new Error("다른 등록에 연결된 탭입니다.");
      }
      session.tabId = live.id;
      session.sessionToken = token;
      session.url = live.url || "";
      session.title = live.title || "";
      break;
    }
    default: throw new Error("지원하지 않는 요청입니다.");
  }
  return registry;
}

export function overview(registry, snapshot, token) {
  const groupStates = registry.groups.map(g => groupStatus(g, snapshot, token));
  const sessionStates = registry.sessions.map(s => sessionStatus(s, registry, snapshot, token));
  return {
    discoveredGroups: snapshot.groups.length,
    discoveredTabs: snapshot.tabs.length,
    registeredGroups: registry.groups.length,
    registeredTabs: registry.sessions.length,
    activeGroups: groupStates.filter(s => s === "connected").length,
    activeTabs: sessionStates.filter(s => s === "connected").length,
    attention: groupStates.filter(s => s !== "connected").length +
      sessionStates.filter(s => s !== "connected").length
  };
}
