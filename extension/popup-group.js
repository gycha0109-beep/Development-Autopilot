import { classifyChatGPTRoute } from "./chat-routes.js";
import { applyAction, normalizedRegistry, sessionStatus, groupStatus } from "./core.js";

export async function attachChatToExistingGroup(input, {
  getTab, getGroup, groupTabs, browserSnapshot, load, save,
  epoch, newKey, now
}) {
  const tabId = input?.tabId, groupId = input?.groupId;
  if (!Number.isInteger(tabId) || tabId < 0 ||
      !Number.isInteger(groupId) || groupId < 0)
    throw Error("선택한 채팅과 그룹을 다시 확인하십시오.");
  const [tab, target, token, stored, before] = await Promise.all([
    getTab(tabId), getGroup(groupId), epoch(), load(), browserSnapshot()
  ]);
  const registry = normalizedRegistry(stored);
  if (!tab || classifyChatGPTRoute(tab.url) !== "existing")
    throw Error("기존 ChatGPT 대화 탭만 그룹에 넣을 수 있습니다.");
  if (!target || target.id !== groupId || target.windowId !== tab.windowId)
    throw Error("동일한 Chrome 창에 있는 그룹만 선택할 수 있습니다.");
  const observed = before.tabs.find(t=>t.id===tabId);
  // A tab outside any Chrome group is intentionally omitted by browserSnapshot.
  // tabs.get verifies it before the move; a second snapshot verifies it afterward.
  if (tab.groupId>=0 &&
      (!observed || observed.windowId!==tab.windowId ||
       observed.url!==tab.url || observed.groupId!==tab.groupId))
    throw Error("?? ?? ???????. ??? ????????.");
  const groupRegistration = registry.groups.find(g =>
    g.groupId === groupId && g.windowId === target.windowId);
  if (groupRegistration && groupStatus(groupRegistration,before,token)!=="connected")
    throw Error("기존 그룹 등록이 오래되었습니다. 관리 화면에서 연결 상태를 복구하십시오.");
  const registered = registry.sessions.filter(s=>s.tabId===tabId);
  if (registered.length > 1 ||
      registered.some(s=>s.url!==tab.url ||
        sessionStatus(s,registry,before,token)!=="connected"))
    throw Error("기존 탭 등록이 일치하지 않습니다. 관리 화면에서 복구하십시오.");
  const previous = registered[0] || null;
  if (tab.groupId !== groupId) await groupTabs({groupId,tabIds:[tabId]});
  const after = await browserSnapshot();
  const live = after.tabs.find(t=>t.id===tabId);
  const liveGroup = after.groups.find(g=>g.id===groupId && g.windowId===target.windowId);
  if (!live || live.windowId !== tab.windowId || live.groupId !== groupId ||
      live.url !== tab.url || !liveGroup)
    throw Error("그룹 이동 후 채팅 동일성을 검증하지 못했습니다. 자동 실행은 변경하지 않았습니다.");
  let next = registry;
  let destination = groupRegistration;
  if (!destination) {
    next = applyAction(next,{type:"enrollGroup",groupId},after,token,newKey,now());
    destination = next.groups.find(g=>g.groupId===groupId &&
      g.windowId===target.windowId && g.sessionToken===token);
  }
  if (previous) {
    next.sessions = next.sessions.map(s=>s.key===previous.key ?
      {...s,groupKey:destination.key,tabId,sessionToken:token,title:live.title||s.title} : s);
  } else {
    next = applyAction(next,{type:"enrollTab",groupKey:destination.key,tabId},
      after,token,newKey,now());
  }
  const session = next.sessions.find(s=>s.tabId===tabId &&
    s.groupKey===destination.key && s.url===tab.url);
  if (!session) throw Error("그룹 등록 결과를 확인하지 못했습니다.");
  await save(next);
  return {sessionKey:session.key,groupId,moved:tab.groupId!==groupId,
    preservedSession:Boolean(previous),groupName:liveGroup.title||"이름 없는 그룹",
    registry:next,snapshot:after,token};
}