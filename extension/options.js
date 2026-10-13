import {
  activeGroupFor, activeSessionFor, groupStatus, sessionStatus
} from "./core.js";

const $ = id => document.getElementById(id);
let data;
let mutating = false;
let refreshQueued = false;

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function badge(text, type = "") {
  return element("span", "badge " + type, text);
}

function actionButton(text, kind, handler, disabled = false) {
  const button = element("button", "button " + kind, text);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", handler);
  return button;
}

function showNotice(message, error = false) {
  const node = $("notice");
  node.textContent = message;
  node.className = "notice" + (error ? " error" : "");
}

function clearNotice() {
  $("notice").className = "notice hidden";
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "EXTENSION_WORKER_UNAVAILABLE");
  return response.data;
}

async function refresh() {
  if (mutating) { refreshQueued = true; return; }
  try {
    data = await request({ type: "AP_GET" });
    render();
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function mutate(action) {
  if (mutating) return;
  mutating = true;
  clearNotice();
  try {
    data = await request({ type: "AP_MUTATE", action });
    render();
    showNotice("변경 사항이 로컬에 저장되었습니다.");
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    mutating = false;
    if (refreshQueued) {
      refreshQueued = false;
      await refresh();
    }
  }
}

function renderStats() {
  const stats = $("stats");
  stats.replaceChildren();
  const items = [
    ["발견된 그룹", data.overview.discoveredGroups],
    ["그룹 내 탭", data.overview.discoveredTabs],
    ["연결된 등록 탭", data.overview.activeTabs],
    ["확인 필요", data.overview.attention]
  ];
  items.forEach(([label, count], index) => {
    const node = element("div", "stat" + (index === 3 && count ? " attention" : ""));
    node.append(element("strong", "", String(count)), element("span", "", label));
    stats.append(node);
  });
}

function panelHeader(title, details, controls, statusLabel, statusClass = "") {
  const head = element("div", "panel-head");
  const meta = element("div", "panel-meta");
  const line = element("div", "title-line");
  line.append(element("strong", "", title), badge(statusLabel, statusClass));
  meta.append(line, element("div", "secondary-line", details));
  const actions = element("div", "actions");
  for (const control of controls) actions.append(control);
  head.append(meta, actions);
  return head;
}

function labelForGroup(group) {
  return group.title || "이름 없는 그룹";
}

function renderDetected() {
  const root = $("groups");
  root.replaceChildren();
  if (!data.snapshot.groups.length) {
    root.append(element("div", "panel-empty", "현재 열린 Chrome 탭 그룹이 없습니다. Chrome에서 먼저 그룹을 만들어 주십시오."));
    return;
  }
  for (const group of data.snapshot.groups) {
    const registration = activeGroupFor(data.registry, data.snapshot, data.token, group.id);
    const panel = element("article", "panel");
    const tabs = data.snapshot.tabs.filter(t => t.groupId === group.id && t.windowId === group.windowId);
    const controls = registration ? [
      actionButton(registration.paused ? "그룹 재개" : "그룹 일시 정지", "secondary",
        () => mutate({ type: "pauseGroup", groupKey: registration.key, paused: !registration.paused })),
      actionButton("그룹 해제", "danger",
        () => {
          if (confirm("그룹과 연결된 모든 탭 등록을 해제하시겠습니까?")) {
            mutate({ type: "removeGroup", groupKey: registration.key });
          }
        })
    ] : [
      actionButton("그룹 등록", "primary", () => mutate({ type: "enrollGroup", groupId: group.id }))
    ];
    panel.append(panelHeader(labelForGroup(group),
      "창 " + group.windowId + " · 탭 " + tabs.length + "개 · " + group.color,
      controls, registration ? (registration.paused ? "일시 정지" : "그룹 등록됨") : "미등록",
      registration ? (registration.paused ? "warn" : "ok") : "off"));
    const list = element("div", "tab-list");
    if (tabs.length === 0) list.append(element("div", "panel-empty", "그룹에 탭이 없습니다."));
    for (const tab of tabs) {
      const registered = registration && data.registry.sessions.find(s =>
        s.groupKey === registration.key && s.tabId === tab.id && s.sessionToken === data.token);
      const state = registered && sessionStatus(registered, data.registry, data.snapshot, data.token);
      const row = element("div", "tab-row");
      row.append(element("span", "tab-dot" + (state === "connected" ? " enrolled" : "")));
      const meta = element("div", "tab-meta");
      meta.append(element("div", "tab-title", tab.title || "제목 없음"),
        element("div", "tab-url", tab.url || "URL 표시 권한 없음"));
      row.append(meta);
      if (registered) {
        const status = state === "connected" ? (registered.paused ? "일시 정지" : "등록됨") : "다시 확인 필요";
        row.append(badge(status, state === "connected" ? "ok" : "warn"));
        if (state === "url-changed") {
          row.append(actionButton("새 주소로 연결", "secondary", () =>
            mutate({ type: "rebindTab", sessionKey: registered.key, tabId: tab.id })));
        } else {
          row.append(actionButton(registered.paused ? "재개" : "정지", "subtle",
            () => mutate({ type: "pauseTab", sessionKey: registered.key, paused: !registered.paused })));
        }
        row.append(actionButton("해제", "subtle",
          () => mutate({ type: "removeTab", sessionKey: registered.key })));
      } else if (registration) {
        row.append(actionButton("탭 등록", "secondary",
          () => mutate({ type: "enrollTab", groupKey: registration.key, tabId: tab.id })));
      } else {
        row.append(badge("그룹 등록 후 선택", "off"));
      }
      list.append(row);
    }
    panel.append(list);
    root.append(panel);
  }
}

function selector(options, placeholder) {
  const select = element("select", "select");
  select.setAttribute("aria-label", placeholder);
  if (!options.length) {
    const option = document.createElement("option");
    option.textContent = "연결할 대상 없음";
    option.value = "";
    select.append(option);
    select.disabled = true;
    return select;
  }
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    select.append(option);
  }
  return select;
}

function renderRegistered() {
  const root = $("registry");
  root.replaceChildren();
  const { registry, snapshot, token } = data;
  if (!registry.groups.length) {
    root.append(element("div", "panel-empty", "아직 등록한 그룹이 없습니다. 위 목록에서 그룹을 등록해 주십시오."));
    return;
  }
  for (const group of registry.groups) {
    const state = groupStatus(group, snapshot, token);
    const panel = element("article", "panel");
    const active = state === "connected";
    const controls = [];
    if (!active) {
      const candidates = snapshot.groups.filter(g => !activeGroupFor(registry, snapshot, token, g.id));
      const picker = selector(candidates.map(g => [g.id,
        labelForGroup(g) + " · 창 " + g.windowId]), "다시 연결할 그룹 선택");
      controls.push(picker, actionButton("그룹 재연결", "primary",
        () => mutate({ type: "rebindGroup", groupKey: group.key, groupId: Number(picker.value) }),
        !candidates.length));
    }
    controls.push(actionButton("등록 삭제", "danger",
      () => {
        if (confirm("이 그룹 및 등록 탭 기록을 삭제하시겠습니까?")) {
          mutate({ type: "removeGroup", groupKey: group.key });
        }
      }));
    panel.append(panelHeader(group.label,
      "등록 시각 " + (group.enrolledAt ? new Date(group.enrolledAt).toLocaleString("ko-KR") : "알 수 없음") +
      " · 등록 탭 " + registry.sessions.filter(s => s.groupKey === group.key).length + "개",
      controls, active ? (group.paused ? "일시 정지" : "연결됨") :
        state === "needs-rebind" ? "수동 연결 필요" : "그룹을 찾을 수 없음",
      active ? (group.paused ? "warn" : "ok") : "warn"));

    const sessions = registry.sessions.filter(s => s.groupKey === group.key);
    if (sessions.length) {
      const body = element("div", "tab-list");
      for (const session of sessions) {
        const sessionState = sessionStatus(session, registry, snapshot, token);
        const row = element("div", "recovery-row");
        const meta = element("div", "panel-meta");
        meta.append(element("div", "tab-title", session.title || "제목 없음"),
          element("div", "tab-url", session.url || "등록 당시 URL 없음"));
        const actionRow = element("div", "actions");
        actionRow.append(badge(
          sessionState === "connected" ? (session.paused ? "일시 정지" : "연결됨") : "재연결 필요",
          sessionState === "connected" ? "ok" : "warn"));
        if (active && sessionState !== "connected") {
          const candidates = snapshot.tabs.filter(t =>
            t.groupId === group.groupId && t.windowId === group.windowId &&
            !activeSessionFor(registry, snapshot, token, t.id));
          const picker = selector(candidates.map(t =>
            [t.id, t.title || t.url || "탭 " + t.id]), "다시 연결할 탭 선택");
          actionRow.append(picker, actionButton("탭 재연결", "secondary",
            () => mutate({ type: "rebindTab", sessionKey: session.key, tabId: Number(picker.value) }),
            !candidates.length));
        }
        actionRow.append(actionButton("해제", "subtle", () =>
          mutate({ type: "removeTab", sessionKey: session.key })));
        row.append(meta, actionRow);
        body.append(row);
      }
      panel.append(body);
    }
    root.append(panel);
  }
}

function render() {
  renderStats();
  renderDetected();
  renderRegistered();
}

$("refresh").addEventListener("click", refresh);
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "AP_CHANGED") void refresh();
});
window.addEventListener("focus", () => void refresh());
void refresh();


