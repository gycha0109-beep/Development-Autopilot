const $ = id => document.getElementById(id);
let data = null;
const chromeSelections=new Map();

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
let pendingWorkstreamDelete=null;
function openDeleteDialog(item) {
  const dialog=$("workstream-delete-dialog");
  if(dialog.open)return;
  pendingWorkstreamDelete={id:item.id,name:item.name};
  $("workstream-delete-name").textContent=item.name;
  $("workstream-delete-detail").textContent=
    "'"+item.name+"' 작업축 및 연결된 데이터를 삭제합니다.";
  $("workstream-delete-error").textContent="";
  $("workstream-delete-confirm").disabled=false;
  $("workstream-delete-cancel").disabled=false;
  dialog.showModal();
  $("workstream-delete-cancel").focus();
}
function closeDeleteDialog() {
  const dialog=$("workstream-delete-dialog");
  if(dialog.open)dialog.close();
  pendingWorkstreamDelete=null;
}
async function confirmDeleteDialog() {
  const target=pendingWorkstreamDelete;
  if(!target)return;
  const confirm=$("workstream-delete-confirm");
  const cancel=$("workstream-delete-cancel");
  confirm.disabled=true;cancel.disabled=true;
  try{
    await request("/api/v1/workstreams/"+encodeURIComponent(target.id)+"/delete",
      {confirmName:target.name});
    closeDeleteDialog();
    await refresh();
    notify("'"+target.name+"' 작업축을 삭제했습니다.");
  }catch(error){
    $("workstream-delete-error").textContent=error.message;
    confirm.disabled=false;cancel.disabled=false;
  }
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
function renderChromeCandidates(){
  const holder=$("bridge-candidates"),status=$("bridge-enrollment-status");
  holder.replaceChildren();
  const view=data.chromeEnrollment||{candidates:[],registrations:[]};
  const pending=view.registrations.filter(x=>x.status==="pending");
  const unlinked=data.workstreams.filter(w=>
    !data.chromeBridge.links.some(l=>l.workstreamId===w.id) &&
    !pending.some(x=>x.workstreamId===w.id));
  if(!view.candidates.length){
    holder.append(node("div","empty","연결할 미등록 ChatGPT 탭이 없습니다. 확장 프로그램이 새 버전인지, 대상 탭이 Chrome 그룹 안에 있는지 확인하십시오."));
  }
  for(const candidate of view.candidates){
    const eligible=candidate.sessionKey?data.workstreams.filter(w=>
      !pending.some(x=>x.workstreamId===w.id)&&data.chromeBridge.links.some(l=>
        l.workstreamId===w.id&&l.extensionId===candidate.extensionId&&l.sessionKey===candidate.sessionKey&&["url-changed","needs-rebind"].includes(l.status))):unlinked;
    const row=node("div","event");
    const description=node("div");
    description.append(
      node("b","",candidate.groupLabel+" / "+candidate.title),
      node("span","bridge-small"," · "+candidate.route+" · 확장 "+candidate.extensionId.slice(0,8)+"…")
    );
    const controls=node("div","controls");
    const select=node("select","select");
    select.setAttribute("aria-label",candidate.groupLabel+" 탭을 연결할 작업축");
    for(const w of eligible){
      const option=node("option","",w.name+" ("+w.repository+")");
      option.value=w.id;
      select.append(option);
    }
    const exact=eligible.filter(w=>w.name===candidate.groupLabel);
    if(exact.length===1)select.value=exact[0].id;
    const outstanding=pending.some(x=>x.extensionId===candidate.extensionId&&
      x.tabId===candidate.tabId);
    const reloadingSameChat=candidate.sessionKey&&candidate.epochHash&&candidate.urlHash===candidate.previousUrlHash;
    const confirm=button(outstanding?"등록 요청 대기 중":reloadingSameChat?"이 탭의 기존 대화 확인·재연결":candidate.sessionKey?"이 탭의 생성된 대화 주소 확인·연결":"이 탭 등록·연결","primary",async()=>{
      const workstreamId=select.value;
      if(!workstreamId)return notify("연결할 작업축을 먼저 선택하십시오.",true);
      try{
        await request("/api/v1/workstreams/"+encodeURIComponent(workstreamId)+"/register-chrome",{
          extensionId:candidate.extensionId,tabId:candidate.tabId,urlHash:candidate.urlHash
        });
        notify("확장에서 대상 탭을 검증하고 있습니다. 다음 동기화 후 연결됨으로 전환됩니다.");
        await refresh();
      }catch(error){notify(error.message,true);}
    },!eligible.length||outstanding);
    controls.append(select,confirm);
    row.append(description,controls);
    holder.append(row);
  }
  const recent=view.registrations.slice(0,5).map(x=>{
    const w=data.workstreams.find(w=>w.id===x.workstreamId);
    return (w?.name||x.workstreamId)+" · "+
      (x.status==="pending"?"등록 요청 대기":x.status==="done"?"등록·연결 완료":
        x.status==="expired"?"요청 만료":x.reason||"등록 실패");
  });
  status.textContent=recent.join(" / ");
}
function chromeControls(item, controls) {
  const bridge = data.chromeBridge;
  const link = bridge.links.find(l => l.workstreamId === item.id);
  if (link) {
    chromeSelections.delete(item.id);
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
    chromeSelections.delete(item.id);
    controls.append(node("span", "tag", "연결 가능한 등록 탭 없음"));
    return;
  }
  const select = node("select", "select");
  select.setAttribute("aria-label", item.name + "에 연결할 Chrome 탭");
  const placeholder=node("option","","연결할 탭을 선택하십시오.");placeholder.value="";select.append(placeholder);
  for (const session of choices) {
    const option = node("option", "", session.groupLabel + " / " + session.title + " [" + session.extensionId.slice(0, 8) + "]");
    option.value = session.extensionId + ":" + session.sessionKey;
    select.append(option);
  }
  const saved=chromeSelections.get(item.id);
  if(choices.some(s=>s.extensionId+":"+s.sessionKey===saved))select.value=saved;
  else chromeSelections.delete(item.id);
  const connect=button("탭 연결", "secondary", () => {
    const selected = choices.find(s => s.extensionId + ":" + s.sessionKey === select.value);
    if (selected) void act(
      "/api/v1/workstreams/" + encodeURIComponent(item.id) + "/link-chrome",
      { extensionId: selected.extensionId, sessionKey: selected.sessionKey }
    );
  },!select.value);
  select.addEventListener("change",()=>{
    if(select.value)chromeSelections.set(item.id,select.value);else chromeSelections.delete(item.id);
    connect.disabled=!select.value;
  });
  controls.append(select,connect);
}

function renderWatchtower() {
  const wt = data.watchtower;
  $("watchtower-status").textContent = wt.status === "connected"
    ? "연결됨 · 계약 " + wt.contractVersion : "연결 안 됨";
  $("watchtower-error").textContent = wt.errorCode
    ? "조회 실패: " + wt.errorCode
    : wt.status === "connected"
      ? "Watchtower의 Run 관측을 표시합니다. 재개하려면 작업축별 GitHub 검증과 유효한 전송 승인이 필요합니다."
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

function renderGitHub(){
  const g=data.github;
  $("github-status").textContent=g.status==="observed"
    ? "읽기 전용 검증 활성" : "조회 대기";
  $("github-checked").textContent=relativeDate(g.checkedAt);
  const select=$("github-workstream");
  const previous=select.value;
  select.replaceChildren();
  for(const stream of data.workstreams){
    const option=node("option","",stream.name+" ("+stream.repository+")");
    option.value=stream.id;
    select.append(option);
  }
  if(data.workstreams.some(s=>s.id===previous))select.value=previous;
  const decisions=$("github-decisions");
  decisions.replaceChildren();
  if(!g.targets.length){
    decisions.append(node("div","empty","GitHub PR 검증 대상이 없습니다."));
    return;
  }
  for(const target of g.targets){
    const item=data.workstreams.find(w=>w.id===target.workstreamId);
    const result=g.results.find(x=>x.workstreamId===target.workstreamId);
    const row=node("div","event");
    const info=node("div");
    info.append(
      node("b","",(item?.name||target.workstreamId)+" · "+(result?.state||"UNKNOWN")),
      node("div","bridge-small","PR #"+target.prNumber+
        " · SHA "+target.headSha.slice(0,12)+
        " · "+(result?.reason||"NOT_CHECKED")+
        " · 자동 실행 허용 안 함")
    );
    row.append(info,button("대상 해제","subtle",()=>act(
      "/api/v1/workstreams/"+encodeURIComponent(target.workstreamId)+"/github-target",
      {clear:true}
    )));
    decisions.append(row);
  }
}

function renderDecisionGate(){
  const container=$("decision-gate-results");
  const history=$("decision-gate-history");
  const gate=data.decisionGate || {results:[],history:[]};
  const workstreams=new Map(data.workstreams.map(w=>[w.id,w]));
  const attention=gate.results.filter(g=>!["COMPLETE","REVIEWED"].includes(g.decision)).length;
  $("decision-gate-summary").textContent=gate.results.length+
    "개 작업축 평가 · 확인 필요 "+attention+"건";
  container.replaceChildren();
  history.replaceChildren();
  if(!gate.results.length)
    container.append(node("div","empty","작업축을 등록하면 통합 판단이 표시됩니다."));
  for(const g of gate.results){
    const row=node("div","event");
    const description=node("div");
    const stream=workstreams.get(g.workstreamId);
    description.append(
      node("b","",(stream?.name||g.workstreamId)+" · "+g.decision),
      node("div","bridge-small",g.reason+
        (g.evidenceHash?" · 근거 "+g.evidenceHash.slice(0,12):"")+
        (g.operatorReviewed?" · 검토 만료 "+relativeDate(g.expiresAt):""))
    );
    row.append(description);
    if(g.decision==="WAIT_HUMAN" && g.evidenceHash){
      row.append(button("근거 확인 (모의)", "secondary",()=>{
        if(confirm("검증 근거를 확인한 기록만 남깁니다. 실제 코딩 실행·병합·페이즈 완료는 승인되지 않습니다. 계속하시겠습니까?")){
          void act("/api/v1/workstreams/"+encodeURIComponent(g.workstreamId)+"/decision-review",{});
        }
      }));
    }else{
      row.append(node("span","tag "+classFor(g.decision),"실행 금지"));
    }
    container.append(row);
  }
  if(!gate.history.length)
    history.append(node("div","empty","아직 판단 변경 기록이 없습니다."));
  for(const h of gate.history.slice(0,10)){
    const row=node("div","event");
    row.append(
      node("div","",(workstreams.get(h.workstreamId)?.name||h.workstreamId)+
        " · "+h.decision+" · "+h.reason),
      node("small","",relativeDate(h.at))
    );
    history.append(row);
  }
}

function renderExecutionPlans() {
  const select=$("execution-workstream");
  const selected=select.value;
  select.replaceChildren();
  for(const w of data.workstreams) {
    const item=node("option","",w.name+" · "+w.state+" ("+w.mode+")");
    item.value=w.id;
    select.append(item);
  }
  if(data.workstreams.some(w=>w.id===selected))select.value=selected;
  const root=$("execution-plan-list");
  root.replaceChildren();
  if(!data.executionPlans?.length){
    root.append(node("div","empty","아직 생성된 단일 작업 계획이 없습니다."));
    return;
  }
  for(const plan of data.executionPlans){
    const row=node("div","event");
    const detail=node("div");
    detail.append(
      node("b","",plan.title+" · "+plan.status.toUpperCase()),
      node("div","bridge-small","작업축 "+plan.workstreamId+
        " · Revision "+plan.taskRevision+" · "+plan.adapterId),
      node("div","bridge-small","근거 "+plan.fingerprint.slice(0,12)+
        " · "+(plan.resultReason||"결과 미검증")+
        (plan.approvalExpiresAt?" · 승인 만료 "+relativeDate(plan.approvalExpiresAt):""))
    );
    const actions=node("div","stream-controls");
    const url="/api/v1/execution-plans/"+encodeURIComponent(plan.id);
    if(plan.status==="draft")
      actions.append(button("계획 승인","secondary",()=>act(url+"/approve",{})));
    if(plan.status==="approved")
      actions.append(button("모의 실행","primary",()=>act(url+"/dispatch",{})));
    if(plan.status==="waiting")
      actions.append(button("결과 독립 검증","secondary",()=>act(url+"/inspect",{})));
    if(["waiting","running","unknown"].includes(plan.status))
      actions.append(button("불명 상태로 보류","danger",()=>{
        if(confirm("실행이 완료됐다고 주장하지 않고 불명 상태로 중단합니다. 재전송은 하지 않습니다. 계속하시겠습니까?"))
          void act(url+"/abandon",{});
      }));
    row.append(detail,actions);
    root.append(row);
  }
}

function renderChatContinuation(){
  const chat=data.chatContinuation||{configs:[],commands:[]};
  const selector=$("chat-continuation-workstream");
  const selected=selector.value;
  selector.replaceChildren();
  for(const w of data.workstreams){
    const linked=data.chromeBridge.links.find(l=>l.workstreamId===w.id);
    const option=node("option","",w.name+" · "+(linked?.status||"탭 미연결"));
    option.value=w.id;
    selector.append(option);
  }
  if(data.workstreams.some(w=>w.id===selected))selector.value=selected;
  renderCIResumeCandidate();
  const root=$("chat-continuation-status");
  root.replaceChildren();
  if(!chat.configs.length)root.append(node("div","empty","승인된 ChatGPT 탭이 없습니다."));
  for(const cfg of chat.configs){
    const w=data.workstreams.find(w=>w.id===cfg.workstreamId);
    const row=node("div","event");
    const detail=node("div");
    detail.append(node("b","",(w?.name||cfg.workstreamId)+" · "+cfg.status),
      node("div","bridge-small",
        (cfg.mode==="scheduled"?"자동 주기":"수동 전송")+" · "+cfg.intervalMinutes+"분 · "+
        cfg.sentCount+"/"+cfg.maxMessages+"회 · 승인 만료 "+relativeDate(cfg.expiresAt)),
      node("div","bridge-small","상태: "+cfg.statusReason+" · 다음 가능 "+relativeDate(cfg.nextDueAt)));
    const controls=node("div","stream-controls");
    if(cfg.enabled){
      controls.append(
        button("지금 1회 보내기","secondary",async()=>{
          try{
            const answer=await request("/api/v1/chat-continuation/send-now",
              {workstreamId:cfg.workstreamId});
            notify(answer.command?"등록된 ChatGPT 탭으로 전달할 메시지를 예약했습니다.":"아직 전송 시각이 아니거나 CI·탭 상태를 확인해야 합니다.",
              !answer.command);
            await refresh();
          }catch(error){notify(error.message,true);}
        }),
        button("전송 중단","danger",()=>act("/api/v1/chat-continuation/stop",
          {workstreamId:cfg.workstreamId}))
      );
    }
    row.append(detail,controls);
    root.append(row);
  }
  const recent=chat.commands.slice(0,8);
  for(const cmd of recent){
    const row=node("div","event");
    row.append(node("div","","메시지 "+cmd.id.slice(0,8)+" · "+cmd.state+" · "+cmd.reason),
      node("small","",relativeDate(cmd.finishedAt||cmd.createdAt)));
    root.append(row);
  }
}

function selectedCIResumeCandidate(){
  return data.chatContinuation?.ciResumeCandidates?.find(c=>c.workstreamId===$("chat-continuation-workstream").value);
}
function renderCIResumeCandidate(){
  const candidate=selectedCIResumeCandidate(),check=$("chat-ci-resume");
  if(check.checked&&check.dataset.targetHash!==candidate?.targetHash){
    check.checked=false;delete check.dataset.targetHash;
  }
  check.disabled=!candidate;
  $("chat-ci-resume-target").textContent=candidate?
    candidate.repository+" · Track "+candidate.trackKey+" · PR #"+candidate.prNumber+" · SHA "+candidate.headSha+
      " · Run "+candidate.runId+" · Attempt "+candidate.attempt+" · 성공·필수 체크·병합 확인 후 재개. 병합 권한 없음.":
    "정확한 Track·PR·SHA·Run·Attempt의 최신 관측이 필요합니다. 병합 권한을 부여하지 않습니다.";
}

function renderAutopilot(){
  const runtime=data.autopilot||{scopes:[],inbox:[]},root=$("autopilot-status");
  root.replaceChildren();
  for(const link of data.chromeBridge.links){
    const entry=runtime.scopes.find(s=>s.workstreamId===link.workstreamId),id=link.workstreamId;
    const stream=data.workstreams.find(w=>w.id===id),row=node("div","event"),details=node("div");
    const delivery=entry?.observationDelivery,receipt=delivery?.lastReceipt;
    const observationStatus=delivery?.pending?"Chrome 관찰 응답 대기 중":
      entry?.observation?.reasonCode==="ASSISTANT_RESPONSE_UNAVAILABLE"?"ChatGPT 응답 불러오기 오류":
      entry?.observation?.reasonCode==="CONVERSATION_UNAVAILABLE"?"ChatGPT 대화 불러오기 오류":
      entry?.decision?.reasonCode||entry?.observation?.reasonCode||
      (entry?.enabled?(receipt?.outcome==="TIMEOUT"?"Chrome 관찰 응답 시간 초과":"새 관찰 응답 미수신"):"관찰 미허용");
    details.append(node("b","",stream?.name||id),node("div","bridge-small",
      observationStatus));
    if(delivery?.pending)details.append(node("div","bridge-small","Chrome 관찰 응답 대기 중 · 요청 "+
      relativeDate(delivery.pending.requestedAt)+" · 만료 "+relativeDate(delivery.pending.deadlineAt)));
    if(receipt)details.append(node("div","bridge-small",(receipt.currentBinding?"최근 관찰 전송 결과: ":"이전 연결의 관찰 전송 결과: ")+
      (receipt.outcome==="RECEIVED"?"확장 응답 수신":receipt.outcome==="TIMEOUT"?"확장 응답 시간 초과":"관찰 요청 취소")+
      " · "+relativeDate(receipt.finishedAt)+" · "+receipt.roundTripMs+"ms"));
    if(entry?.observation?.reasonCode==="ASSISTANT_RESPONSE_UNAVAILABLE")
      details.append(node("div","bridge-small","ChatGPT 화면에서 응답 불러오기 오류를 감지했습니다. 자동 전송은 차단됩니다. 정상 답변 복구 후 읽기 관찰을 다시 확인하십시오."));
    if(entry?.observation?.reasonCode==="CONVERSATION_UNAVAILABLE")
      details.append(node("div","bridge-small","ChatGPT 대화와 입력창을 불러오지 못했습니다. 자동 전송은 차단됩니다. 대화가 복구된 뒤 읽기 관찰을 다시 확인하십시오."));
    if(entry?.schedule?.next_external_check_at)
      details.append(node("div","bridge-small","다음 CI 재검사: "+relativeDate(entry.schedule.next_external_check_at)));
    if(entry?.ciWait)details.append(node("div","bridge-small","CI 대기 시작: "+relativeDate(entry.ciWait.startedAt)));
    const controls=node("div","stream-controls");
    controls.append(button("읽기 관찰 허용","secondary",()=>act("/api/v1/autopilot/observe",{workstreamId:id,observationPermitted:true})));
    const cfg=data.chatContinuation.configs.find(c=>c.workstreamId===id);
    if(entry?.observation?.verified&&cfg?.enabled&&cfg.mode==="scheduled"&&!entry?.schedule?.enabled){
      controls.append(button("조건부 자동 진행 승인","primary",()=>{
        if(confirm((stream?.name||id)+"의 남은 작업을 기존 승인 메시지·기간·횟수 범위에서 자동 진행할까요? 읽기 관찰과 메시지 전송을 허용합니다."))
          void act("/api/v1/autopilot/configure",{workstreamId:id,remainingWork:true,observationPermitted:true,executionPermitted:true});
      }));
    }
    if(entry?.enabled)controls.append(button("관찰·자동 진행 중단","danger",()=>act("/api/v1/autopilot/stop",{workstreamId:id})));
    row.append(details,controls);root.append(row);
  }
  const inbox=$("operator-inbox");inbox.replaceChildren();
  for(const item of runtime.inbox){
    const name=data.workstreams.find(w=>w.id===item.workstreamId)?.name||item.workstreamId;
    const action=item.reasonCode==="CONVERSATION_UNAVAILABLE"?
      "ChatGPT 탭의 대화 로딩 오류를 확인하고 대화가 복구된 뒤 다시 관찰·승인하십시오.":
      item.reasonCode==="ASSISTANT_RESPONSE_UNAVAILABLE"?
      "ChatGPT 탭의 응답 로딩 오류를 확인하고 정상 답변을 복구한 뒤 다시 관찰·승인하십시오.":
      item.reasonCode==="CI_QUERY_UNAVAILABLE_TOO_LONG"?
      "Watchtower 실행·GitHub 인증·정확한 Repository/Track/PR/SHA/Run/Attempt 연결을 확인한 뒤 이 작업축을 재검사하십시오.":
      item.reasonCode==="CI_WAIT_TOO_LONG"?
      "정확한 Run의 장기 실행 원인을 GitHub에서 확인하십시오. 완료 근거와 기존 전송 승인을 확인한 뒤 이 작업축만 재개하십시오.":
      item.reasonCategory==="ci"?"해당 작업축의 CI 실패·필수 체크·병합 상태를 확인하고 문제를 해결한 뒤 근거를 다시 검증하십시오.":
      "작업축에서 요청된 조치를 완료한 후 근거와 승인을 다시 확인하십시오.";
    const row=node("div","event",name+" · "+item.reasonCategory+" · "+item.reasonCode+" · "+item.state+" — "+action);
    const controls=node("div","actions");
    const command=(kind,label)=>{
      const control=button(label,"secondary",async()=>{
        control.disabled=true;
        try{
          const result=await request("/api/v1/operator-inbox/command",{...item,command:kind,commandId:crypto.randomUUID()});
          if(kind==="status")notify("요청 상태: "+result.request.state);
          else if(kind==="resume")notify(result.resumed?"이 작업축의 감시를 재개했습니다. 기존 전송 한도가 유지됩니다.":"요청을 해결했습니다. 다른 요청으로 대기를 유지합니다.");
          else if(kind==="reinspect")notify("대기 상태를 유지하며 같은 탭을 다시 관찰합니다.");
          else notify("판단을 기록했습니다. 요청된 작업은 실행되지 않습니다.");
          await refresh();
        }catch(error){notify(error.message);control.disabled=false;}
      });
      return control;
    };
    controls.append(command("status","상태 확인"));
    if(!["closed","consumed","expired"].includes(item.state)){
      controls.append(command("hold","보류"),command("approve","승인 기록"),command("reject","거절"));
      const inspect=command("reinspect","조치 후 재검사");inspect.disabled=item.reviewReason==="OBSERVATION_ALREADY_PENDING";
      const resume=command("resume","감시 재개");resume.disabled=item.reviewReason!==null;
      controls.append(inspect,resume,node("p","muted",item.reviewReason===null?"정상 응답 확인됨. 재개해도 비용·병합 승인은 추가되지 않습니다.":
        item.reviewReason==="OBSERVATION_ALREADY_PENDING"?"탭 관찰 중입니다.":"조치를 완료한 뒤 재검사해 주세요. 정상 응답을 확인해야 감시를 재개할 수 있습니다."));
    }
    row.append(controls);inbox.append(row);
  }
}
function render() {
  renderAutopilot();
  renderChatContinuation();
  renderExecutionPlans();
  renderDecisionGate();
  renderGitHub();
  renderWatchtower();
  renderBridge();
  renderChromeCandidates();
  const items = data.workstreams;
  for(const id of chromeSelections.keys())if(!items.some(item=>item.id===id))chromeSelections.delete(id);
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
    controls.append(button("작업축 삭제", "danger", ()=>openDeleteDialog(item)));
    if (item.active_operation_id && !data.executionPlans?.some(p => p.operationId === item.active_operation_id)) {
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
$("chat-continuation-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const workstreamId=$("chat-continuation-workstream").value;
  const mode=$("chat-continuation-mode").value;
  if(!workstreamId)return notify("등록된 작업축을 선택하십시오.",true);
  const text=$("chat-continuation-message").value.trim();
  if(!text)return notify("후속 메시지를 입력하십시오.",true);
  const intervalMinutes=Number($("chat-continuation-interval").value);
  if(!$("chat-continuation-interval").value.trim()||
     !Number.isSafeInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)
    return notify("전송 주기를 1~1440분 사이의 정수로 직접 입력하십시오.",true);
  const ciCheck=$("chat-ci-resume"),candidate=selectedCIResumeCandidate();
  const ciResumeTargetHash=ciCheck.checked?ciCheck.dataset.targetHash:null;
  if(ciCheck.checked&&(mode!=="scheduled"||!candidate||candidate.targetHash!==ciResumeTargetHash))
    return notify("CI 자동 재개는 주기 자동 전송과 현재의 정확한 CI 대상 승인이 필요합니다.",true);
  if(!confirm(
    "선택한 등록 ChatGPT 탭에 '"+text.slice(0,90)+"' 메시지를 전달할 수 있습니다. "+
    (mode==="scheduled"?"자동 전송 주기는 "+intervalMinutes+"분입니다.":"수동 전송만 진행합니다.")+
    (ciResumeTargetHash?" CI 재개 승인 대상: "+$("chat-ci-resume-target").textContent:"")+
    " 기존 ChatGPT 사용량이 소모될 수 있습니다. 승인하시겠습니까?"
  ))return;
  try{
    await request("/api/v1/chat-continuation/configure",{
      workstreamId,enabled:true,mode,message:text,intervalMinutes,
      hours:Number($("chat-continuation-hours").value),
      maxMessages:Number($("chat-continuation-max").value),ciResumeTargetHash
    });
    notify("등록된 ChatGPT 탭에 메시지 전송을 승인했습니다. 새 대화 생성으로 URL이 변경되면 다음 전송 전 탭 재연결이 필요합니다.");
    await refresh();
  }catch(error){notify(error.message,true);}
});
$("chat-ci-resume").addEventListener("change",()=>{
  const check=$("chat-ci-resume"),candidate=selectedCIResumeCandidate();
  if(check.checked&&candidate)check.dataset.targetHash=candidate.targetHash;
  else {check.checked=false;delete check.dataset.targetHash;}
});
$("chat-continuation-workstream").addEventListener("change",()=>{
  $("chat-ci-resume").checked=false;delete $("chat-ci-resume").dataset.targetHash;renderCIResumeCandidate();
});
$("execution-plan-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const workstreamId=$("execution-workstream").value;
  if(!workstreamId)return notify("먼저 작업축을 등록하십시오.",true);
  try{
    await request("/api/v1/execution-plans",{
      workstreamId,
      title:$("execution-title").value.trim(),
      instruction:$("execution-instruction").value.trim(),
      expectedMarker:$("execution-marker").value.trim()
    });
    notify("모의 실행 계획을 등록했습니다. 정확한 계획을 검토하고 승인하십시오.");
    await refresh();
  }catch(error){notify(error.message,true);}
});
$("decision-gate-refresh").addEventListener("click",async()=>{
  try{
    await request("/api/v1/decision-gate/refresh",{});
    await refresh();
    notify("Watchtower·GitHub 근거 재검증을 시도했습니다. 상태가 UNKNOWN이면 대상·인증·CI 최신성을 확인하십시오.");
  }catch(error){notify(error.message,true);}
});
$("github-refresh").addEventListener("click",async()=>{
  try{
    const result=await request("/api/v1/github/refresh",{});
    notify(result.github.status==="observed"?"GitHub PR 검증을 마쳤습니다.":"GitHub 조회 상태를 확인하십시오.");
    await refresh();
  }catch(error){notify(error.message,true);}
});
$("github-target-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const id=$("github-workstream").value;
  if(!id)return notify("먼저 작업축을 등록하십시오.",true);
  await act("/api/v1/workstreams/"+encodeURIComponent(id)+"/github-target",{
    prNumber:Number($("github-pr").value),
    headSha:$("github-sha").value.trim()
  });
  try{await request("/api/v1/github/refresh",{});await refresh();}
  catch(error){notify(error.message,true);}
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

// The dialog is scoped to a single workstream and cannot delete another card
// when the page refreshes while an operation is pending.
$("workstream-delete-cancel").addEventListener("click",closeDeleteDialog);
$("workstream-delete-confirm").addEventListener("click",()=>void confirmDeleteDialog());
$("workstream-delete-dialog").addEventListener("close",()=>{pendingWorkstreamDelete=null;});
