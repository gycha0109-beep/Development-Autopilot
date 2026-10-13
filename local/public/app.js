const $ = id => document.getElementById(id);
let data = null;

function node(tag, cls, value) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (value != null) el.textContent = String(value);
  return el;
}
function button(label, cls, action, disabled = false) {
  const el = node("button", cls, label);
  el.type = "button";
  el.disabled = disabled;
  el.addEventListener("click", action);
  return el;
}
function notify(message, error = false) {
  const el = $("notice");
  el.className = "notice" + (error ? " error" : "");
  el.textContent = message;
}
async function request(path, payload) {
  const options = payload === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  };
  const res = await fetch(path, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "요청에 실패했습니다.");
  return body;
}
async function act(path, payload = {}) {
  try {
    await request(path, payload);
    notify("저장했습니다. 상태가 갱신되었습니다.");
    await refresh();
  } catch (e) { notify(e.message, true); }
}
function showStat(label, count, attention = false) {
  const card = node("div", "stat" + (attention && count ? " attention" : ""));
  card.append(node("strong", "", count), node("span", "", label));
  return card;
}
function relativeDate(t) {
  if (t == null) return "기록 없음";
  return new Date(t).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "medium" });
}
function classFor(state) {
  if (state === "COMPLETE" || state === "READY") return "green";
  if (["BLOCKED", "UNKNOWN"].includes(state)) return "red";
  if (["WAIT_HUMAN", "WAIT_EXTERNAL", "RUNNING"].includes(state)) return "amber";
  return "";
}

function renderBridge() {
  const bridge = data.chromeBridge;
  const clients = $("bridge-clients");
  clients.replaceChildren();
  const online = bridge.clients.filter(c => c.status === "online").length;
  $("bridge-connection-status").textContent = online
    ? online + "개 확장 프로그램 온라인 · 등록 탭 " + bridge.sessions.length + "개"
    : "연결된 확장 프로그램 없음";
  if (!bridge.clients.length) {
    clients.append(node("div", "empty", "연결된 Chrome 확장 프로그램이 없습니다."));
    return;
  }
  for (const client of bridge.clients) {
    const row = node("div", "event");
    const info = node("div");
    info.append(node("b", "", "확장 프로그램 " + client.extensionId.slice(0, 8) + "…"),
      node("span", "", " · " + client.status + " · 최근 동기화 " + relativeDate(client.lastSeenAt)));
    row.append(info, button("페어링 해제", "danger", () => {
      if (confirm("해당 확장 프로그램의 토큰 및 작업축 연결을 모두 해제하시겠습니까?")) {
        void act("/api/v1/bridge/unpair", { extensionId: client.extensionId });
      }
    }));
    clients.append(row);
  }
}
function chromeControls(item, controls) {
  const bridge = data.chromeBridge;
  const link = bridge.links.find(l => l.workstreamId === item.id);
  if (link) {
    const label = (link.title || link.sessionKey) + " · " + link.status;
    controls.append(node("span", "tag " + classFor(link.status === "connected" ? "READY" : "UNKNOWN"), label));
    controls.append(button("탭 연결 해제", "subtle", () => act(
      "/api/v1/workstreams/" + encodeURIComponent(item.id) + "/link-chrome",
      { extensionId: link.extensionId, sessionKey: null }
    )));
    return;
  }
  const linked = new Set(bridge.links.map(l => l.extensionId + ":" + l.sessionKey));
  const choices = bridge.sessions.filter(s => s.status === "connected" &&
    !linked.has(s.extensionId + ":" + s.sessionKey));
  if (!choices.length) {
    controls.append(node("span", "tag", "연결 가능한 등록 탭 없음"));
    return;
  }
  const select = node("select", "select");
  select.setAttribute("aria-label", item.name + "에 연결할 Chrome 탭");
  for (const session of choices) {
    const option = node("option", "", session.groupLabel + " / " + session.title + " [" + session.extensionId.slice(0, 8) + "]");
    option.value = session.extensionId + ":" + session.sessionKey;
    select.append(option);
  }
  controls.append(select, button("탭 연결", "secondary", () => {
    const selected = choices.find(s => s.extensionId + ":" + s.sessionKey === select.value);
    if (selected) void act(
      "/api/v1/workstreams/" + encodeURIComponent(item.id) + "/link-chrome",
      { extensionId: selected.extensionId, sessionKey: selected.sessionKey }
    );
  }));
}

