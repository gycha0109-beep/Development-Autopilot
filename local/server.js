import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkstreamStore } from "./store.js";
import { LocalScheduler } from "./scheduler.js";
import { ChromeBridge, EXTENSION_ORIGIN } from "./chrome-bridge.js";
import { PortableWorkstreamConfig } from "./portable-config.js";
import { WatchtowerObserver } from "./watchtower-observer.js";
import { GitHubObserver } from "./github-observer.js";
import { DecisionGate } from "./decision-gate.js";
import { ciResumeCandidates,ciFollowupStatus } from "./ci-resume.js";
import { ExecutionLoop } from "./execution-loop.js";
import { ChatContinuation } from "./chat-continuation.js";
import { TelegramLocalConfig } from "./telegram-config.js";
import { WindowsTelegramCompatibility } from "./windows-telegram-compat.js";
import { dirname,join } from "node:path";

const port = Number(process.env.AUTOPILOT_PORT || 48173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("AUTOPILOT_PORT must be an integer between 1024 and 65535.");
}
const origin = "http://127.0.0.1:" + port;
const dbPath = resolve(process.env.AUTOPILOT_DB || ".autopilot/autopilot.sqlite3");
const store = new WorkstreamStore(dbPath);
const bridge = new ChromeBridge(store);
const portableConfig = new PortableWorkstreamConfig(store,bridge);
const watchtower = new WatchtowerObserver(store);
const github = new GitHubObserver(store,{watchtower});
const gate = new DecisionGate(store,{watchtower,github});
const executionLoop = new ExecutionLoop(store,{gate,watchtower,github});
const chat = new ChatContinuation(store,{bridge,watchtower,github,gate,
  ciCandidates:(requireReviewed=true)=>ciResumeCandidates({store,watchtower,github,gate,requireReviewed})});
const telegram = new TelegramLocalConfig(join(dirname(dbPath),"telegram.secure.json"));
telegram.restore(chat.approvals);
const windowsTelegram=new WindowsTelegramCompatibility(store);
if(!telegram.status(chat.approvals).configured)
  windowsTelegram.attachApprovals(chat.approvals);
const scheduler = new LocalScheduler(store,{
  // Unbound workstreams preserve the existing explicitly opted-in mock simulator.
  // Any CI/PR binding introduces a mandatory human-reviewed evidence checkpoint.
  authorizeClaim:item=>{
    const bound = watchtower.targets.list().some(t=>t.workstreamId===item.id) ||
      github.targets.list().some(t=>t.workstreamId===item.id);
    return !chat.hasConfigured(item.id) && !executionLoop.hasAny(item.id) && (!bound || gate.one(item.id)?.decision==="REVIEWED");
  }
});
// Recovery is delayed until the localhost port is exclusively bound.

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"]
};
const root = fileURLToPath(new URL("./public/", import.meta.url));

