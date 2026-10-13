import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkstreamStore } from "./store.js";
import { LocalScheduler } from "./scheduler.js";

const port = Number(process.env.AUTOPILOT_PORT || 48173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("AUTOPILOT_PORT must be an integer between 1024 and 65535.");
}
const origin = "http://127.0.0.1:" + port;
const dbPath = resolve(process.env.AUTOPILOT_DB || ".autopilot/autopilot.sqlite3");
const store = new WorkstreamStore(dbPath);
const scheduler = new LocalScheduler(store);
const recovered = store.recoverInFlight();

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
async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32_768) throw new Error("요청이 너무 큽니다.");
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
    execution: "simulation-only",
    integration: { chrome: "not-connected", watchtower: "not-connected", github: "not-connected" },
    workstreams: store.list(),
    operations: store.operations(20),
    events: store.events(30)
  };
}
let ticking = false;
async function tick() {
  if (ticking) return [];
  ticking = true;
  try { return await scheduler.tick(); }
  finally { ticking = false; }
}
async function route(req, res) {
  if (req.headers.host !== "127.0.0.1:" + port) {
    return respond(res, 403, { error: "로컬 호스트에서만 접근할 수 있습니다." });
  }
  const url = new URL(req.url || "/", origin);
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
  if (url.pathname === "/api/v1/workstreams") {
    const created = store.create(json);
    return respond(res, 201, { workstream: created });
  }
  if (url.pathname === "/api/v1/tick") {
    return respond(res, 200, { actions: await tick() });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 5 && parts[0] === "api" && parts[1] === "v1" &&
      parts[2] === "workstreams") {
    const id = decodeURIComponent(parts[3]);
    if (parts[4] === "configure") return respond(res, 200, { workstream: store.configure(id, json) });
    if (parts[4] === "arm") return respond(res, 200, { workstream: store.arm(id) });
  }
  if (parts.length === 5 && parts[0] === "api" && parts[1] === "v1" &&
      parts[2] === "operations" && parts[4] === "resolve") {
    return respond(res, 200, { workstream: store.resolve(decodeURIComponent(parts[3]), json.outcome) });
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
const timer = setInterval(() => {
  tick().catch(error => console.error("[Autopilot scheduler]", error));
}, 10_000);
timer.unref();

server.listen(port, "127.0.0.1", () => {
  console.log("Development Autopilot — Phase 2 mock control plane");
  console.log("Dashboard: " + origin);
  console.log("Database: " + dbPath);
  console.log("Startup UNKNOWN reconciliations: " + recovered);
  console.log("No Chrome automation, GitHub mutations, or AI prompt submissions.");
});
function stop() {
  clearInterval(timer);
  server.close(() => { store.close(); process.exit(0); });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
