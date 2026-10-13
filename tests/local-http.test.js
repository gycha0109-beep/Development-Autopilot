import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function openPort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}
async function ready(base, child) {
  for (let i = 0; i < 70; i++) {
    if (child.exitCode != null) throw new Error("Server exited before ready.");
    try {
      const res = await fetch(base + "/api/v1/snapshot");
      if (res.ok) return;
    } catch { /* Retry until the listening socket becomes available. */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Server did not start within the test timeout.");
}
async function post(base, route, payload, origin = base) {
  return fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": origin },
    body: JSON.stringify(payload)
  });
}

test("local HTTP control plane enforces same-origin writes and persists simulated task state", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-http-"));
  const port = await openPort();
  const base = "http://127.0.0.1:" + port;
  const database = join(dir, "state.sqlite3");
  // process cwd as file URL is platform-portable.
  const child = spawn(process.execPath, ["local/server.js"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, AUTOPILOT_PORT: String(port), AUTOPILOT_DB: database },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await ready(base, child);
    let res = await fetch(base + "/api/v1/snapshot");
    assert.equal(res.status, 200);
    let json = await res.json();
    assert.equal(json.execution, "simulation-only");
    assert.equal(json.workstreams.length, 0);

    res = await post(base, "/api/v1/workstreams", {
      id: "myeongha", name: "MyeongHa mock", projectKey: "myeongha",
      repository: "owner/MyeongHa", intervalMinutes: 35
    }, "https://untrusted.example");
    assert.equal(res.status, 403); // cross-origin requests cannot alter local state

    res = await post(base, "/api/v1/workstreams", {
      id: "myeongha", name: "MyeongHa mock", projectKey: "myeongha",
      repository: "owner/MyeongHa", intervalMinutes: 35
    });
    assert.equal(res.status, 201);
    json = await res.json();
    assert.equal(json.workstream.mode, "observe");

    res = await post(base, "/api/v1/workstreams/myeongha/configure", { mode: "simulation" });
    assert.equal(res.status, 200);
    res = await post(base, "/api/v1/workstreams/myeongha/arm", {});
    assert.equal(res.status, 200);
    res = await post(base, "/api/v1/control", { stopped: true });
    assert.equal(res.status, 200);
    res = await post(base, "/api/v1/tick", {});
    json = await res.json();
    assert.deepEqual(json.actions, []);
    res = await post(base, "/api/v1/control", { stopped: false });
    assert.equal(res.status, 200);
    res = await post(base, "/api/v1/tick", {});
    assert.equal(res.status, 200);
    json = await res.json();
    assert.equal(json.actions.length, 1);
    assert.equal(json.actions[0].kind, "simulated-dispatch");

    res = await fetch(base + "/api/v1/snapshot");
    json = await res.json();
    assert.equal(json.workstreams[0].state, "WAIT_EXTERNAL");
    assert.equal(json.operations.length, 1);
    assert.equal(json.workstreams[0].active_operation_id, json.operations[0].id);
    const operationId = json.operations[0].id;

    res = await post(base, "/api/v1/tick", {});
    json = await res.json();
    assert.deepEqual(json.actions, []); // queued task must not be resent

    res = await post(base, "/api/v1/operations/" + operationId + "/resolve",
      { outcome: "completed" });
    assert.equal(res.status, 200);
    json = await res.json();
    assert.equal(json.workstream.state, "COMPLETE");
    assert.equal(json.workstream.active_operation_id, null);

    res = await fetch(base + "/api/v1/snapshot");
    json = await res.json();
    assert.equal(json.operations.length, 1);
    assert.ok(json.events.length >= 4);
  } finally {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2000).unref();
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
