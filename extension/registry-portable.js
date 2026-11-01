export const PORTABLE_FORMAT = "development-autopilot-chrome-registry";
export const PORTABLE_VERSION = 1;
const LIMIT_GROUPS = 100;
const LIMIT_SESSIONS = 150;

function exactChatUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" &&
      /^\/(?:c\/|g\/[^/]+\/c\/)/.test(url.pathname);
  } catch { return false; }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function restoreExactRegistrations(raw, snapshot, token) {
  const registry = structuredClone(raw);
  const groups = Array.isArray(registry?.groups) ? registry.groups : [];
  const sessions = Array.isArray(registry?.sessions) ? registry.sessions : [];
  const liveGroups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
  const liveTabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs : [];
  if (!token || !sessions.length) {
    return { registry, changed: false, groupsRestored: 0, tabsRestored: 0 };
  }
  let groupsRestored = 0;
  let tabsRestored = 0;
  const usedGroups = new Set();
  const usedTabs = new Set();

  // Reserve currently valid assignments so recovery cannot steal a live tab.
  for (const group of groups) {
    const live = liveGroups.find(g => g.id === group.groupId &&
      g.windowId === group.windowId);
    if (group.sessionToken === token && live) usedGroups.add(live.windowId + ":" + live.id);
  }
  for (const session of sessions) {
    const group = groups.find(g => g.key === session.groupKey);
    const live = liveTabs.find(t => t.id === session.tabId && t.url === session.url &&
      t.groupId === group?.groupId && t.windowId === group?.windowId);
    if (session.sessionToken === token && group?.sessionToken === token && live) {
      usedTabs.add(live.id);
    }
    if(session.groupKey===""){
      const stand=liveTabs.find(t=>t.id===session.tabId&&t.url===session.url&&
        t.groupId===-1&&t.windowId===session.windowId);
      if(session.sessionToken===token&&stand)usedTabs.add(stand.id);
    }
  }
  // Recover standalone chats using only a UNIQUE exact URL and an ungrouped
  // physical tab. Titles are not evidence and no user messages are sent.
  for(const session of sessions.filter(s=>s.groupKey==="")){
    if(!exactChatUrl(session.url)||session.paused)continue;
    const current=liveTabs.find(t=>t.id===session.tabId&&t.url===session.url&&
      t.groupId===-1&&t.windowId===session.windowId);
    if(session.sessionToken===token&&current)continue;
    if(sessions.some(other=>other!==session&&other.url===session.url))continue;
    const candidates=liveTabs.filter(t=>t.groupId===-1&&t.url===session.url&&
      !usedTabs.has(t.id));
    if(candidates.length!==1)continue;
    const match=candidates[0];
    session.tabId=match.id;session.windowId=match.windowId;
    session.sessionToken=token;usedTabs.add(match.id);
    tabsRestored++;
  }

  for (const group of groups) {
    if (group.sessionToken === token &&
        liveGroups.some(g => g.id === group.groupId && g.windowId === group.windowId)) continue;
    const candidates = liveGroups.filter(g => g.title === group.label &&
      !usedGroups.has(g.windowId + ":" + g.id));
    // Never guess from a label alone. At least one unique exact conversation URL must prove the group.
    const matches = candidates.filter(g => sessions.some(s =>
      s.groupKey === group.key && exactChatUrl(s.url) &&
      liveTabs.some(t => t.groupId === g.id && t.windowId === g.windowId &&
        t.url === s.url)));
    if (matches.length !== 1) continue;
    const live = matches[0];
    // If old registrations duplicate the same exact chat, recover only the
    // uniquely newest registration. Do not reactivate obsolete duplicates.
    const duplicates = groups.filter(other => other.label === group.label &&
      sessions.some(s => s.groupKey === other.key && exactChatUrl(s.url) &&
        liveTabs.some(t => t.groupId === live.id && t.windowId === live.windowId &&
          t.url === s.url)));
    if (duplicates.length > 1) {
      const newest = Math.max(...duplicates.map(x => x.enrolledAt || 0));
      if (group.enrolledAt !== newest ||
          duplicates.filter(x => (x.enrolledAt || 0) === newest).length !== 1) continue;
    }
    group.groupId = live.id;
    group.windowId = live.windowId;
    group.sessionToken = token;
    usedGroups.add(live.windowId + ":" + live.id);
    groupsRestored++;
  }

  for (const group of groups) {
    if (group.sessionToken !== token) continue;
    const activeGroup = liveGroups.find(g => g.id === group.groupId &&
      g.windowId === group.windowId);
    if (!activeGroup) continue;
    for (const session of sessions.filter(s => s.groupKey === group.key)) {
      if (!exactChatUrl(session.url)) continue;
      const current = liveTabs.find(t => t.id === session.tabId &&
        t.groupId === group.groupId && t.windowId === group.windowId &&
        t.url === session.url);
      if (session.sessionToken === token && current) continue;
      const candidates = liveTabs.filter(t => t.groupId === group.groupId &&
        t.windowId === group.windowId && t.url === session.url && !usedTabs.has(t.id));
      if (candidates.length !== 1) continue;
      if (sessions.some(other => other !== session && other.groupKey === group.key &&
        other.url === session.url)) continue;
      session.tabId = candidates[0].id;
      session.sessionToken = token;
      usedTabs.add(session.tabId);
      tabsRestored++;
    }
  }
  return { registry, changed: groupsRestored + tabsRestored > 0, groupsRestored, tabsRestored };
}

