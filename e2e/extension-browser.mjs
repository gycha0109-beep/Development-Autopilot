import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {DatabaseSync} from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { chromium } from "playwright";
import { classifyObservation } from "../local/chat-observation.js";
import { submitToExistingChatGPT } from "../extension/chat-page.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenarioNames = ["normal", "generating", "ci", "disconnect", "length", "quota", "draft", "approval"];
const expectedStates = {
  normal: "UNKNOWN", generating: "GENERATING", ci: "CI_WAIT_CUE",
  disconnect: "DISCONNECTED", length: "LENGTH_LIMIT", quota: "WAIT_HUMAN",
  draft: "UNKNOWN", approval: "WAIT_HUMAN"
};

function fixtureHtml(pathname,unavailable=false) {
  const slug = pathname.split("/").at(-1);
  if(slug==="e2e-created"&&unavailable==="recovery")return `<!doctype html><html><body><main>
    <div id="turns"><article data-message-author-role="user" data-message-id="recovery-user-initial">Owned recovery case</article>
    <article data-message-author-role="assistant" data-message-id="recovery-initial">초기 테스트 응답입니다.</article></div>
    <form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>
    <button type="button" data-testid="send-button">Send</button></form>
    <script>
      window.__recovery={stops:0,messages:[]};
      window.__disconnect=()=>{
        const alert=document.createElement('div');alert.setAttribute('role','alert');alert.id='disconnect-alert';
        alert.textContent='연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.';document.querySelector('main').append(alert);
        const stop=document.createElement('button');stop.type='button';stop.dataset.testid='stop-button';stop.textContent='Stop';
        document.querySelector('form').append(stop);
        document.querySelector('#turns article:last-child').setAttribute('aria-busy','true');
        stop.addEventListener('click',()=>{window.__recovery.stops++;stop.remove();alert.remove();
          document.querySelector('#turns article:last-child').setAttribute('aria-busy','false');});
      };
      document.querySelector('[data-testid="send-button"]').addEventListener('click',()=>{
        const editor=document.querySelector('#prompt-textarea'),message=editor.innerText.trim();
        const n=window.__recovery.messages.push(message);
        const user=document.createElement('article');user.dataset.messageAuthorRole='user';user.dataset.messageId='recovery-user-'+n;
        user.textContent=message;document.querySelector('#turns').append(user);
        const reply=document.createElement('article');reply.dataset.messageAuthorRole='assistant';reply.dataset.messageId='recovery-reply-'+n;
        reply.textContent=n===1?'지금까지 진행한 작업과 남은 작업을 보고합니다.':'복구 후 진행 응답 완료.';
        document.querySelector('#turns').append(reply);editor.innerHTML='';
      });
    </script></main></body></html>`;
  if(slug==="e2e-created"&&unavailable==="conversation")return `<!doctype html><html><body>
    <aside>PRIVATE_SIDEBAR</aside><main><header aria-hidden="true"><button>PRIVATE_HIDDEN_HEADER</button></header>
    <div><div>이 ChatGPT 대화를 불러올 수 없습니다</div></div><button type="button">다시 시도</button>
    </main></body></html>`;
  if(slug==="e2e-created")return `<!doctype html><html><head><title>E2E current renderer</title></head><body><main>
    <div data-content-search-turn-key="turn-current"><div data-talvt-turn-state="complete">
      <div data-chatgpt-search-unit-key="turn-current:0:user" data-chatgpt-search-message-ids="${unavailable==='loading-failure'?'loading-failure-user':'user-current'}">Owned fixture request</div>
      <div data-chatgpt-search-unit-key="turn-current:2:assistant" data-chatgpt-search-message-ids="reply-current reply-current">
        <div data-chatgpt-selection-message-id="reply-current"><div data-markdown-text-style="assistant-message">
          <div data-dil-source-message-id="reply-current"><div data-dil-message-id="reply-current"><p>${unavailable==="human"?"로컬 Windows 테스트가 필요합니다.":unavailable&&unavailable!=='loading-normal'?'<span role="status">이 응답을 불러오지 못했습니다</span>':"PRIVATE_CURRENT_FIXTURE_RESPONSE"}</p></div></div>
        </div></div>
      </div>
    </div></div>
    <form data-chatgpt-composer data-composer-placement="thread"><div contenteditable="true" role="textbox" aria-label="ChatGPT에게 물어보세요"><p><br></p></div><button type="button" aria-label="음성 대화 시작">Voice</button></form>
  </main></body></html>`;
  const scenario = slug.startsWith("e2e-") ? slug.slice(4) : "normal";
  const label = slug === "e2e-send" ? "sender" : scenario;
  const alert = scenario === "disconnect"
    ? "<div role=\"alert\">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div>"
    : scenario === "length"
      ? "<div role=\"alert\">이 대화의 최대 길이에 도달했습니다</div>"
      : scenario === "quota"
        ? "<div role=\"alert\">Usage limit reached</div>" : "";
  const assistant = scenario === "ci" ? "CI가 장기 실행중이므로 대기중입니다."
    : scenario === "approval" ? "로컬 Windows 테스트가 필요합니다."
      : `안전한 E2E 응답 ${label}`;
  const draft = scenario === "draft" ? "PRIVATE_E2E_DRAFT" : "";
  const stop = scenario === "generating" ? "<button data-testid=\"stop-button\">Stop</button>" : "";
  const sender = slug === "e2e-send" ? `
    <script>
      window.__sendCount = 0;
      document.querySelector("#send").addEventListener("click", event => {
        event.preventDefault(); window.__sendCount++;
        const stop = document.createElement("button"); stop.dataset.testid = "stop-button";
        stop.textContent = "Stop"; document.querySelector("form").append(stop);
        document.querySelector("[data-message-author-role=assistant]").setAttribute("aria-busy", "true");
      });
    </script>` : "";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>E2E ${label}</title></head>
    <body><main><article data-message-author-role="assistant" data-message-id="reply-${label}">${assistant}</article>
    <form><div id="prompt-textarea" contenteditable="true" role="textbox" data-placeholder="메시지">${draft}</div>
    <button id="send" data-testid="send-button" type="button">Send</button>${stop}</form>${alert}</main>${sender}</body></html>`;
}

async function choosePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(description, predicate, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) { last = error; }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${description}${last instanceof Error ? `: ${last.message}` : ""}`);
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "development-autopilot-playwright-"));
  const port = await choosePort();
  const base = `http://127.0.0.1:${port}`;
  const extensionDir = path.join(tempRoot, "extension");
  const profileDir = path.join(tempRoot, "chromium-profile");
  const tracePath=path.join(root,".autopilot","e2e-artifacts","extension-browser-trace.zip");
  cpSync(path.join(root, "extension"), extensionDir, { recursive: true });
  const bridgeCorePath = path.join(extensionDir, "bridge-core.js");
  const bridgeCore = readFileSync(bridgeCorePath, "utf8");
  assert.ok(bridgeCore.includes("http://127.0.0.1:48173"), "test copy must contain the production localhost default");
  writeFileSync(bridgeCorePath, bridgeCore.replace("http://127.0.0.1:48173", base));

  const server = spawn(process.execPath, ["local/server.js"], {
    cwd: root,
    env: { ...process.env, AUTOPILOT_PORT: String(port), AUTOPILOT_DB: path.join(tempRoot, "acceptance.sqlite3") },
    stdio: "ignore"
  });
  let context,currentRendererUnavailable=false;
  try {
    await waitFor("isolated local server", async () => {
      const response = await fetch(`${base}/api/v1/snapshot`).catch(() => null);
      return response?.ok;
    });

    const installedBrowser = process.env.PLAYWRIGHT_CHROME_EXECUTABLE || [
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Microsoft/Edge/Application/msedge.exe"),
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")
    ].find(existsSync);
    context = await chromium.launchPersistentContext(profileDir, {
      ...(installedBrowser ? { executablePath: installedBrowser } : { channel: "chromium" }),
      // MV3 extension service workers require a headed Chromium context.
      headless: false,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    });
    await context.tracing.start({screenshots:true,snapshots:true,sources:true});
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;
    assert.match(extensionId, /^[a-p]{32}$/);

    let loadingArmed=false,loadingReloads=0,loadingWillRecover=true;
    await context.route("https://chatgpt.com/**", route => {
      const url = new URL(route.request().url());
      if(loadingArmed&&url.pathname==='/c/e2e-created'&&route.request().isNavigationRequest()){
        loadingReloads++;currentRendererUnavailable=loadingWillRecover?'loading-normal':'loading-failure';
      }
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixtureHtml(url.pathname,currentRendererUnavailable) });
    });

    const casePages = [];
    for (let i = 0; i < 20; i++) {
      const page = await context.newPage();
      const slug = i < scenarioNames.length ? `e2e-${scenarioNames[i]}` : `e2e-spare-${String(i).padStart(2, "0")}`;
      await page.goto(`https://chatgpt.com/c/${slug}`, { waitUntil: "domcontentloaded" });
      casePages.push(page);
    }
    const unregistered = await context.newPage();
    await unregistered.goto("https://chatgpt.com/c/e2e-unregistered", { waitUntil: "domcontentloaded" });
    const senderPage = await context.newPage();
    await senderPage.goto("https://chatgpt.com/c/e2e-send", { waitUntil: "domcontentloaded" });

    const targetUrls = casePages.map(page => page.url());
    const groupId = await worker.evaluate(async urls => {
      const ids = [];
      for (const url of urls) {
        const matches = await chrome.tabs.query({ url });
        if (matches.length !== 1) throw new Error("E2E fixture tab did not resolve uniquely");
        ids.push(matches[0].id);
      }
      const id = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(id, { title: "codex_test", color: "blue" });
      return id;
    }, targetUrls);
    assert.ok(Number.isInteger(groupId));

    const dashboard = await context.newPage();
    await dashboard.goto(base, { waitUntil: "domcontentloaded" });
    await dashboard.locator("#create-form").waitFor();
    for (const name of scenarioNames.map(value => `e2e-${value}`)) {
      await dashboard.locator('#create-form input[name="name"]').fill(name);
      await dashboard.locator('#create-form input[name="projectKey"]').fill(name);
      await dashboard.locator('#create-form input[name="repository"]').fill("test-owner/test-repo");
      await dashboard.locator('#create-form input[name="intervalMinutes"]').fill("35");
      await dashboard.locator('#create-form button[type="submit"]').click();
      await dashboard.waitForFunction(expected => document.querySelector("#workstreams")?.innerText.includes(expected), name);
    }

    await dashboard.getByRole("button", { name: "연결 코드 발급" }).click();
    const code = await waitFor("pairing code", async () => {
      const text = await dashboard.locator("#pair-code-value").textContent();
      return /^[a-f0-9]{20}$/i.test(text?.trim() || "") ? text.trim() : null;
    });

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
    await options.locator("#extension-runtime").waitFor();
    await waitFor("extension runtime version handshake", async () =>
      (await options.locator("#extension-runtime").textContent())?.includes("최신 확인"));
    const groupCard = options.locator("#groups article").filter({ hasText: "codex_test" });
    await groupCard.getByRole("button", { name: "그룹 등록" }).click();
    await groupCard.getByText("그룹 등록됨", { exact: true }).waitFor();
    assert.equal(await groupCard.locator(".tab-row").count(), 20);
    await groupCard.locator(".tab-row").nth(0).getByRole("button", { name: "탭 등록" }).click();
    await groupCard.locator(".tab-row").nth(0).getByText("등록됨", { exact: true }).waitFor();

    await options.locator("#bridge-code").fill(code);
    await options.getByRole("button", { name: "로컬 연결" }).click();
    await options.locator("#notice").getByText("로컬 프로그램에 연결되었습니다.").waitFor();
    await waitFor("first paired tab", async () => {
      const res = await fetch(`${base}/api/v1/snapshot`);
      const state = await res.json();
      return state.chromeBridge.sessions.length === 1 ? state : null;
    });

    const limits = [3, 10, 20];
    let registered = 1;
    for (const count of limits) {
      while (registered < count) {
        const row = groupCard.locator(".tab-row").nth(registered);
        await row.getByRole("button", { name: "탭 등록" }).click();
        await row.getByText("등록됨", { exact: true }).waitFor();
        registered++;
      }
      await options.getByRole("button", { name: "지금 동기화" }).click();
      await waitFor(`${count} registered tabs synced`, async () => {
        const res = await fetch(`${base}/api/v1/snapshot`);
        const state = await res.json();
        return state.chromeBridge.sessions.length === count ? state : null;
      });
    }

    let state = await (await fetch(`${base}/api/v1/snapshot`)).json();
    assert.equal(state.chromeBridge.sessions.length, 20);
    assert.ok(state.chromeBridge.sessions.every(session => session.status === "connected" && session.origin === "https://chatgpt.com"));
    assert.ok(!JSON.stringify(state.chromeBridge).includes("e2e-unregistered"));
    await dashboard.reload({ waitUntil: "domcontentloaded" });
    await dashboard.locator("#workstreams .stream").first().waitFor();

    for (const scenario of scenarioNames) {
      const name = `e2e-${scenario}`;
      const card = dashboard.locator(".stream").filter({ hasText: name });
      state = await (await fetch(`${base}/api/v1/snapshot`)).json();
      const stream = state.workstreams.find(item => item.name === name);
      const session = state.chromeBridge.sessions.find(item => item.title === `E2E ${scenario}`);
      assert.ok(stream && session, `fixture must exist for ${name}`);
      const sessionValue = `${extensionId}:${session.sessionKey}`;
      const sessionOption = card.locator(`select[aria-label] option[value="${sessionValue}"]`);
      await sessionOption.waitFor({ state: "attached" });
      const sessionSelect = card.locator("select[aria-label]");
      assert.equal(await card.getByRole("button",{name:"탭 연결",exact:true}).isEnabled(),false,"no implicit first-tab selection");
      await sessionSelect.selectOption({ value: sessionValue });
      // Force the asynchronous re-render that raced with selection on Windows
      // CI. The actual UI must retain the choice; keep the periodic timer on.
      const selectedElement=await sessionSelect.elementHandle();
      await dashboard.locator("#tick").click();
      await dashboard.waitForFunction(el=>!el.isConnected,selectedElement);
      await selectedElement.dispose();
      assert.equal(await sessionSelect.inputValue(), sessionValue, `${name} selected its exact tab`);
      // Fire the real button listener synchronously with the selected value;
      // Playwright's separate click action can cross a dashboard re-render.
      await sessionSelect.evaluate(select => {
        const connect = [...select.closest(".stream").querySelectorAll("button")]
          .find(candidate => candidate.textContent.trim() === "탭 연결");
        if (!connect) throw new Error("The selected workstream has no tab-link button");
        connect.click();
      });
      try { await waitFor(`${name} tab link`, async () => {
        const current = await (await fetch(`${base}/api/v1/snapshot`)).json();
        return current.chromeBridge.links.some(link => link.workstreamId === stream.id && link.sessionKey === session.sessionKey);
      }); } catch (error) {
        const current = await (await fetch(`${base}/api/v1/snapshot`)).json();
        throw new Error(`${error.message}; expected=${JSON.stringify({ name, workstreamId: stream.id, sessionKey: session.sessionKey, title: session.title })}; links=${JSON.stringify(current.chromeBridge.links)}; notice=${await dashboard.locator("#notice").innerText()}`);
      }
      const observerRow = dashboard.locator("#autopilot-status .event").filter({ hasText: name });
      // Unchanged controls must stay mounted through a real refresh so Windows
      // actionability checks can complete without weakening click assertions.
      const observeElement=await observerRow.getByRole("button",{name:"읽기 관찰 허용"}).elementHandle();
      const streamElement=await card.elementHandle();
      await dashboard.locator("#tick").click();
      await dashboard.waitForFunction(el=>!el.isConnected,streamElement);await streamElement.dispose();
      assert.equal(await observeElement.evaluate(el=>el.isConnected),true,"unchanged observation control retained");
      await observeElement.dispose();
      await observerRow.getByRole("button", { name: "읽기 관찰 허용" }).click();
    }

    await options.getByRole("button", { name: "지금 동기화" }).click();
    await options.locator("#notice").getByText("등록된 탭 상태가 동기화되었습니다.").waitFor();
    state = await waitFor("eight browser observations", async () => {
      const current = await (await fetch(`${base}/api/v1/snapshot`)).json();
      return current.autopilot.scopes.filter(scope => scope.observation?.verified).length === scenarioNames.length ? current : null;
    });

    const firstObserved = new Map(state.autopilot.scopes.map(scope => [
      state.workstreams.find(item => item.id === scope.workstreamId)?.name,
      scope.observation
    ]));
    const observed = firstObserved;
    const classification = {};
    for (const scenario of scenarioNames) {
      const sample = observed.get(`e2e-${scenario}`);
      assert.ok(sample?.verified, `verified extension observation expected for ${scenario}`);
      const result = classifyObservation(sample, { now: sample.observedAt, stableForMs: 30_000, maxAgeMs: 180_000 });
      classification[scenario] = result.state;
      assert.equal(result.state, expectedStates[scenario], `${scenario} classification: ${JSON.stringify(sample)}`);
    }
    assert.equal(observed.get("e2e-draft").composerHasDraft, true);
    assert.equal(observed.get("e2e-normal").assistantBusy, false);
    assert.equal(observed.get("e2e-ci").ciWaitCue, true);
    assert.equal(observed.get("e2e-disconnect").connectionWarning, true);
    assert.equal(observed.get("e2e-length").lengthWarning, true);
    assert.equal(observed.get("e2e-quota").providerRestriction, true);
    assert.doesNotMatch(JSON.stringify(state.autopilot), /PRIVATE_E2E_DRAFT|안전한 E2E 응답/);

    await senderPage.addScriptTag({ content: `window.__autopilotSubmit = ${submitToExistingChatGPT.toString()};` });
    const firstSend = await senderPage.evaluate(async ({ message, expectedPath }) =>
      window.__autopilotSubmit(message, "continuation", expectedPath),
    { message: "E2E_CONTINUE_ON_MOCK_PAGE", expectedPath: "/c/e2e-send" });
    const secondSend = await senderPage.evaluate(async ({ message, expectedPath }) =>
      window.__autopilotSubmit(message, "continuation", expectedPath),
    { message: "E2E_CONTINUE_ON_MOCK_PAGE", expectedPath: "/c/e2e-send" });
    assert.equal(firstSend.clicked, true);
    assert.equal(secondSend.clicked, false);
    assert.equal(secondSend.reason, "CHATGPT_STILL_GENERATING");
    assert.equal(await senderPage.evaluate(() => window.__sendCount), 1);

    // Exercise browser registration through localhost, not extension options.
    const remote=await context.newPage();
    await remote.goto("https://chatgpt.com/",{waitUntil:"domcontentloaded"});
    const remoteGroup=await worker.evaluate(async()=>{
      const tabs=await chrome.tabs.query({url:"https://chatgpt.com/"});
      if(tabs.length!==1)throw Error("Dashboard candidate not unique");
      const group=await chrome.tabs.group({tabIds:[tabs[0].id]});
      await chrome.tabGroups.update(group,{title:"codex_dashboard",color:"green"});
      return group;
    });
    assert.ok(Number.isInteger(remoteGroup));
    await dashboard.locator('#create-form input[name="name"]').fill("codex_dashboard");
    await dashboard.locator('#create-form input[name="projectKey"]').fill("codex_dashboard");
    await dashboard.locator('#create-form input[name="repository"]').fill("test-owner/test-repo");
    await dashboard.locator('#create-form input[name="intervalMinutes"]').fill("35");
    await dashboard.locator('#create-form button[type="submit"]').click();
    await options.getByRole("button",{name:"지금 동기화"}).click();
    await waitFor("localhost candidate inventory",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.chromeEnrollment?.candidates.some(c=>c.groupLabel==="codex_dashboard");
    });
    await dashboard.reload({waitUntil:"domcontentloaded"});
    const row=dashboard.locator("#bridge-candidates .event").filter({hasText:"codex_dashboard"});
    await row.waitFor();
    const stream=(await (await fetch(base+"/api/v1/snapshot")).json())
      .workstreams.find(w=>w.name==="codex_dashboard");
    assert.ok(stream);
    await row.locator("select").selectOption(stream.id);
    await row.getByRole("button",{name:"이 탭 등록·연결"}).click();
    await waitFor("registration request",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.chromeEnrollment.registrations.some(x=>x.workstreamId===stream.id&&x.status==="pending");
    });
    await options.getByRole("button",{name:"지금 동기화"}).click();
    await waitFor("localhost tab registered and linked",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.chromeEnrollment.registrations.some(x=>x.workstreamId===stream.id&&x.status==="done") &&
        d.chromeBridge.links.some(x=>x.workstreamId===stream.id&&x.status==="connected");
    });
    assert.equal(await remote.evaluate(()=>location.pathname),"/");

    const originalLink=(await (await fetch(base+"/api/v1/snapshot")).json())
      .chromeBridge.links.find(l=>l.workstreamId===stream.id);
    const approval=await fetch(base+"/api/v1/chat-continuation/configure",{
      method:"POST",headers:{Origin:base,"Content-Type":"application/json"},
      body:JSON.stringify({workstreamId:stream.id,enabled:true,mode:"manual",
        message:"E2E_APPROVAL_MUST_NOT_SURVIVE_REBIND",intervalMinutes:1,hours:1,maxMessages:1})
    });
    assert.equal(approval.status,200);
    // Chrome extension Reload clears storage.session. Reproduce that boundary
    // in this disposable profile, preserving registry and pairing credentials.
    await worker.evaluate(async()=>{await chrome.storage.session.clear();});
    await remote.goto("https://chatgpt.com/c/e2e-created",{waitUntil:"domcontentloaded"});
    await options.getByRole("button",{name:"지금 동기화"}).click();
    await waitFor("created chat offered without silently inheriting registration",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.chromeBridge.links.some(l=>l.workstreamId===stream.id&&l.status==="needs-rebind")&&
        d.chromeEnrollment.candidates.some(c=>c.sessionKey===originalLink.sessionKey);
    });
    await dashboard.reload({waitUntil:"domcontentloaded"});
    await dashboard.getByRole("button",{name:"이 탭의 생성된 대화 주소 확인·연결"}).click();
    await waitFor("created chat rebind intent",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.chromeEnrollment.registrations.some(x=>x.workstreamId===stream.id&&x.status==="pending");
    });
    await options.getByRole("button",{name:"지금 동기화"}).click();
    const rebound=await waitFor("same registered session rebound and approval stopped",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.chromeBridge.links.some(l=>l.workstreamId===stream.id&&l.status==="connected"&&l.sessionKey===originalLink.sessionKey)&&
        d.chromeEnrollment.registrations.filter(x=>x.workstreamId===stream.id&&x.status==="done").length===2?d:null;
    });
    assert.equal(rebound.chromeBridge.sessions.length,21);
    assert.equal(rebound.chromeBridge.sessions.filter(s=>s.status==="needs-rebind").length,20);
    assert.equal(rebound.chatContinuation.configs.find(c=>c.workstreamId===stream.id).enabled,false);
    assert.equal(rebound.chatContinuation.commands.length,0);

    // A later Reload after the created URL was already confirmed used to
    // strand this same physical tab with zero candidates. No navigation here.
    assert.equal((await fetch(base+"/api/v1/chat-continuation/configure",{
      method:"POST",headers:{Origin:base,"Content-Type":"application/json"},
      body:JSON.stringify({workstreamId:stream.id,enabled:true,mode:"manual",
        message:"E2E_RELOAD_MUST_REVOKE_APPROVAL",intervalMinutes:1,hours:1,maxMessages:1})
    })).status,200);
    await worker.evaluate(async()=>{await chrome.storage.session.clear();});
    await options.getByRole("button",{name:"지금 동기화"}).click();
    await waitFor("confirmed created chat offered after another Reload",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.chromeBridge.links.some(l=>l.workstreamId===stream.id&&l.status==="needs-rebind")&&
        d.chromeEnrollment.candidates.some(c=>c.sessionKey===originalLink.sessionKey&&c.urlHash===c.previousUrlHash&&c.epochHash);
    });
    await dashboard.reload({waitUntil:"domcontentloaded"});
    await dashboard.getByRole("button",{name:"이 탭의 기존 대화 확인·재연결"}).click();
    await waitFor("same-chat epoch recovery intent",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.chromeEnrollment.registrations.some(x=>x.workstreamId===stream.id&&x.status==="pending");
    });
    await options.getByRole("button",{name:"지금 동기화"}).click();
    const recovered=await waitFor("same chat recovered without inheriting send authority",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.chromeBridge.links.some(l=>l.workstreamId===stream.id&&l.status==="connected"&&l.sessionKey===originalLink.sessionKey)&&
        d.chromeEnrollment.registrations.filter(x=>x.workstreamId===stream.id&&x.status==="done").length===3?d:null;
    });
    assert.equal(recovered.chromeBridge.sessions.length,21);
    assert.equal(recovered.chromeBridge.sessions.filter(s=>s.status==="needs-rebind").length,20);
    assert.equal(recovered.chatContinuation.configs.find(c=>c.workstreamId===stream.id).enabled,false);
    assert.equal(recovered.chatContinuation.commands.length,0);
    assert.equal(await remote.evaluate(()=>location.pathname),"/c/e2e-created");
    const preview=await fetch(base+"/api/v1/autopilot/observe",{
      method:"POST",headers:{Origin:base,"Content-Type":"application/json"},
      body:JSON.stringify({workstreamId:stream.id,observationPermitted:true})
    });
    assert.equal(preview.status,200);
    await options.getByRole("button",{name:"지금 동기화"}).click();
    const currentSample=await waitFor("current renderer observation through the real extension worker",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      const sample=d.autopilot.scopes.find(s=>s.workstreamId===stream.id)?.observation;
      return sample?.verified?sample:null;
    });
    assert.equal(currentSample.contentComplete,true);
    assert.equal(currentSample.assistantBusy,false);
    assert.equal(currentSample.composerHasDraft,false);
    assert.equal(currentSample.uiAmbiguous,false);
    assert.doesNotMatch(JSON.stringify(currentSample),/PRIVATE_|reply-current/);

    // Distinguish a delivered page error from a worker/bridge timeout, without
    // changing enrollment or granting execution on this disposable profile.
    currentRendererUnavailable=true;
    await remote.reload({waitUntil:"domcontentloaded"});
    assert.equal((await fetch(base+"/api/v1/autopilot/observe",{
      method:"POST",headers:{Origin:base,"Content-Type":"application/json"},
      body:JSON.stringify({workstreamId:stream.id,observationPermitted:true})
    })).status,200);
    await options.getByRole("button",{name:"지금 동기화"}).click();
    const unavailableState=await waitFor("delivered unavailable-response diagnostic",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      const scope=d.autopilot.scopes.find(s=>s.workstreamId===stream.id);
      return scope?.observation?.reasonCode==="ASSISTANT_RESPONSE_UNAVAILABLE"?scope:null;
    });
    assert.equal(unavailableState.observation.verified,false);
    assert.equal(unavailableState.observationDelivery.pending,null);
    assert.equal(unavailableState.observationDelivery.lastReceipt.outcome,"RECEIVED");
    assert.equal(unavailableState.observationDelivery.lastReceipt.currentBinding,true);
    assert.equal(unavailableState.schedule,null);
    await dashboard.reload({waitUntil:"domcontentloaded"});
    const diagnosticRow=dashboard.locator("#autopilot-status .event").filter({hasText:"codex_dashboard"});
    await diagnosticRow.getByText("ChatGPT 응답 불러오기 오류",{exact:true}).waitFor();
    assert.match(await diagnosticRow.innerText(),/확장 응답 수신/);
    assert.match(await diagnosticRow.innerText(),/자동 전송은 차단/);
    assert.doesNotMatch(JSON.stringify(unavailableState),/PRIVATE_CURRENT_FIXTURE_RESPONSE/);
    assert.equal((await (await fetch(base+"/api/v1/snapshot")).json()).chatContinuation.commands.length,0);

    currentRendererUnavailable="conversation";
    await remote.reload({waitUntil:"domcontentloaded"});
    assert.equal((await fetch(base+"/api/v1/autopilot/observe",{
      method:"POST",headers:{Origin:base,"Content-Type":"application/json"},
      body:JSON.stringify({workstreamId:stream.id,observationPermitted:true})
    })).status,200);
    await options.getByRole("button",{name:"지금 동기화"}).click();
    const conversationFailure=await waitFor("delivered conversation-load error without a composer",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      const scope=d.autopilot.scopes.find(s=>s.workstreamId===stream.id);
      return scope?.observation?.reasonCode==="CONVERSATION_UNAVAILABLE"?scope:null;
    });
    assert.equal(conversationFailure.observation.verified,false);
    assert.equal(conversationFailure.observationDelivery.lastReceipt.outcome,"RECEIVED");
    assert.equal(conversationFailure.observationDelivery.lastReceipt.currentBinding,true);
    assert.equal(conversationFailure.schedule,null);
    assert.doesNotMatch(JSON.stringify(conversationFailure),/PRIVATE_|불러올/);
    await dashboard.reload({waitUntil:"domcontentloaded"});
    await diagnosticRow.getByText("ChatGPT 대화 불러오기 오류",{exact:true}).waitFor();
    assert.match(await diagnosticRow.innerText(),/자동 전송은 차단/);
    assert.equal((await (await fetch(base+"/api/v1/snapshot")).json()).chatContinuation.commands.length,0);

    // Local Inbox is a production HTTP/UI path. This remains an owned fixture,
    // with remainingWork=false so reviewing it can never authorize a send.
    const post=async(route,body)=>{
      const response=await fetch(base+route,{method:"POST",headers:{Origin:base,"Content-Type":"application/json"},body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.clone().text());return response.json();
    };
    currentRendererUnavailable=false;await remote.reload({waitUntil:"domcontentloaded"});
    await post("/api/v1/autopilot/observe",{workstreamId:stream.id,observationPermitted:true});
    await options.getByRole("button",{name:"지금 동기화"}).click();
    await waitFor("healthy preview before Inbox enrollment",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();return d.autopilot.scopes.find(s=>s.workstreamId===stream.id)?.observation?.verified;
    });
    await post("/api/v1/chat-continuation/configure",{workstreamId:stream.id,enabled:true,mode:"scheduled",message:"계속 진행",intervalMinutes:1,hours:1,maxMessages:1});
    await post("/api/v1/autopilot/configure",{workstreamId:stream.id,remainingWork:false,observationPermitted:true,executionPermitted:true});
    currentRendererUnavailable="human";await remote.reload({waitUntil:"domcontentloaded"});
    await waitFor("runtime inspection challenge",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();return d.autopilot.scopes.find(s=>s.workstreamId===stream.id)?.observationDelivery.pending;
    });
    await options.getByRole("button",{name:"지금 동기화"}).click();
    await waitFor("human cue opens Inbox and pauses only its axis",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();return d.autopilot.inbox.some(i=>i.workstreamId===stream.id)&&d.workstreams.find(w=>w.id===stream.id).paused;
    });
    await dashboard.reload({waitUntil:"domcontentloaded"});
    const inboxRow=dashboard.locator("#operator-inbox .event").filter({hasText:"codex_dashboard"});
    assert.equal(await inboxRow.getByRole("button",{name:"감시 재개",exact:true}).isEnabled(),false);
    await inboxRow.getByRole("button",{name:"승인 기록",exact:true}).click();
    await inboxRow.getByText(/approved/).waitFor();
    assert.equal(await inboxRow.getByRole("button",{name:"감시 재개",exact:true}).isEnabled(),false);
    currentRendererUnavailable=false;await remote.reload({waitUntil:"domcontentloaded"});
    await inboxRow.getByRole("button",{name:"조치 후 재검사",exact:true}).click();
    await options.getByRole("button",{name:"지금 동기화"}).click();
    await waitFor("paused same-tab review is ready",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();return d.autopilot.inbox.find(i=>i.workstreamId===stream.id)?.reviewReason===null;
    });
    await dashboard.reload({waitUntil:"domcontentloaded"});
    await inboxRow.getByRole("button",{name:"감시 재개",exact:true}).click();
    await waitFor("local Inbox resume closes request without sends or extra approval",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();
      return d.autopilot.inbox.find(i=>i.workstreamId===stream.id)?.state==="closed"&&
        !d.workstreams.find(w=>w.id===stream.id).paused&&d.chatContinuation.commands.length===0&&
        d.chatContinuation.configs.find(c=>c.workstreamId===stream.id).maxMessages===1;
    });
    await inboxRow.getByRole("button",{name:"상태 확인",exact:true}).click();
    await waitFor("retained status control becomes usable again",()=>inboxRow.getByRole("button",{name:"상태 확인",exact:true}).isEnabled());

    // Positive recovery uses only an owned HTML fixture in this disposable
    // profile. Advance the inspection due time in its disposable SQLite; never
    // alter freshness, 30s stability/debounce, authority, or dispatch clocks.
    await post("/api/v1/autopilot/stop",{workstreamId:stream.id});
    currentRendererUnavailable="recovery";await remote.reload({waitUntil:"domcontentloaded"});
    await post("/api/v1/autopilot/observe",{workstreamId:stream.id,observationPermitted:true});
    await options.getByRole("button",{name:"지금 동기화"}).click();
    await waitFor("recovery normal preview",async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();return d.autopilot.scopes.find(s=>s.workstreamId===stream.id)?.observation?.verified;
    });
    await post("/api/v1/chat-continuation/configure",{workstreamId:stream.id,enabled:true,mode:"scheduled",message:"계속 진행",intervalMinutes:1,hours:1,maxMessages:1});
    await post("/api/v1/autopilot/configure",{workstreamId:stream.id,remainingWork:true,observationPermitted:true,executionPermitted:true});
    await post("/api/v1/autopilot/recovery/configure",{workstreamId:stream.id,recoveryPermitted:true});
    const forceInspectionDue=()=>{
      const ownedDb=path.resolve(tempRoot,"acceptance.sqlite3");
      if(!ownedDb.startsWith(path.resolve(tempRoot)+path.sep))throw Error("Recovery fixture database escaped its disposable directory");
      const db=new DatabaseSync(ownedDb);try{db.exec("PRAGMA busy_timeout=5000");
        db.prepare("UPDATE autopilot_schedules SET next_inspect_at=0 WHERE workstream_id=?").run(stream.id);
      }finally{db.close();}
    };
    const recoveryState=async()=>{
      const d=await (await fetch(base+"/api/v1/snapshot")).json();return d.autopilot.scopes.find(s=>s.workstreamId===stream.id)?.recovery;
    };
    const recoveryStep=async()=>{
      const previous=await (await fetch(base+"/api/v1/snapshot")).json();
      const priorReceipt=previous.autopilot.scopes.find(s=>s.workstreamId===stream.id)?.observationDelivery.lastReceipt?.requestId;
      forceInspectionDue();
      const ticking=post("/api/v1/tick",{});
      await waitFor("new recovery inspection requested or already delivered by worker alarm",async()=>{
        const d=await (await fetch(base+"/api/v1/snapshot")).json(),delivery=d.autopilot.scopes.find(s=>s.workstreamId===stream.id)?.observationDelivery;
        return delivery.pending||delivery.lastReceipt?.requestId!==priorReceipt;
      });
      await options.getByRole("button",{name:"지금 동기화"}).click();await ticking;
      await waitFor("axis inspection settled without blocking the HTTP scheduler",async()=>{
        const d=await (await fetch(base+"/api/v1/snapshot")).json();
        const scope=d.autopilot.scopes.find(s=>s.workstreamId===stream.id);
        return scope?.schedule?.next_inspect_at>Date.now()&&!scope.observationDelivery.pending&&
          scope.observationDelivery.lastReceipt?.requestId!==priorReceipt;
      });
      return (await recoveryState()).episode;
    };
    await remote.evaluate(()=>window.__disconnect());
    await recoveryStep();assert.equal(await remote.evaluate(()=>window.__recovery.stops),0);
    await delay(31_000); // Real default debounce interval, not a synthetic clock.
    assert.equal((await recoveryStep()).stage,"STOP_RESULT_PENDING");
    assert.equal(await remote.evaluate(()=>window.__recovery.stops),1);
    assert.equal((await recoveryStep()).stage,"STOP_RESULT_VERIFIED");
    assert.equal((await recoveryStep()).stage,"REPORT_RESULT_PENDING");
    assert.deepEqual(await remote.evaluate(()=>window.__recovery.messages),["현재까지 진행한 작업과 남은 작업을 보고해줘."]);
    await recoveryStep();await delay(31_000);
    assert.equal((await recoveryStep()).stage,"REPORT_RESPONSE_VERIFIED");
    await delay(31_000); // The final normal gate still needs two sufficiently spaced samples.
    assert.equal((await recoveryStep()).stage,"DONE");
    await options.getByRole("button",{name:"지금 동기화"}).click();
    await waitFor("one bounded continuation after verified report",async()=>
      JSON.stringify(await remote.evaluate(()=>window.__recovery.messages))===JSON.stringify(["현재까지 진행한 작업과 남은 작업을 보고해줘.","계속 진행"]));
    await recoveryStep();await options.getByRole("button",{name:"지금 동기화"}).click();
    assert.equal(await remote.evaluate(()=>window.__recovery.stops),1);
    assert.deepEqual(await remote.evaluate(()=>window.__recovery.messages),["현재까지 진행한 작업과 남은 작업을 보고해줘.","계속 진행"]);

    // Owned error-page navigation only: no external account and no messages.
    await post('/api/v1/autopilot/stop',{workstreamId:stream.id});
    currentRendererUnavailable='loading-error';await remote.reload({waitUntil:'domcontentloaded'});
    await post('/api/v1/autopilot/observe',{workstreamId:stream.id,observationPermitted:true});
    await options.getByRole('button',{name:'지금 동기화'}).click();
    await post('/api/v1/autopilot/loading/configure',{workstreamId:stream.id,reloadPermitted:true});
    const loadingState=async()=>{
      const d=await (await fetch(base+'/api/v1/snapshot')).json();return d.autopilot.scopes.find(s=>s.workstreamId===stream.id).loadingRecovery.episode;
    };
    const loadingCycle=async stage=>{
      await delay(31_000);await post('/api/v1/tick',{});
      await options.getByRole('button',{name:'지금 동기화'}).click();
      await waitFor('loading recovery stage '+stage,async()=>(await loadingState())?.stage===stage);
    };
    await post('/api/v1/autopilot/observe',{workstreamId:stream.id,observationPermitted:true});
    await options.getByRole('button',{name:'지금 동기화'}).click();
    await waitFor('loading error read-only recheck',async()=>(await loadingState())?.stage==='REOBSERVE');
    assert.equal(loadingReloads,0);loadingArmed=true;
    const commandsBeforeLoading=(await (await fetch(base+'/api/v1/snapshot')).json()).chatContinuation.commands.length;
    await loadingCycle('POST_RELOAD');assert.equal(loadingReloads,1);
    await loadingCycle('VERIFYING');await loadingCycle('DONE');
    assert.equal(loadingReloads,1);assert.equal(remote.url(),'https://chatgpt.com/c/e2e-created');
    await options.getByRole('button',{name:'지금 동기화'}).click();assert.equal(loadingReloads,1);
    assert.equal((await (await fetch(base+'/api/v1/snapshot')).json()).chatContinuation.commands.length,commandsBeforeLoading);

    loadingArmed=false;loadingReloads=0;loadingWillRecover=false;
    currentRendererUnavailable='loading-failure';await remote.reload({waitUntil:'domcontentloaded'});
    await post('/api/v1/autopilot/observe',{workstreamId:stream.id,observationPermitted:true});
    await options.getByRole('button',{name:'지금 동기화'}).click();
    await waitFor('second request begins independent loading episode',async()=>(await loadingState())?.stage==='REOBSERVE');
    loadingArmed=true;
    await loadingCycle('POST_RELOAD');await loadingCycle('FAILED');
    assert.equal(loadingReloads,1);
    await post('/api/v1/tick',{});await options.getByRole('button',{name:'지금 동기화'}).click();
    const failedLoading=await (await fetch(base+'/api/v1/snapshot')).json();
    assert.equal(failedLoading.workstreams.find(w=>w.id===stream.id).paused,true);
    assert.ok(failedLoading.autopilot.inbox.some(i=>i.workstreamId===stream.id&&i.reasonCode==='LOADING_RELOAD_DID_NOT_RECOVER'));
    assert.equal(failedLoading.chatContinuation.commands.length,commandsBeforeLoading);assert.equal(loadingReloads,1);

    // The length-limit E2E proves detection only; automated handoff remains a separate opt-in path.
    assert.equal(await casePages[4].evaluate(() => location.pathname), "/c/e2e-length");
    console.log(JSON.stringify({
      browser: `isolated Playwright ${installedBrowser ? path.basename(installedBrowser) : "Chromium"} + unpacked MV3 extension`,
      bridge: "paired through extension options UI; local server uses ephemeral port and disposable SQLite",
      registeredSessionCounts: [1, 3, 10, 20],
      observations: classification,
      duplicateSend: { firstClicked: firstSend.clicked, secondReason: secondSend.reason, actualClicks: 1 },
      unregisteredTabExcluded: true,
      localhostEnrollmentOfLiveGroupedTab: true,
      createdChatSameTabExplicitRebindAndApprovalRevocation: true,
      extensionReloadRequiresFreshSingleTabConfirmation: true,
      repeatedReloadAfterConfirmedCreatedChatPreservesSessionAndRevokesApproval: true,
      currentRendererObservedByExtensionWorker: true,
      pageFailureDistinguishedFromDeliveryFailureWithoutSend: true,
      wholeConversationFailureWithoutComposerIsUnverifiedAndBlocksSend: true,
      localInboxApprovalReadOnlyReinspectionAndReviewedResume: true,
      disposableRecoveryStopReportIndependentProofAndBoundedContinue: true,
      disposableLoadingErrorReadRecheckSameTabSingleReloadFreshStableResponse: true,
      persistentLoadingFailurePausesOnlyItsAxisWithoutRetryOrMessages: true,
      recoveryInspectionDueTimeAdvancedOnlyInDisposableSQLite: true,
      isolatedPlaywrightTrace:".autopilot/e2e-artifacts/extension-browser-trace.zip",
      externalChatGPTOrUserChromeUsed: false
    }, null, 2));
  } finally {
    if(context){mkdirSync(path.dirname(tracePath),{recursive:true});
      await context.tracing.stop({path:tracePath}).catch(()=>undefined);
      await context.close().catch(()=>undefined);}
    if (server.exitCode === null) {
      const exited = new Promise(resolve => server.once("exit", resolve));
      server.kill();
      await Promise.race([exited, delay(5_000)]);
    }
    const resolvedTemp = path.resolve(tempRoot);
    if (!resolvedTemp.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("Refusing cleanup outside the temporary test directory");
    rmSync(resolvedTemp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
