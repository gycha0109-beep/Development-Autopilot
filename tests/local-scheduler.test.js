import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkstreamStore } from "../local/store.js";
import { LocalScheduler } from "../local/scheduler.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-phase2-"));
  const path = join(dir, "workstreams.sqlite3");
  const store = new WorkstreamStore(path);
  return {
    store, path,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}
function task(id = "buildmap", intervalMinutes = 35) {
  return { id, name: "BuildMap Phase 54", projectKey: "buildmap",
    repository: "owner/BuildMap", trackKey: "ops", intervalMinutes };
}
function simulation(store, id, at = 10_000) {
  store.configure(id, { mode: "simulation" }, at);
  store.arm(id, at);
}
test("new workstreams remain observation-only, with a 35-minute default", () => {
  const x = makeStore();
  try {
    const created = x.store.create({ ...task(), intervalMinutes: undefined }, 1000);
    assert.equal(created.mode, "observe");
    assert.equal(created.state, "OBSERVING");
    assert.equal(created.interval_minutes, 35);
    assert.equal(x.store.operations().length, 0);
    assert.equal(x.store.events()[0].kind, "created");
  } finally { x.cleanup(); }
});

test("observation does not execute and respects separate workstream intervals", async () => {
  const x = makeStore();
  try {
    x.store.create(task("a", 35), 1000);
    x.store.create(task("b", 10), 1000);
    let clock = 1000;
    const scheduler = new LocalScheduler(x.store, { now: () => clock });
    assert.equal((await scheduler.tick()).length, 2);
    assert.equal((await scheduler.tick()).length, 0);
    clock += 11 * 60_000;
    assert.deepEqual((await scheduler.tick()).map(v => v.workstreamId), ["b"]);
    clock += 25 * 60_000;
    assert.deepEqual((await scheduler.tick()).map(v => v.workstreamId), ["a", "b"]);
    assert.equal(x.store.operations().length, 0);
  } finally { x.cleanup(); }
});

test("one explicit mock approval creates one operation, never repeated at 35 minutes", async () => {
  const x = makeStore();
  try {
    x.store.create(task(), 1000);
    simulation(x.store, "buildmap", 1000);
    let clock = 1000;
    const scheduler = new LocalScheduler(x.store, { now: () => clock });
    const first = await scheduler.tick();
    assert.equal(first[0].kind, "simulated-dispatch");
    assert.equal(x.store.get("buildmap").state, "WAIT_EXTERNAL");
    assert.equal(x.store.operations().length, 1);
    clock += 36 * 60_000;
    assert.equal((await scheduler.tick()).length, 0);
    assert.equal(x.store.operations().length, 1);
    assert.equal((await scheduler.tick()).length, 0);
  } finally { x.cleanup(); }
});

test("completing a mock task and explicitly arming a new revision allows one new operation", async () => {
  const x = makeStore();
  try {
    x.store.create(task(), 100);
    simulation(x.store, "buildmap", 100);
    let clock = 100;
    const scheduler = new LocalScheduler(x.store, { now: () => clock });
    await scheduler.tick();
    const op1 = x.store.operations()[0].id;
    const done = x.store.resolve(op1, "completed", 200);
    assert.equal(done.state, "COMPLETE");
    assert.equal(done.active_operation_id, null);
    clock = 201;
    x.store.arm("buildmap", clock);
    await scheduler.tick();
    assert.equal(x.store.operations().length, 2);
    assert.equal(x.store.get("buildmap").task_revision, 2);
    assert.notEqual(x.store.operations()[0].id, op1);
  } finally { x.cleanup(); }
});

test("a paused stream does not dispatch; another workstream is independent", async () => {
  const x = makeStore();
  try {
    x.store.create(task("a"), 100);
    x.store.create(task("b"), 100);
    simulation(x.store, "a", 100);
    simulation(x.store, "b", 100);
    x.store.configure("a", { paused: true }, 100);
    let clock = 101;
    const scheduler = new LocalScheduler(x.store, { now: () => clock });
    assert.deepEqual((await scheduler.tick()).map(v => v.workstreamId), ["b"]);
    assert.equal(x.store.get("a").state, "READY");
    x.store.configure("a", { paused: false }, 200);
    clock = 201;
    assert.deepEqual((await scheduler.tick()).map(v => v.workstreamId), ["a"]);
  } finally { x.cleanup(); }
});

test("a crash with a reserved operation is UNKNOWN on restart, with no automatic replay", async () => {
  const x = makeStore();
  try {
    x.store.create(task(), 100);
    simulation(x.store, "buildmap", 100);
    const reserved = x.store.claimDue("buildmap", 100);
    assert.equal(x.store.get("buildmap").state, "RUNNING");
    x.store.close();
    x.store = new WorkstreamStore(x.path);
    assert.equal(x.store.recoverInFlight(200), 1);
    assert.equal(x.store.get("buildmap").state, "UNKNOWN");
    assert.equal(x.store.get("buildmap").active_operation_id, reserved.operationId);
    const scheduler = new LocalScheduler(x.store, { now: () => 999999999 });
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(x.store.operations().length, 1);
    assert.throws(() => x.store.arm("buildmap", 201), /미완료/);
    x.store.resolve(reserved.operationId, "abandoned", 202);
    x.store.arm("buildmap", 203);
    assert.equal(x.store.get("buildmap").task_revision, 2);
  } finally { x.cleanup(); }
});