export function exportPortableRegistry(registry, snapshot = null, token = null) {
  const groupsByKey = new Map(registry.groups.map(g => [g.key, g]));
  const selected = new Map();
  for (const session of registry.sessions) {
    const group = groupsByKey.get(session.groupKey);
    if(!exactChatUrl(session.url))continue;
    if(session.groupKey===""&&!group){
      const liveTab=snapshot?.tabs?.find(t=>t.id===session.tabId&&
        t.windowId===session.windowId&&t.groupId===-1&&t.url===session.url);
      const connected=Boolean(token&&session.sessionToken===token&&liveTab);
      const identity="standalone\n"+session.url;
      const previous=selected.get(identity);
      const rank=[Number(connected),0,session.enrolledAt||0];
      if(!previous||rank[0]>previous.rank[0]||
        (rank[0]===previous.rank[0]&&rank[2]>previous.rank[2]))
        selected.set(identity,{session,group:null,rank});
      continue;
    }
    if(!group)continue;
    const liveGroup = snapshot?.groups?.find(g => g.id === group.groupId &&
      g.windowId === group.windowId);
    const liveTab = snapshot?.tabs?.find(t => t.id === session.tabId &&
      t.windowId === group.windowId && t.groupId === group.groupId &&
      t.url === session.url);
    const connected = Boolean(token && group.sessionToken === token &&
      session.sessionToken === token && liveGroup && liveTab);
    const identity = group.label + "\n" + session.url;
    const previous = selected.get(identity);
    const currentRank = [Number(connected), group.enrolledAt || 0, session.enrolledAt || 0];
    if (previous && previous.rank.every((v, i) => v === currentRank[i])) continue;
    if (!previous || currentRank.some((v, i) => v > previous.rank[i] &&
        currentRank.slice(0, i).every((x, j) => x === previous.rank[j]))) {
      selected.set(identity, { session, group, rank:currentRank });
    }
  }
  const entries = [...selected.values()];
  const used = new Set(entries.filter(x=>x.group).map(x => x.group.key));
  const groups = registry.groups.filter(g => used.has(g.key)).map(g => ({
    key:g.key,label:g.label,color:g.color,paused:!!g.paused
  }));
  const sessions = entries.map(({session:s}) => ({
    key:s.key,groupKey:s.groupKey,url:s.url,title:s.title,paused:!!s.paused
  }));
  return { format: PORTABLE_FORMAT, version: PORTABLE_VERSION,
    exportedAt: new Date().toISOString(), groups, sessions };
}

export function importPortableRegistry(raw, document, snapshot, token, makeId, now) {
  if (!document || document.format !== PORTABLE_FORMAT || document.version !== PORTABLE_VERSION ||
      !Array.isArray(document.groups) || !Array.isArray(document.sessions) ||
      document.groups.length > LIMIT_GROUPS || document.sessions.length > LIMIT_SESSIONS) {
    throw Error("지원하지 않는 Autopilot 설정 파일입니다.");
  }
  const registry = structuredClone(raw);
  const mapping = new Map();
  const keys = new Set();
  const sessionKeys = new Set();
  for (const g of document.groups) {
    if (!g || typeof g.key !== "string" || !IDENTIFIER.test(g.key) || keys.has(g.key) ||
        typeof g.label !== "string" || !g.label || g.label.length > 120) {
      throw Error("중복되거나 잘못된 그룹 정보입니다.");
    }
    keys.add(g.key);
  }
  for (const s of document.sessions) {
    if (!s || typeof s.key !== "string" || !IDENTIFIER.test(s.key) || sessionKeys.has(s.key) ||
        (s.groupKey!==""&&!keys.has(s.groupKey)) || !exactChatUrl(s.url) ||
        typeof s.title !== "string" || s.title.length > 200) {
      throw Error("중복되거나 잘못된 ChatGPT 대화 정보입니다.");
    }
    sessionKeys.add(s.key);
  }
  let importedGroups = 0;
  let importedTabs = 0;
  const sessionKeyMapping = {};
  // Never replace an existing mapping or credential. Imported entries are
  // staged as disconnected and become active only after exact URL recovery.
  for (const g of document.groups) {
    const existing = registry.groups.find(x => x.key === g.key) ||
      registry.groups.find(x => x.label === g.label);
    if (existing) {
      mapping.set(g.key, existing.key);
      continue;
    }
    const key = g.key && !registry.groups.some(x => x.key === g.key) ? g.key : makeId();
    mapping.set(g.key, key);
    registry.groups.push({ key, label: g.label, color: g.color || "grey",
      paused: g.paused === true, groupId: -1, windowId: -1,
      sessionToken: "pending-exact-url-restore", enrolledAt: now });
    importedGroups++;
  }
  for (const s of document.sessions) {
    const key = s.groupKey===""?"":mapping.get(s.groupKey);
    const existingSession = registry.sessions.find(x => x.groupKey === key && x.url === s.url);
    if (existingSession) {
      sessionKeyMapping[s.key] = existingSession.key;
      continue;
    }
    const sessionKey = registry.sessions.some(x => x.key === s.key) ? makeId() : s.key;
    sessionKeyMapping[s.key] = sessionKey;
    registry.sessions.push({ key: sessionKey, groupKey: key, url: s.url,
      title: s.title, paused: s.paused === true, tabId: -1,
      windowId:s.groupKey===""?-1:null,
      sessionToken: "pending-exact-url-restore", enrolledAt: now });
    importedTabs++;
  }
  const result = restoreExactRegistrations(registry, snapshot, token);
  return { ...result, importedGroups, importedTabs, sessionKeyMapping,
    restoredGroups: result.groupsRestored, restoredTabs: result.tabsRestored };
}