function renderWatchtower() {
  const wt = data.watchtower;
  $("watchtower-status").textContent = wt.status === "connected"
    ? "연결됨 · 계약 " + wt.contractVersion : "연결 안 됨";
  $("watchtower-error").textContent = wt.errorCode
    ? "조회 실패: " + wt.errorCode
    : wt.status === "connected"
      ? "Watchtower의 Run 관측을 표시합니다. GitHub 최종 검증은 아직 연결되지 않았습니다."
      : "Watchtower를 실행하고 CI 상태 새로고침을 누르십시오.";
  $("watchtower-checked").textContent = relativeDate(wt.checkedAt);
  const registry = $("watchtower-registry");
  registry.replaceChildren();
  if (wt.registry) {
    registry.append(node("span", "", "프로젝트 " + wt.registry.projects.length
      + " · 저장소 " + wt.registry.repositories.length
      + " · Track " + wt.registry.tracks.length + "개"));
  } else {
    registry.append(node("span", "", "Registry 미수신"));
  }
  const workstream = $("watchtower-workstream");
  const previous = workstream.value;
  workstream.replaceChildren();
  for (const item of data.workstreams) {
    const opt = node("option", "", item.name + " (" + item.repository + ")");
    opt.value = item.id;
    workstream.append(opt);
  }
  if (data.workstreams.some(s => s.id === previous)) workstream.value = previous;

  const targetDiv = $("watchtower-decisions");
  targetDiv.replaceChildren();
  if (!wt.targets.length) {
    targetDiv.append(node("div", "empty", "아직 Run 관측 대상을 지정하지 않았습니다."));
    return;
  }
  for (const target of wt.targets) {
    const item = data.workstreams.find(w => w.id === target.workstreamId);
    const verdict = wt.results.find(r => r.workstreamId === target.workstreamId);
    const row = node("div", "event");
    const details = node("div");
    details.append(
      node("b", "", (item?.name || target.workstreamId) + " · " + (verdict?.decision || "UNKNOWN")),
      node("div", "bridge-small",
        "Run " + target.runId + " · Attempt " + target.attempt +
        " · " + target.headSha.slice(0, 12) + " · " + (verdict?.reason || "NOT_CHECKED"))
    );
    row.append(details,
      button("대상 해제", "subtle", () =>
        act("/api/v1/workstreams/" + encodeURIComponent(target.workstreamId) +
        "/watchtower-target", { clear: true })));
    targetDiv.append(row);
  }
}