async function showBridgeStatus() {
  try {
    const status = await request({ type: "AP_BRIDGE_STATUS" });
    $("bridge-status").textContent = status.paired
      ? "로컬 연결 설정됨 · 마지막 동기화: " +
        (status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString("ko-KR") : "없음") +
        (status.error ? " · 오류: " + status.error : "")
      : "연결되지 않았습니다. 먼저 로컬 관리 화면에서 1회용 코드를 발급하십시오.";
    const latest=status.extensionVersion==="0.4.4" &&
      status.composerBuild==="composer-2026-10-13-r5";
    $("extension-runtime").textContent =
      "실행 중인 확장 코드: "+(status.extensionVersion||"버전 미보고")+
      " · 입력창 엔진: "+(status.composerBuild||"미확인")+
      (latest?" · 최신 확인":
        " · 구버전/불일치: 이 관리 탭을 닫고 chrome://extensions에서 확장을 새로고침한 뒤 새 관리 화면을 여십시오.");
    $("chat-diagnose").disabled = !latest;
    $("bridge-sync").disabled = !status.paired;
    $("bridge-disconnect").disabled = !status.paired;
  } catch (error) {
    $("bridge-status").textContent = "확장 서비스 워커 연결 실패: "+error.message+
      " · 이 관리 탭을 완전히 닫고 chrome://extensions에서 확장을 새로고침한 다음 새 관리 화면을 여십시오.";
    $("extension-runtime").textContent = "실행 버전 확인 불가 — 재로드 후 진단하십시오.";
    $("chat-diagnose").disabled = true;
  }
}
async function bridgeCommand(message) {
  try {
    $("bridge-status").textContent = "로컬 연결 처리 중…";
    const result = await request(message);
    if (message.type === "AP_BRIDGE_PAIR") {
      $("bridge-code").value = "";
      if (!result.connected) showNotice(result.message || "페어링 후 동기화 실패", true);
      else showNotice("로컬 프로그램에 연결되었습니다.");
    } else if (message.type === "AP_BRIDGE_SYNC") {
      showNotice(result.connected ? "등록된 탭 상태가 동기화되었습니다." : result.message,
        !result.connected);
    } else {
      showNotice("확장 프로그램의 로컬 연결 정보를 지웠습니다. 로컬 등록도 해제하려면 관리 화면에서 해제하십시오.");
    }
  } catch (error) { showNotice(error.message, true); }
  await showBridgeStatus();
}
$("bridge-pair").addEventListener("click", () => {
  const code = $("bridge-code").value.trim();
  if (!code) return showNotice("일회용 연결 코드를 입력하십시오.", true);
  void bridgeCommand({ type: "AP_BRIDGE_PAIR", code });
});
$("bridge-sync").addEventListener("click", () => {
  void bridgeCommand({ type: "AP_BRIDGE_SYNC" });
});
$("bridge-disconnect").addEventListener("click", () => {
  if (confirm("이 Chrome 확장 프로그램에서 로컬 연결 토큰을 지우시겠습니까?")) {
    void bridgeCommand({ type: "AP_BRIDGE_DISCONNECT" });
  }
});
$("chat-diagnose").addEventListener("click",async()=>{
  const element=$("chat-diagnostic-result");
  element.textContent="등록한 ChatGPT 탭의 입력창을 읽기 전용으로 점검하는 중…";
  try{
    const result=await request({type:"AP_CHAT_DIAGNOSE"});
    if(result.composerBuild!=="composer-2026-10-13-r5" &&
       result.build!=="composer-2026-10-13-r5"){
      element.textContent="구버전 실행 중입니다. 확장 프로그램을 제거한 뒤 최신 폴더에서 다시 로드하십시오.";
      return;
    }
    if(!result.eligible){
      element.textContent="진단: "+(result.reason||"REGISTERED_SESSION_NOT_FOUND");
      return;
    }
    element.textContent="입력창 진단: "+result.diagnosis+
      " · 편집기 후보 "+result.editableCandidates+
      "개 · 전송 버튼 "+result.sendControls+
      "개(비활성 "+result.sendDisabled+
      "개) · 전송 폼 "+result.formWithEditors+
      "개 · 제출 버튼 "+result.formSubmitControls+
      "개 · 폼 제출 지원 "+(result.formSubmitSupported?"예":"아니요")+
      " · 런타임 "+result.build;
  }catch(error){
    element.textContent="진단 실패: "+error.message+
      " · 관리 탭을 닫고 chrome://extensions에서 확장 프로그램 새로고침 후 새 관리 탭을 여십시오. 메시지는 전송되지 않았습니다.";
  }
});
void showBridgeStatus();