function headers(type) {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; " +
      "connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  };
}
function respond(res, status, data) {
  res.writeHead(status, headers("application/json; charset=utf-8"));
  res.end(JSON.stringify(data));
}
async function bodyJson(req, maxBytes = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("요청이 너무 큽니다.");
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("JSON 객체가 필요합니다.");
  }
  return parsed;
}
function snapshot() {
  return {
    version: 1,
    execution: "chrome-registered-chat-opt-in-plus-simulation",
    globalStopped: store.isStopped(),
    integration: { chrome: bridge.getSnapshot().clients.some(c => c.status === "online") ? "connected" : "not-connected",
      watchtower:watchtower.current().status==="connected"?"connected":"not-connected",
      github:github.current().targets.length===0?"not-configured":
        github.current().results.some(r=>r.repository&&r.state!=="UNKNOWN")?"connected":"not-connected" },
    chromeBridge: bridge.getSnapshot(),
    watchtower: watchtower.current(),
    github: github.current(),
    decisionGate: { results: gate.list(), history: gate.recentHistory(25) },
    executionPlans: executionLoop.list(),
    chatContinuation: { configs: chat.configs(), commands: chat.commands(30),
      ciResumeCandidates:ciResumeCandidates({store,watchtower,github,gate}),
      ciFollowup:store.list().map(w=>({workstreamId:w.id,
        ...ciFollowupStatus({workstreamId:w.id,watchtower,github,gate})})),
      observations: chat.observationStates(),humanApprovals:chat.approvals.status() },
    telegramConnection:telegram.status(chat.approvals).configured ?
      telegram.status(chat.approvals) :
      windowsTelegram.enabled ?
        {configured:true,botUsername:"Johnny0109bot",
          source:"windows_credential_manager",providerValidatedBy:"local_opt_in_guard"} :
        telegram.status(chat.approvals),
    ciSupervision:windowsTelegram.snapshot(),
    workstreams: store.list(),
    operations: store.operations(20),
    events: store.events(30)
  };
}
let ticking = false;
async function tick() {
  if (ticking) return [];
  ticking = true;
  try {
    // Notification IO is advisory, guarded by explicit Windows credential opt-in.
    // It is independent of the global ChatGPT automation stop.
    void windowsTelegram.tick().catch(()=>undefined);
    return [...await scheduler.tick(),...chat.tick()];
  }
  finally { ticking = false; }
}
function requireOwnLink(workstreamId,clientId,bridge,{connected=true}={}){
  const l=bridge.getSnapshot().links.find(x=>x.workstreamId===workstreamId &&
    x.extensionId===clientId && (!connected || x.status==="connected"));
  if(!l)throw Error("CHAT_WORKSTREAM_CONNECTED_LINK_REQUIRED");
  return l;
}
function requireLinkTarget(payload,clientId,bridge,store){
  if(typeof payload?.workstreamId!=="string"||typeof payload?.sessionKey!=="string")
    throw Error("CHAT_LINK_SELECTION_REQUIRED");
  store.mustGet(payload.workstreamId);
  const existing=bridge.getSnapshot().links.find(x=>x.workstreamId===payload.workstreamId);
  if(existing?.extensionId && existing.extensionId!==clientId)
    throw Error("CHAT_WORKSTREAM_OWNED_BY_OTHER_EXTENSION");
  const candidate=bridge.getSnapshot().sessions.find(s=>s.extensionId===clientId &&
    s.sessionKey===payload.sessionKey && s.status==="connected");
  if(!candidate)throw Error("CHAT_SESSION_NOT_CONNECTED");
}
async function route(req, res) {
  if (req.headers.host !== "127.0.0.1:" + port) {
    return respond(res, 403, { error: "로컬 호스트에서만 접근할 수 있습니다." });
  }
  const url = new URL(req.url || "/", origin);
  // Chrome extensions have a separate, strictly scoped cross-origin bridge.
  // No extension Origin receives any CORS permission on the normal control API.
  const extensionOrigin = req.headers.origin || "";
  const extensionRoute = ["/api/v1/bridge/pair", "/api/v1/bridge/sync", "/api/v1/bridge/observations", "/api/v1/bridge/commands", "/api/v1/bridge/ack", "/api/v1/bridge/status", "/api/v1/bridge/migration-pause", "/api/v1/bridge/migration-resume", "/api/v1/bridge/config-export", "/api/v1/bridge/config-import", "/api/v1/bridge/control-state", "/api/v1/bridge/control-link", "/api/v1/bridge/control-configure", "/api/v1/bridge/control-send-now", "/api/v1/bridge/control-stop"].includes(url.pathname);
  if (extensionRoute) {
    if (!EXTENSION_ORIGIN.test(extensionOrigin)) {
      return respond(res, 403, { error: "승인되지 않은 Origin입니다." });
    }
    const cors = {
      ...headers("application/json; charset=utf-8"),
      "Access-Control-Allow-Origin": extensionOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Max-Age": "300",
      "Access-Control-Allow-Private-Network": "true",
      "Vary": "Origin"
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method !== "POST" ||
        req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
      res.writeHead(403, cors);
      return res.end(JSON.stringify({ error: "JSON POST만 허용됩니다." }));
    }
    try {
      const payload = await bodyJson(req, 128 * 1024);
      if (url.pathname === "/api/v1/bridge/pair") {
        const result = bridge.pair(extensionOrigin, payload.code);
        const ok = result.ok === true;
        res.writeHead(ok ? 200 : 403, cors);
        return res.end(JSON.stringify(ok ? { token: result.token } : { error: "코드가 일치하지 않습니다." }));
      }
      const authorization = req.headers.authorization || "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const clientId = bridge.authenticate(extensionOrigin, token);
      if (!clientId) {
        res.writeHead(401, cors);
        return res.end(JSON.stringify({ error: "페어링이 만료되었거나 토큰이 유효하지 않습니다." }));
      }
      let result;
      if(url.pathname==="/api/v1/bridge/sync"){
        const previous=bridge.getSnapshot().links.filter(l=>l.extensionId===clientId);
        const synced=bridge.sync(clientId,payload);
        const updated=bridge.getSnapshot().links.filter(l=>l.extensionId===clientId);
        // A temporary disconnect/reconnect of the same registered conversation
        // is not a new approval. Only a changed conversation identity revokes it.
        for(const link of updated){
          const before=previous.find(l=>l.workstreamId===link.workstreamId);
          if(before && before.sessionKey===link.sessionKey &&
            before.urlHash && link.urlHash && before.urlHash!==link.urlHash)
            chat.suspendForSessionChange(link.workstreamId);
        }
        portableConfig.reconcile(clientId);
        const links=bridge.getSnapshot().links.filter(l=>l.extensionId===clientId && l.status==="connected");
        result={...synced,observationRequests:chat.requestObservations(clientId),
          migrationTargets:links.map(l=>{
            const work=store.mustGet(l.workstreamId);
            return {sessionKey:l.sessionKey,repository:work.repository};
          }).filter(t=>/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t.repository))};
      }
      else if(url.pathname==="/api/v1/bridge/config-export"){
        result=portableConfig.export(clientId);
      }
      else if(url.pathname==="/api/v1/bridge/config-import"){
        result=portableConfig.import(clientId,payload.workstreams);
      }
      else if(url.pathname==="/api/v1/bridge/control-state"){
        const current=bridge.getSnapshot();
        const ownLinks=current.links.filter(l=>l.extensionId===clientId);
        result={
          stopped:store.isStopped(),
          workstreams:store.list().map(w=>({id:w.id,name:w.name,repository:w.repository,
            enabled:w.enabled,paused:w.paused,state:w.state})),
          sessions:current.sessions.filter(s=>s.extensionId===clientId)
            .map(s=>({sessionKey:s.sessionKey,title:s.title,groupLabel:s.groupLabel,status:s.status})),
          links:ownLinks.map(l=>({workstreamId:l.workstreamId,sessionKey:l.sessionKey,
            status:l.status,title:l.title})),
          configs:ownLinks.map(l=>chat.config(l.workstreamId)).filter(Boolean),
          observation:ownLinks.map(l=>({workstreamId:l.workstreamId,
            state:chat.observationStates().find(o=>o.workstreamId===l.workstreamId)||null}))
        };
      }
      else if(url.pathname==="/api/v1/bridge/control-link"){
        requireLinkTarget(payload,clientId,bridge,store);
        const previous=bridge.getSnapshot().links.find(l=>l.workstreamId===payload.workstreamId);
        bridge.link(payload.workstreamId,clientId,payload.sessionKey);
        if(previous && previous.sessionKey!==payload.sessionKey)
          chat.suspendForSessionChange(payload.workstreamId);
        result={linked:true,workstreamId:payload.workstreamId,
          reapprovalRequired:Boolean(previous&&previous.sessionKey!==payload.sessionKey)};
      }
      else if(url.pathname==="/api/v1/bridge/control-configure"){
        requireOwnLink(payload.workstreamId,clientId,bridge);
        result={config:chat.configure(payload.workstreamId,payload)};
      }
      else if(url.pathname==="/api/v1/bridge/control-send-now"){
        requireOwnLink(payload.workstreamId,clientId,bridge);
        result={command:chat.queue(payload.workstreamId,{manual:true})};
      }
      else if(url.pathname==="/api/v1/bridge/control-stop"){
        requireOwnLink(payload.workstreamId,clientId,bridge,{connected:false});
        result={config:chat.stop(payload.workstreamId)};
      }
      else if(url.pathname==="/api/v1/bridge/observations"){
        result=chat.acceptObservation(clientId,payload);
        // The authenticated observation is persisted before delivery.
        void chat.approvals.flush().catch(()=>undefined);
      }
      else if(url.pathname==="/api/v1/bridge/commands")result={command:chat.claim(clientId)};
      else if(url.pathname==="/api/v1/bridge/ack")result=chat.acknowledge(clientId,payload.id,payload.status,payload.reason);
      else if(url.pathname==="/api/v1/bridge/status")result={stopped:store.isStopped(),authenticated:true};
      else if(url.pathname==="/api/v1/bridge/migration-pause"){
        if(store.isStopped())throw Error("MIGRATION_GLOBAL_STOP_ACTIVE");
        result=chat.pauseForMigration(clientId,payload.sessionKey);
      }
      else if(url.pathname==="/api/v1/bridge/migration-resume"){
        result=chat.resumeAfterMigration(clientId,payload.sessionKey);
      }
      else throw Error("UNKNOWN_EXTENSION_ROUTE");
      res.writeHead(200,cors);
      return res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, cors);
      return res.end(JSON.stringify({ error: error.message || "브리지 오류" }));
    }
  }
  if (req.method === "GET" && assets[url.pathname]) {
    const [file, mime] = assets[url.pathname];
    res.writeHead(200, headers(mime));
    res.end(readFileSync(resolve(root, file)));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/snapshot") {
    return respond(res, 200, snapshot());
  }
  if (req.method !== "POST" || !url.pathname.startsWith("/api/v1/")) {
    return respond(res, 404, { error: "경로가 없습니다." });
  }
  // POST requires a same-origin browser context and JSON preflight, blocking
  // cross-origin web pages from silently changing the local scheduler state.
  if (req.headers.origin !== origin ||
      req.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
      (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
    return respond(res, 403, { error: "같은 출처의 관리 화면에서만 변경할 수 있습니다." });
  }
  const json = await bodyJson(req);
  if(url.pathname==="/api/v1/telegram/configure"){
    const result=await telegram.configure(json,chat.approvals);
    void chat.approvals.flush().catch(()=>undefined);
    return respond(res,200,result);
  }
  if(url.pathname==="/api/v1/telegram/disconnect"){
    return respond(res,200,telegram.clear(chat.approvals));
  }
  if(url.pathname==="/api/v1/chat-continuation/configure"){
    const config=chat.configure(json.workstreamId,json);
    return respond(res,200,{config});
  }
  if(url.pathname==="/api/v1/chat-continuation/send-now"){
    return respond(res,200,{command:chat.queue(json.workstreamId,{manual:true})});
  }
  if(url.pathname==="/api/v1/chat-continuation/stop"){
    return respond(res,200,{config:chat.stop(json.workstreamId)});
  }
  if (url.pathname === "/api/v1/execution-plans") {
    return respond(res, 201, { plan: executionLoop.create(json) });
  }
  if (url.pathname === "/api/v1/control") {
    return respond(res, 200, { globalStopped: store.setStopped(json.stopped) });
  }
  if (url.pathname === "/api/v1/decision-gate/refresh") {
    await Promise.all([watchtower.refresh(),github.refresh()]);
    gate.recordCurrent();
    return respond(res, 200, { decisionGate: { results: gate.list(), history: gate.recentHistory(25) } });
  }
  if (url.pathname === "/api/v1/github/refresh") {
    return respond(res, 200, { github: await github.refresh() });
  }
  if (url.pathname === "/api/v1/watchtower/refresh") {
    return respond(res, 200, { watchtower: await watchtower.refresh() });
  }
  if (url.pathname === "/api/v1/bridge/pairing/start") {
    return respond(res, 200, bridge.beginPairing());
  }
  if (url.pathname === "/api/v1/bridge/unpair") {
    const extensionId = json.extensionId;
    if (!EXTENSION_ORIGIN.test("chrome-extension://" + extensionId)) {
      throw new Error("확장 프로그램 식별자가 잘못되었습니다.");
    }
    bridge.unpair(extensionId);
    return respond(res, 200, { unpaired: true });
  }
  if (url.pathname === "/api/v1/workstreams") {
    const created = store.create(json);
    return respond(res, 201, { workstream: created });
  }
  if (url.pathname === "/api/v1/tick") {
    return respond(res, 200, { actions: await tick() });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 5 && parts[0] === "api" && parts[1] === "v1" &&
      parts[2] === "execution-plans") {
    const id = decodeURIComponent(parts[3]);
    if (parts[4] === "approve") return respond(res,200,{plan:executionLoop.approve(id)});
    if (parts[4] === "dispatch") return respond(res,200,{plan:await executionLoop.dispatch(id)});
    if (parts[4] === "inspect") return respond(res,200,{plan:await executionLoop.inspect(id)});
    if (parts[4] === "abandon") return respond(res,200,{plan:executionLoop.abandon(id)});
  }
  if (parts.length === 5 && parts[0] === "api" && parts[1] === "v1" &&
      parts[2] === "workstreams") {
    const id = decodeURIComponent(parts[3]);
    if(parts[4]==="delete"){
      return respond(res,200,{result:store.deleteWorkstream(id,json.confirmName)});
    }
    if (parts[4] === "decision-review") {
      return respond(res, 200, { decision: gate.review(id) });
    }
    if (parts[4] === "github-target") {
      if (json.clear === true) github.targets.clear(id);
      else github.targets.set(id, json.prNumber, json.headSha);
      return respond(res, 200, { github: github.current() });
    }
    if (parts[4] === "watchtower-target") {
      if (json.clear === true) watchtower.targets.clear(id);
      else watchtower.targets.set(id, json);
      return respond(res, 200, { watchtower: watchtower.current() });
    }
    if (parts[4] === "link-chrome") {
      bridge.link(id, json.extensionId, json.sessionKey ?? null);
      return respond(res, 200, { chromeBridge: bridge.getSnapshot() });
    }
    if (parts[4] === "configure") return respond(res, 200, { workstream: store.configure(id, json) });
    if (parts[4] === "arm") return respond(res, 200, { workstream: store.arm(id) });
    if (parts[4] === "approve") return respond(res, 200, { workstream: store.approveHumanGate(id) });
  }
  if (parts.length === 5 && parts[0] === "api" && parts[1] === "v1" &&
      parts[2] === "operations" && parts[4] === "resolve") {
    const operationId=decodeURIComponent(parts[3]);
    if (executionLoop.list().some(p=>p.operationId===operationId)) {
      return respond(res,409,{error:"PHASE4_RESULT_MUST_BE_VERIFIED"});
    }
    return respond(res, 200, { workstream: store.resolve(operationId, json.outcome) });
  }
  return respond(res, 404, { error: "지원하지 않는 API입니다." });
}

