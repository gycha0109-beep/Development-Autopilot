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
    assert.equal(json.execution, "chrome-registered-chat-opt-in-plus-simulation");
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

    res = await post(base, "/api/v1/workstreams/myeongha/watchtower-target", {
      repositoryId:12,runId:999,headSha:"a".repeat(40),attempt:1
    }, "https://untrusted.example");
    assert.equal(res.status,403);
    res = await post(base, "/api/v1/workstreams/myeongha/watchtower-target", {
      repositoryId:12,runId:999,headSha:"a".repeat(40),attempt:1
    });
    assert.equal(res.status,200);
    res = await fetch(base + "/api/v1/snapshot");
    json = await res.json();
    assert.equal(json.watchtower.targets.length,1);
    assert.equal(json.watchtower.targets[0].runId,999);
    assert.equal(json.workstreams[0].state,"COMPLETE");
    res = await post(base,"/api/v1/watchtower/refresh",{});
    assert.equal(res.status,200);
    json = await res.json();
    assert.ok(["connected","unavailable"].includes(json.watchtower.status));
    assert.equal(json.watchtower.results[0].safeToAdvance,false);
    res = await post(base,"/api/v1/workstreams/myeongha/github-target",{
      prNumber:14,headSha:"b".repeat(40)
    },"https://untrusted.example");
    assert.equal(res.status,403);
    res = await post(base,"/api/v1/workstreams/myeongha/github-target",{
      prNumber:14,headSha:"b".repeat(40)
    });
    assert.equal(res.status,200);
    res = await fetch(base+"/api/v1/snapshot");
    json = await res.json();
    assert.equal(json.github.targets.length,1);
    res = await post(base,"/api/v1/github/refresh",{});
    assert.equal(res.status,200);
    json = await res.json();
    assert.equal(json.github.results.length,1);
    assert.equal(json.github.results[0].safeToAdvance,false);
    assert.equal(json.github.results[0].reason,"WATCHTOWER_GITHUB_HEAD_MISMATCH");
    // Gated simulation must not claim any operation on mismatched/stale CI evidence.
    res = await post(base,"/api/v1/workstreams",{
      id:"guarded",name:"Guarded",projectKey:"guarded",repository:"owner/Guarded"
    });
    assert.equal(res.status,201);
    res = await post(base,"/api/v1/workstreams/guarded/configure",{mode:"simulation"});
    assert.equal(res.status,200);
    res = await post(base,"/api/v1/workstreams/guarded/arm",{});
    assert.equal(res.status,200);
    res = await post(base,"/api/v1/workstreams/guarded/watchtower-target",{
      repositoryId:12,runId:1000,headSha:"a".repeat(40),attempt:1
    });
    assert.equal(res.status,200);
    res = await post(base,"/api/v1/workstreams/guarded/github-target",{
      prNumber:100,headSha:"b".repeat(40)
    });
    assert.equal(res.status,200);
    res = await post(base,"/api/v1/decision-gate/refresh",{});
    assert.equal(res.status,200);
    json = await res.json();
    assert.equal(json.decisionGate.results.find(g=>g.workstreamId==="guarded").reason,
      "TARGET_HEAD_SHA_MISMATCH");
    res = await post(base,"/api/v1/tick",{});
    assert.equal(res.status,200);
    assert.deepEqual((await res.json()).actions,[]);
    res = await post(base,"/api/v1/workstreams/guarded/decision-review",{},
      "https://untrusted.example");
    assert.equal(res.status,403);
    res = await post(base,"/api/v1/workstreams/guarded/decision-review",{});
    assert.equal(res.status,400);
    res = await fetch(base+"/api/v1/snapshot");
    json = await res.json();
    assert.equal(json.operations.length,1);
    assert.equal(json.decisionGate.results.find(g=>g.workstreamId==="guarded").executionAllowed,false);

    res = await post(base,"/api/v1/workstreams/myeongha/github-target",{clear:true});
    assert.equal(res.status,200);
    res = await post(base,"/api/v1/workstreams/myeongha/watchtower-target",{clear:true});
    assert.equal(res.status,200);
    // Phase 4 explicitly approved, receipt-verified single simulated task.
    res=await post(base,"/api/v1/workstreams",{
      id:"phase4",name:"Phase 4 mock",projectKey:"phase4",repository:"owner/phase4"
    });
    assert.equal(res.status,201);
    res=await post(base,"/api/v1/workstreams/phase4/configure",{mode:"simulation"});
    assert.equal(res.status,200);
    res=await post(base,"/api/v1/workstreams/phase4/arm",{});
    assert.equal(res.status,200);
    const requestBody={
      workstreamId:"phase4",title:"One-shot test",
      instruction:"Produce a simulated proof and verify it",expectedMarker:"SIMULATED_PASS"
    };
    res=await post(base,"/api/v1/execution-plans",requestBody,"https://evil.example");
    assert.equal(res.status,403);
    res=await post(base,"/api/v1/execution-plans",requestBody);
    assert.equal(res.status,201);
    const newPlan=(await res.json()).plan;
    assert.equal(newPlan.status,"draft");
    res=await post(base,"/api/v1/execution-plans/"+newPlan.id+"/dispatch",{});
    assert.equal(res.status,400);
    res=await post(base,"/api/v1/execution-plans/"+newPlan.id+"/approve",{});
    assert.equal(res.status,200);
    res=await post(base,"/api/v1/tick",{});
    const tick=(await res.json()).actions;
    assert.equal(tick.filter(x=>x.workstreamId==="phase4").length,0);
    res=await post(base,"/api/v1/execution-plans/"+newPlan.id+"/dispatch",{});
    assert.equal(res.status,200);
    let dispatched=(await res.json()).plan;
    assert.equal(dispatched.status,"waiting");
    assert.equal(dispatched.phaseComplete,false);
    res=await post(base,"/api/v1/operations/"+dispatched.operationId+"/resolve",{
      outcome:"completed"
    });
    assert.equal(res.status,409);
    res=await post(base,"/api/v1/execution-plans/"+newPlan.id+"/inspect",{});
    assert.equal(res.status,200);
    const verified=(await res.json()).plan;
    assert.equal(verified.status,"verified");
    assert.equal(verified.verifiedSimulation,true);
    assert.equal(verified.phaseComplete,false);
    res=await post(base,"/api/v1/execution-plans/"+newPlan.id+"/inspect",{});
    assert.equal(res.status,400);
    res=await fetch(base+"/api/v1/snapshot");
    const final=(await res.json());
    assert.equal(final.workstreams.find(w=>w.id==="phase4").state,"COMPLETE");
    assert.equal(final.operations.filter(o=>o.workstream_id==="phase4").length,1);
    assert.equal(final.executionPlans.length,1);
    res = await fetch(base + "/api/v1/snapshot");
    json = await res.json();
    assert.equal(json.operations.length, 2);
    assert.ok(json.events.length >= 4);
    // Delete a completed workstream, including its dependent operations, CI
    // targets and events. The other workstreams remain untouched.
    res=await post(base,"/api/v1/workstreams/myeongha/delete",{
      confirmName:"WRONG"
    },"https://evil.example");
    assert.equal(res.status,403);
    res=await post(base,"/api/v1/workstreams/myeongha/delete",{
      confirmName:"WRONG"
    });
    assert.equal(res.status,400);
    res=await post(base,"/api/v1/workstreams/myeongha/delete",{
      confirmName:"MyeongHa mock"
    });
    assert.equal(res.status,200);
    assert.equal((await res.json()).result.deleted,true);
    res=await fetch(base+"/api/v1/snapshot");
    json=await res.json();
    assert.equal(json.workstreams.some(s=>s.id==="myeongha"),false);
    assert.equal(json.events.some(e=>e.workstream_id==="myeongha"),false);
    assert.equal(json.operations.some(o=>o.workstream_id==="myeongha"),false);
    assert.equal(json.workstreams.some(s=>s.id==="phase4"),true);
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
