import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const extension = "chrome-extension://" + "a".repeat(32);
const root = resolve(import.meta.dirname, "..");
const port = 48921;
const base = "http://127.0.0.1:" + port;

function request(path, data, origin, key) {
  return fetch(base + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: "Bearer " + key } : {})
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {})
  });
}

test("authenticated one-file workstream backup import/export and later exact bridge link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-portable-"));
  const server = spawn(process.execPath, ["local/server.js"], {
    cwd: root,
    env: { ...process.env, AUTOPILOT_DB: join(dir,"state.sqlite3"), AUTOPILOT_PORT: String(port) },
    windowsHide: true, stdio: "ignore"
  });
  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await request("/api/v1/snapshot");
        if (r.ok) { up = true; break; }
      } catch {}
      await delay(100);
    }
    assert.ok(up, "isolated local HTTP server must start");
    const begin = await request("/api/v1/bridge/pairing/start", {}, base);
    assert.equal(begin.status,200);
    const { code } = await begin.json();
    const pair = await request("/api/v1/bridge/pair", {code}, extension);
    assert.equal(pair.status,200);
    const { token } = await pair.json();
    assert.ok(token);

    const workstream = {
      name:"PIE",projectKey:"PIE",repository:"gycha0109-beep/Project_Intelligence_Engine",
      trackKey:null,intervalMinutes:35,paused:false,enabled:true,sessionKey:"portable-session"
    };
    const imported = await request("/api/v1/bridge/config-import",
      {workstreams:[workstream]},extension,token);
    assert.equal(imported.status,200);
    assert.equal((await imported.json()).created,1);

    const synced = await request("/api/v1/bridge/sync",{
      version:1,
      composerBuild:"composer-2026-10-15-r17",
      sessions:[{
        sessionKey:"portable-session",groupKey:"portable-group",
        groupLabel:"PIE",title:"PIE 데이터 분석 2",
        origin:"https://chatgpt.com",status:"connected"
      }]
    },extension,token);
    assert.equal(synced.status,200);

    const exported = await request("/api/v1/bridge/config-export",{},extension,token);
    assert.equal(exported.status,200);
    const body = await exported.json();
    assert.equal(body.workstreams[0].repository, workstream.repository);
    assert.equal(body.workstreams[0].sessionKey,"portable-session");
    assert.equal(JSON.stringify(body).includes(token),false);

    const second = await request("/api/v1/bridge/config-import",
      {workstreams:[workstream]},extension,token);
    assert.equal((await second.json()).created,0);
    const snapshot = await request("/api/v1/snapshot");
    const state = await snapshot.json();
    assert.equal(state.workstreams.length,1);
    assert.equal(state.chromeBridge.links.length,1);

    const unauthorized = await request("/api/v1/bridge/config-export",{},extension);
    assert.equal(unauthorized.status,401);
  } finally {
    if (server.exitCode === null && !server.killed) server.kill();
    await Promise.race([once(server,"exit"),delay(2500)]);
    rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
