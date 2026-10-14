import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_INTERVAL_MINUTES = 35;
export const STATES = Object.freeze(["OBSERVING", "READY", "RUNNING", "WAIT_EXTERNAL", "WAIT_HUMAN", "BLOCKED", "COMPLETE", "UNKNOWN"]);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function nonempty(value, label, limit = 128) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit) {
    throw new Error(label + ": 1~" + limit + "자 문자열이 필요합니다.");
  }
  return value.trim();
}
function identifier(value, label) {
  const v = nonempty(value, label, 80);
  if (!IDENTIFIER.test(v)) throw new Error(label + ": 영문, 숫자, ._- 문자만 사용할 수 있습니다.");
  return v;
}
function interval(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1440) {
    throw new Error("간격은 1~1440분의 정수여야 합니다.");
  }
  return value;
}
function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("유효하지 않은 시각입니다.");
  return value;
}
function toWorkstream(row) {
  if (!row) return null;
  return { ...row, enabled: Boolean(row.enabled), paused: Boolean(row.paused) };
}

export class WorkstreamStore {
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS workstreams (",
      "id TEXT PRIMARY KEY, name TEXT NOT NULL, project_key TEXT NOT NULL, repository TEXT NOT NULL,",
      "track_key TEXT, mode TEXT NOT NULL DEFAULT 'observe' CHECK(mode IN ('observe','simulation')),",
      "state TEXT NOT NULL DEFAULT 'OBSERVING'",
      "CHECK(state IN ('OBSERVING','READY','RUNNING','WAIT_EXTERNAL','WAIT_HUMAN','BLOCKED','COMPLETE','UNKNOWN')),",
      "enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),",
      "paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),",
      "interval_minutes INTEGER NOT NULL DEFAULT 35 CHECK(interval_minutes BETWEEN 1 AND 1440),",
      "task_revision INTEGER NOT NULL DEFAULT 1,",
      "next_eligible_at INTEGER NOT NULL DEFAULT 0, last_observed_at INTEGER,",
      "last_dispatched_at INTEGER, active_operation_id TEXT,",
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS operations (",
      "id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL REFERENCES workstreams(id),",
      "task_revision INTEGER NOT NULL, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,",
      "status TEXT NOT NULL CHECK(status IN ('reserved','accepted','completed','failed','cancelled','abandoned')),",
      "started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT) STRICT;",
      "CREATE INDEX IF NOT EXISTS operations_ws_idx ON operations(workstream_id,started_at DESC);",
      "CREATE TABLE IF NOT EXISTS events (",
      "id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "workstream_id TEXT REFERENCES workstreams(id), operation_id TEXT, at INTEGER NOT NULL,",
      "kind TEXT NOT NULL, previous_state TEXT, state TEXT, reason TEXT NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS runtime_control (",
      "id INTEGER PRIMARY KEY CHECK(id=1), stopped INTEGER NOT NULL DEFAULT 0 CHECK(stopped IN (0,1)),",
      "updated_at INTEGER NOT NULL) STRICT;",
      "INSERT OR IGNORE INTO runtime_control(id,stopped,updated_at) VALUES(1,0,0);"
    ].join(" "));
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  event(id, at, kind, before, after, reason, operationId = null) {
    this.db.prepare("INSERT INTO events(workstream_id,operation_id,at,kind,previous_state,state,reason) VALUES(?,?,?,?,?,?,?)")
      .run(id, operationId, at, kind, before, after, reason);
  }
  isStopped() {
    return Boolean(this.db.prepare("SELECT stopped FROM runtime_control WHERE id=1").get().stopped);
  }
  setStopped(stopped, at = Date.now()) {
    timestamp(at);
    if (typeof stopped !== "boolean") throw new Error("전역 정지 값이 올바르지 않습니다.");
    return this.transaction(() => {
      const before = this.isStopped();
      this.db.prepare("UPDATE runtime_control SET stopped=?,updated_at=? WHERE id=1")
        .run(Number(stopped), at);
      this.event(null, at, stopped ? "global_stop" : "global_resume", null, null,
        before === stopped ? "unchanged" : "explicit_operator_action");
      return this.isStopped();
    });
  }
  get(id) {
    return toWorkstream(this.db.prepare("SELECT * FROM workstreams WHERE id=?").get(id));
  }
  mustGet(id) {
    const stream = this.get(id);
    if (!stream) throw new Error("작업축을 찾을 수 없습니다.");
    return stream;
  }
  list() {
    return this.db.prepare("SELECT * FROM workstreams ORDER BY created_at,id").all().map(toWorkstream);
  }
  operations(limit = 60) {
    return this.db.prepare("SELECT id,workstream_id,task_revision,kind,status,started_at,finished_at,result FROM operations ORDER BY started_at DESC,id DESC LIMIT ?")
      .all(Math.min(250, Math.max(1, limit)));
  }
  events(limit = 80) {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(Math.min(500, Math.max(1, limit)));
  }
  create(input, at = Date.now()) {
    timestamp(at);
    if (!input || typeof input !== "object") throw new Error("작업축 정보가 필요합니다.");
    const id = input.id ? identifier(input.id, "작업축 ID") : randomUUID();
    const name = nonempty(input.name, "작업축 이름");
    const projectKey = identifier(input.projectKey, "프로젝트 키");
    const repository = nonempty(input.repository, "저장소", 200);
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
      throw new Error("저장소는 owner/repo 형식이어야 합니다.");
    }
    const trackKey = input.trackKey ? identifier(input.trackKey, "Track Key") : null;
    const minutes = interval(input.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES);
    return this.transaction(() => {
      this.db.prepare("INSERT INTO workstreams(id,name,project_key,repository,track_key,interval_minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, name, projectKey, repository, trackKey, minutes, at, at);
      this.event(id, at, "created", null, "OBSERVING", "observe_only_by_default");
      return this.mustGet(id);
    });
  }
  deleteWorkstream(id, confirmName, at = Date.now()) {
    timestamp(at);
    return this.transaction(() => {
      const stream = this.mustGet(id);
      if (confirmName !== stream.name)
        throw new Error("DELETE_CONFIRM_NAME_MISMATCH");
      if (stream.active_operation_id || ["RUNNING","WAIT_EXTERNAL"].includes(stream.state))
        throw new Error("DELETE_WORKSTREAM_ACTIVE_OPERATION");
      const pending = this.db.prepare(
        "SELECT id FROM chat_continuation_commands WHERE workstream_id=? AND state='claimed' LIMIT 1"
      ).get(id);
      if (pending) throw new Error("DELETE_WORKSTREAM_COMMAND_IN_FLIGHT");
      const activePlan = this.db.prepare(
        "SELECT id FROM execution_plans WHERE workstream_id=? AND status IN ('running','waiting') LIMIT 1"
      ).get(id);
      if (activePlan) throw new Error("DELETE_WORKSTREAM_ACTIVE_PLAN");
      // Every dependent local table is removed in this same transaction.
      // Discover FKs rather than forgetting a newly added per-workstream table.
      // Non-FK companion state must not be deleted speculatively.
      const tables = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).all();
      for (const {name} of tables) {
        if(name==="workstreams" || !/^[a-zA-Z0-9_]+$/.test(name)) continue;
        const refs=this.db.prepare('PRAGMA foreign_key_list("'+name+'")').all();
        const direct=refs.filter(ref=>ref.table==="workstreams");
        if (!direct.length) continue;
        if (direct.length!==1 || direct[0].from!=="workstream_id")
          throw new Error("DELETE_UNSUPPORTED_WORKSTREAM_DEPENDENCY");
        this.db.prepare('DELETE FROM "'+name+'" WHERE workstream_id=?').run(id);
      }
      this.db.prepare("DELETE FROM workstreams WHERE id=?").run(id);
      return { deleted:true,id,name:stream.name };
    });
  }

  configure(id, input, at = Date.now()) {
    timestamp(at);
    if (!input || typeof input !== "object") throw new Error("설정 정보가 없습니다.");
    if (Object.keys(input).some(k => !["mode", "intervalMinutes", "enabled", "paused"].includes(k))) {
      throw new Error("지원하지 않는 설정 필드입니다.");
    }
    return this.transaction(() => {
      const old = this.mustGet(id);
      const mode = input.mode ?? old.mode;
      if (!["observe", "simulation"].includes(mode)) throw new Error("지원하지 않는 실행 모드입니다.");
      const minutes = interval(input.intervalMinutes ?? old.interval_minutes);
      for (const field of ["enabled", "paused"]) {
        if (input[field] !== undefined && typeof input[field] !== "boolean") {
          throw new Error(field + "는 boolean이어야 합니다.");
        }
      }
      const enabled = input.enabled ?? old.enabled;
      const paused = input.paused ?? old.paused;
      this.db.prepare("UPDATE workstreams SET mode=?,interval_minutes=?,enabled=?,paused=?,updated_at=? WHERE id=?")
        .run(mode, minutes, Number(enabled), Number(paused), at, id);
      this.event(id, at, "configured", old.state, old.state,
        "mode=" + mode + ";interval=" + minutes + ";enabled=" + enabled + ";paused=" + paused);
      return this.mustGet(id);
    });
  }
  arm(id, at = Date.now()) {
    timestamp(at);
    return this.transaction(() => {
      const old = this.mustGet(id);
      if (old.active_operation_id || ["RUNNING", "WAIT_EXTERNAL"].includes(old.state)) {
        throw new Error("미완료 실행이 존재합니다. 먼저 결과를 확인하십시오.");
      }
      if (old.state === "WAIT_HUMAN") {
        throw new Error("사용자 승인 대기를 우회할 수 없습니다.");
      }
      if (old.state === "READY") return old;
      const revision = old.state === "OBSERVING" ? old.task_revision : old.task_revision + 1;
      this.db.prepare("UPDATE workstreams SET state='READY',task_revision=?,next_eligible_at=?,updated_at=? WHERE id=?")
        .run(revision, at, at, id);
      this.event(id, at, "armed", old.state, "READY", "manually_approved_simulation");
      return this.mustGet(id);
    });
  }
  approveHumanGate(id, at = Date.now()) {
    timestamp(at);
    return this.transaction(() => {
      const old = this.mustGet(id);
      if (old.state !== "WAIT_HUMAN" || old.active_operation_id) {
        throw new Error("승인할 수 있는 대기 작업이 없습니다.");
      }
      this.db.prepare("UPDATE workstreams SET state='READY',task_revision=?,next_eligible_at=?,updated_at=? WHERE id=?")
        .run(old.task_revision + 1, at, at, id);
      this.event(id, at, "human_approved", "WAIT_HUMAN", "READY",
        "explicit_operator_simulation_approval");
      return this.mustGet(id);
    });
  }
  observeDue(id, at = Date.now()) {
    timestamp(at);
    return this.transaction(() => {
      const old = this.mustGet(id);
      if (this.isStopped() || !old.enabled || old.paused || old.mode !== "observe" ||
          !["OBSERVING", "READY"].includes(old.state) || at < old.next_eligible_at) return null;
      const next = at + old.interval_minutes * 60_000;
      this.db.prepare("UPDATE workstreams SET last_observed_at=?,next_eligible_at=?,updated_at=? WHERE id=?")
        .run(at, next, at, id);
      this.event(id, at, "observed", old.state, old.state, "observe_only_no_execution");
      return { kind: "observed", workstreamId: id, nextEligibleAt: next };
    });
  }
  claimDue(id, at = Date.now()) {
    timestamp(at);
    return this.transaction(() => {
      const old = this.mustGet(id);
      if (this.isStopped() || !old.enabled || old.paused || old.mode !== "simulation" || old.state !== "READY" ||
          old.active_operation_id || at < old.next_eligible_at) return null;
      const dedupeKey = old.id + ":" + old.task_revision + ":SIMULATE";
      if (this.db.prepare("SELECT id FROM operations WHERE dedupe_key=?").get(dedupeKey)) return null;
      const operationId = randomUUID();
      this.db.prepare("INSERT INTO operations(id,workstream_id,task_revision,kind,dedupe_key,status,started_at) VALUES(?,?,?,'SIMULATE',?,'reserved',?)")
        .run(operationId, id, old.task_revision, dedupeKey, at);
      this.db.prepare("UPDATE workstreams SET state='RUNNING',active_operation_id=?,last_dispatched_at=?,last_observed_at=?,next_eligible_at=?,updated_at=? WHERE id=?")
        .run(operationId, at, at, at + old.interval_minutes * 60_000, at, id);
      this.event(id, at, "claimed", old.state, "RUNNING", "simulation_only", operationId);
      return { operationId, workstreamId: id, taskRevision: old.task_revision, kind: "SIMULATE" };
    });
  }
  acknowledged(operationId, at = Date.now()) {
    timestamp(at);
    return this.transaction(() => {
      const op = this.db.prepare("SELECT * FROM operations WHERE id=?").get(operationId);
      if (!op) throw new Error("실행 기록이 없습니다.");
      const old = this.mustGet(op.workstream_id);
      if (old.active_operation_id !== operationId || op.status !== "reserved") {
        throw new Error("이미 처리된 실행 기록입니다.");
      }
      this.db.prepare("UPDATE operations SET status='accepted' WHERE id=?").run(operationId);
      this.db.prepare("UPDATE workstreams SET state='WAIT_EXTERNAL',updated_at=? WHERE id=?")
        .run(at, old.id);
      this.event(old.id, at, "accepted", old.state, "WAIT_EXTERNAL",
        "mock_acknowledged_no_real_result", operationId);
      return this.mustGet(old.id);
    });
  }
  resolve(operationId, outcome, at = Date.now()) {
    timestamp(at);
    if (!["completed", "failed", "cancelled", "abandoned"].includes(outcome)) {
      throw new Error("알 수 없는 결과입니다.");
    }
    const nextState = { completed: "COMPLETE", failed: "BLOCKED", cancelled: "WAIT_HUMAN", abandoned: "UNKNOWN" }[outcome];
    return this.transaction(() => {
      const op = this.db.prepare("SELECT * FROM operations WHERE id=?").get(operationId);
      if (!op) throw new Error("실행 기록이 없습니다.");
      const old = this.mustGet(op.workstream_id);
      if (old.active_operation_id !== operationId ||
          !["reserved", "accepted"].includes(op.status)) {
        throw new Error("이미 처리된 실행 또는 다른 작업축의 실행입니다.");
      }
      this.db.prepare("UPDATE operations SET status=?,finished_at=?,result=? WHERE id=?")
        .run(outcome, at, "manual_simulation_" + outcome, operationId);
      this.db.prepare("UPDATE workstreams SET state=?,active_operation_id=NULL,updated_at=? WHERE id=?")
        .run(nextState, at, old.id);
      this.event(old.id, at, "resolved", old.state, nextState,
        "manual_simulation_" + outcome + "_not_github_verified", operationId);
      return this.mustGet(old.id);
    });
  }
  recoverInFlight(at = Date.now()) {
    timestamp(at);
    return this.transaction(() => {
      const pending = this.db.prepare("SELECT id,state,active_operation_id FROM workstreams WHERE state='RUNNING'").all();
      for (const stream of pending) {
        this.db.prepare("UPDATE workstreams SET state='UNKNOWN',updated_at=? WHERE id=?").run(at, stream.id);
        this.event(stream.id, at, "recovery", "RUNNING", "UNKNOWN",
          "restart_requires_manual_reconciliation", stream.active_operation_id);
      }
      return pending.length;
    });
  }
}