test("SQLite survives clean shutdown, retaining schedule and audit", () => {
  const x = makeStore();
  try {
    x.store.create(task(), 100);
    x.store.observeDue("buildmap", 200);
    const before = x.store.get("buildmap");
    const events = x.store.events().length;
    x.store.close();
    x.store = new WorkstreamStore(x.path);
    assert.equal(x.store.get("buildmap").next_eligible_at, before.next_eligible_at);
    assert.equal(x.store.events().length, events);
    assert.equal(x.store.recoverInFlight(300), 0);
  } finally { x.cleanup(); }
});

test("UNKNOWN, BLOCKED or WAIT_EXTERNAL cannot spontaneously continue", async () => {
  const x = makeStore();
  try {
    x.store.create(task(), 100);
    simulation(x.store, "buildmap", 100);
    const scheduler = new LocalScheduler(x.store, { now: () => 100 });
    await scheduler.tick();
    const operationId = x.store.operations()[0].id;
    assert.throws(() => x.store.arm("buildmap"), /미완료/);
    x.store.resolve(operationId, "failed", 101);
    assert.equal(x.store.get("buildmap").state, "BLOCKED");
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(x.store.operations().length, 1);
  } finally { x.cleanup(); }
});

test("failed mock adapter blocks and logs exactly one failed operation", async () => {
  const x = makeStore();
  try {
    x.store.create(task(), 100);
    simulation(x.store, "buildmap", 100);
    const scheduler = new LocalScheduler(x.store, {
      now: () => 100,
      executor: { submit: async () => { throw Error("fake outage"); } }
    });
    const output = await scheduler.tick();
    assert.equal(output.length, 1);
    assert.equal(output[0].kind, "simulation-error");
    assert.equal(x.store.get("buildmap").state, "BLOCKED");
    assert.equal(x.store.operations()[0].status, "failed");
    assert.equal((await scheduler.tick()).length, 0);
  } finally { x.cleanup(); }
});

test("malformed values and unapproved modes cannot be persisted", () => {
  const x = makeStore();
  try {
    assert.throws(() => x.store.create(task("test", 0)), /간격/);
    assert.throws(() => x.store.create({ ...task(), repository: "not-a-repo" }), /저장소/);
    x.store.create(task(), 100);
    assert.throws(() => x.store.configure("buildmap", { mode: "unrestricted" }), /모드/);
    assert.throws(() => x.store.configure("buildmap", { enabled: "false" }), /boolean/);
    assert.throws(() => x.store.configure("buildmap", { state: "COMPLETE" }), /지원/);
    assert.equal(x.store.get("buildmap").mode, "observe");
  } finally { x.cleanup(); }
});

test("resolving an operation twice is rejected and does not change audit", async () => {
  const x = makeStore();
  try {
    x.store.create(task(), 100);
    simulation(x.store, "buildmap", 100);
    await new LocalScheduler(x.store, { now: () => 100 }).tick();
    const operationId = x.store.operations()[0].id;
    x.store.resolve(operationId, "completed", 200);
    const before = x.store.events().length;
    assert.throws(() => x.store.resolve(operationId, "completed", 201), /이미/);
    assert.equal(x.store.events().length, before);
  } finally { x.cleanup(); }
});

test("two concurrent ticks cannot submit an operation twice", async () => {
  const x = makeStore();
  try {
    x.store.create(task(), 100);
    simulation(x.store, "buildmap", 100);
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const executor = { submit: async () => { calls++; await promise; return { accepted: true }; } };
    const s1 = new LocalScheduler(x.store, { executor, now: () => 100 });
    const s2 = new LocalScheduler(x.store, { executor, now: () => 100 });
    const first = s1.tick();
    const second = await s2.tick();
    assert.equal(second.length, 0);
    release();
    await first;
    assert.equal(calls, 1);
    assert.equal(x.store.operations().length, 1);
  } finally { x.cleanup(); }
});

test("a manually cancelled simulated run stays in human-required state", async () => {
  const x = makeStore();
  try {
    x.store.create(task(), 100);
    simulation(x.store, "buildmap", 100);
    await new LocalScheduler(x.store, { now: () => 100 }).tick();
    x.store.resolve(x.store.operations()[0].id, "cancelled", 200);
    assert.equal(x.store.get("buildmap").state, "WAIT_HUMAN");
    assert.throws(() => x.store.arm("buildmap", 201), /승인/);
  } finally { x.cleanup(); }
});