function render() {
  renderWatchtower();
  renderBridge();
  const items = data.workstreams;
  const stop = $("global-stop");
  stop.textContent = data.globalStopped ? "전체 재개" : "전체 정지";
  stop.className = data.globalStopped ? "primary" : "danger";
  const stats = $("stats");
  stats.replaceChildren(
    showStat("전체 작업축", items.length),
    showStat("실행 준비", items.filter(x => x.state === "READY" && !x.paused && x.enabled).length),
    showStat("외부 결과 대기", items.filter(x => x.state === "WAIT_EXTERNAL").length),
    showStat("확인 필요", items.filter(x => ["UNKNOWN","BLOCKED","WAIT_HUMAN"].includes(x.state)).length, true)
  );

  const streams = $("workstreams");
  streams.replaceChildren();
  if (!items.length) streams.append(node("div", "empty notice-card", "등록된 작업축이 없습니다. 위 입력란에서 추가해 주십시오."));
  for (const item of items) {
    const card = node("div", "stream");
    const head = node("div", "stream-top");
    const meta = node("div", "stream-info");
    meta.append(
      node("strong", "", item.name),
      node("div", "stream-meta",
        item.repository + " · " + item.project_key + (item.track_key ? " / " + item.track_key : "") +
        " · 작업 버전 " + item.task_revision)
    );
    const stateText = item.paused ? "PAUSED" : !item.enabled ? "DISABLED" : item.state;
    head.append(meta, node("span", "tag " + classFor(stateText), stateText));
    const bottom = node("div", "stream-bottom");
    const kv = node("div", "stream-kv");
    const k1 = node("div");
    k1.append(node("span", "", "실행 정책"), node("b", "", item.mode === "observe" ? "관찰만" : "모의 실행"));
    const k2 = node("div");
    k2.append(node("span", "", "관찰 주기"), node("b", "", item.interval_minutes + "분"));
    const k3 = node("div");
    k3.append(node("span", "", "다음 검사 시각"), node("b", "", relativeDate(item.next_eligible_at)));
    kv.append(k1, k2, k3);
    const controls = node("div", "stream-controls");
    const path = "/api/v1/workstreams/" + encodeURIComponent(item.id);
    controls.append(
      button(item.paused ? "재개" : "일시 정지", "subtle",
        () => act(path + "/configure", { paused: !item.paused })),
      button(item.mode === "observe" ? "모의 실행 모드" : "관찰 모드", "subtle",
        () => act(path + "/configure", { mode: item.mode === "observe" ? "simulation" : "observe" })),
      button("작업 준비", "secondary", () => act(path + "/arm"), item.state === "READY" || Boolean(item.active_operation_id) || item.state === "WAIT_HUMAN")
    );
    if (item.state === "WAIT_HUMAN" && !item.active_operation_id) {
      controls.append(button("모의 작업 승인", "primary", () => act(path + "/approve")));
    }
    chromeControls(item, controls);
    if (item.active_operation_id) {
      const action = "/api/v1/operations/" + encodeURIComponent(item.active_operation_id) + "/resolve";
      controls.append(
        button("모의 완료", "subtle", () => act(action, { outcome: "completed" })),
        button("모의 실패", "danger", () => act(action, { outcome: "failed" })),
        button("보류 해제", "subtle", () => act(action, { outcome: "abandoned" }))
      );
    }
    bottom.append(kv, controls);
    card.append(head, bottom);
    streams.append(card);
  }
  const events = $("events");
  events.replaceChildren();
  if (!data.events.length) events.append(node("div", "empty", "아직 기록된 활동이 없습니다."));
  for (const e of data.events.slice(0, 14)) {
    const row = node("div", "event");
    const message = node("div");
    message.append(node("b", "", e.kind), node("span", "", " · " + e.reason));
    row.append(message, node("small", "", relativeDate(e.at)));
    events.append(row);
  }
}
async function refresh() {
  try {
    data = await request("/api/v1/snapshot");
    render();
  } catch (e) { notify(e.message, true); }
}
$("create-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const v = new FormData(f);
  const payload = {
    name: v.get("name"),
    projectKey: v.get("projectKey"),
    repository: v.get("repository"),
    trackKey: v.get("trackKey"),
    intervalMinutes: Number(v.get("intervalMinutes"))
  };
  try {
    await request("/api/v1/workstreams", payload);
    f.reset();
    notify("새 작업축을 등록했습니다. 관찰 모드로 시작합니다.");
    await refresh();
  } catch (err) { notify(err.message, true); }
});
$("pair-code-create").addEventListener("click", async () => {
  try {
    const result = await request("/api/v1/bridge/pairing/start", {});
    $("pair-code-value").textContent = result.code;
    $("pair-code-expiry").textContent = "유효 기한: " + relativeDate(result.expiresAt);
    notify("발급된 코드를 Chrome 확장 프로그램 옵션 페이지에 입력하십시오.");
  } catch (error) { notify(error.message, true); }
});
$("watchtower-refresh").addEventListener("click", async () => {
  try {
    const payload = await request("/api/v1/watchtower/refresh", {});
    const status = payload.watchtower;
    notify(status.status === "connected"
      ? "Watchtower 최신 관측을 조회했습니다."
      : "Watchtower 연결 불가: " + (status.errorCode || "UNKNOWN"),
      status.status !== "connected");
    await refresh();
  } catch (error) { notify(error.message, true); }
});
$("watchtower-target-form").addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("watchtower-workstream").value;
  if (!id) return notify("먼저 작업축을 등록하십시오.", true);
  await act("/api/v1/workstreams/" + encodeURIComponent(id) + "/watchtower-target", {
    repositoryId: Number($("watchtower-repository").value),
    runId: Number($("watchtower-run").value),
    attempt: Number($("watchtower-attempt").value),
    headSha: $("watchtower-sha").value.trim()
  });
  // A fresh fetch revalidates all currently configured targets.
  try { await request("/api/v1/watchtower/refresh", {}); await refresh(); }
  catch (error) { notify(error.message, true); }
});

$("tick").addEventListener("click", () => act("/api/v1/tick"));
$("global-stop").addEventListener("click", () => act("/api/v1/control", { stopped: !data.globalStopped }));
setInterval(() => void refresh(), 4000);
void refresh();