const server = createServer((req, res) => {
  Promise.resolve(route(req, res)).catch(error => {
    console.error("[Autopilot]", error);
    if (!res.headersSent) respond(res, 400, { error: error.message || "처리에 실패했습니다." });
    else res.end();
  });
});
let timer;
let watchtowerTimer;
let githubTimer;
server.on("error", error => {
  console.error("[Autopilot server startup]", error);
  store.close();
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const recovered = store.recoverInFlight();
  const uncertainChat=chat.reconcile();
  const uncertain = executionLoop.reconcileOnStartup();
  timer = setInterval(() => {
    chat.reconcile();
    void chat.approvals.flush().catch(()=>undefined);
    tick().then(()=>gate.recordCurrent())
      .catch(error => console.error("[Autopilot scheduler]", error));
  }, 10_000);
  timer.unref();
  watchtower.refresh().catch(() => undefined);
  watchtowerTimer=setInterval(() => {
    watchtower.refresh().catch(() => undefined);
  }, 45_000);
  watchtowerTimer.unref();
  github.refresh().catch(() => undefined);
  gate.recordCurrent();
  githubTimer=setInterval(() => github.refresh().catch(() => undefined), 120_000);
  githubTimer.unref();
  console.log("Development Autopilot — Phase 2 mock control plane");
  console.log("Dashboard: " + origin);
  console.log("Database: " + dbPath);
  console.log("Startup UNKNOWN reconciliations: " + recovered + "; execution receipts: " + uncertain + "; chat claims: " + uncertainChat);
  console.log("No Chrome automation, GitHub mutations, or AI prompt submissions.");
  console.log("Windows Telegram notification compatibility: "+
    (windowsTelegram.enabled?"opted_in":"disabled")+"; SMS remains disabled.");
});
function stop() {
  if (timer) clearInterval(timer);
  if (watchtowerTimer) clearInterval(watchtowerTimer);
  if (githubTimer) clearInterval(githubTimer);
  server.close(() => { store.close(); process.exit(0); });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
