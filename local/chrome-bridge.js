import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const BRIDGE_TTL_MS = 150_000;
export const REQUIRED_COMPOSER_BUILD = "composer-2026-10-14-r14";
export const PAIR_TTL_MS = 5 * 60_000;
export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const STATUSES = new Set(["connected", "missing", "needs-rebind", "url-changed", "paused"]);
const digest = input => createHash("sha256").update(input).digest("hex");
const nonempty = (str, max) => typeof str === "string" && str.length > 0 && str.length <= max;
const safeText = (v, max) => typeof v === "string" ? v.slice(0, max) : "";

export class ChromeBridge {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS chrome_pairing (",
      "id INTEGER PRIMARY KEY CHECK(id=1), code_hash TEXT NOT NULL,",
      "expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0) STRICT;",
      "CREATE TABLE IF NOT EXISTS chrome_clients (",
      "extension_id TEXT PRIMARY KEY,token_hash TEXT NOT NULL,",
      "paired_at INTEGER NOT NULL,last_seen_at INTEGER,composer_build TEXT) STRICT;",
      "CREATE TABLE IF NOT EXISTS chrome_sessions (",
      "extension_id TEXT NOT NULL REFERENCES chrome_clients(extension_id) ON DELETE CASCADE,",
      "session_key TEXT NOT NULL,group_key TEXT NOT NULL,",
      "group_label TEXT NOT NULL,title TEXT NOT NULL,origin TEXT NOT NULL,",
      "status TEXT NOT NULL,reported_at INTEGER NOT NULL,",
      "PRIMARY KEY(extension_id,session_key)) STRICT;",
      "CREATE TABLE IF NOT EXISTS workstream_chrome_links (",
      "workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,",
      "extension_id TEXT NOT NULL,session_key TEXT NOT NULL,linked_at INTEGER NOT NULL,",
      "UNIQUE(extension_id,session_key),",
      "FOREIGN KEY(extension_id,session_key) REFERENCES chrome_sessions(extension_id,session_key)",
      "ON DELETE RESTRICT) STRICT;",
      "CREATE TABLE IF NOT EXISTS migration_watch_revocations (",
      "extension_id TEXT NOT NULL REFERENCES chrome_clients(extension_id) ON DELETE CASCADE,",
      "session_key TEXT NOT NULL,created_at INTEGER NOT NULL,",
      "PRIMARY KEY(extension_id,session_key)) STRICT;"
    ].join(" "));
    const columns=this.db.prepare("PRAGMA table_info(chrome_clients)").all();
    if(!columns.some(column=>column.name==="composer_build")){
      this.db.exec("ALTER TABLE chrome_clients ADD COLUMN composer_build TEXT");
    }
  }

  beginPairing(now = Date.now()) {
    const code = randomBytes(10).toString("hex").toUpperCase();
    this.store.transaction(() => {
      this.db.prepare(
        "INSERT INTO chrome_pairing(id,code_hash,expires_at,attempts) VALUES(1,?,?,0) " +
        "ON CONFLICT(id) DO UPDATE SET code_hash=excluded.code_hash," +
        "expires_at=excluded.expires_at,attempts=0"
      ).run(digest(code), now + PAIR_TTL_MS);
      this.store.event(null, now, "bridge_pairing_started", null, null, "one_time_code_created");
    });
    return { code, expiresAt: now + PAIR_TTL_MS };
  }

  pair(origin, code, now = Date.now()) {
    if (!EXTENSION_ORIGIN.test(origin)) throw new Error("Chrome 확장 프로그램에서만 페어링할 수 있습니다.");
    if (!nonempty(code, 60)) throw new Error("페어링 코드를 입력하십시오.");
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM chrome_pairing WHERE id=1").get();
      if (!row || now > row.expires_at || row.attempts >= 5) {
        throw new Error("페어링 코드가 없거나 만료되었습니다.");
      }
      // Increment failed attempts without rolling back the failed comparison.
      const candidate = Buffer.from(digest(code.trim().toUpperCase()), "hex");
      const expected = Buffer.from(row.code_hash, "hex");
      if (!timingSafeEqual(candidate, expected)) {
        this.db.prepare("UPDATE chrome_pairing SET attempts=attempts+1 WHERE id=1").run();
        return { ok: false };
      }
      const extensionId = origin.slice("chrome-extension://".length);
      const secret = randomBytes(32).toString("base64url");
      this.db.prepare("DELETE FROM workstream_chrome_links WHERE extension_id=?").run(extensionId);
      this.db.prepare("DELETE FROM chrome_sessions WHERE extension_id=?").run(extensionId);
      this.db.prepare(
        "INSERT INTO chrome_clients(extension_id,token_hash,paired_at,last_seen_at,composer_build) " +
        "VALUES(?,?,?,NULL,NULL) ON CONFLICT(extension_id) DO UPDATE SET " +
        "token_hash=excluded.token_hash,paired_at=excluded.paired_at,last_seen_at=NULL,composer_build=NULL"
      ).run(extensionId, digest(secret), now);
      this.db.prepare("DELETE FROM chrome_pairing WHERE id=1").run();
      this.store.event(null, now, "bridge_paired", null, null, "extension_registered");
      return { ok: true, token: secret };
    });
  }

  authenticate(origin, token) {
    if (!EXTENSION_ORIGIN.test(origin) || !nonempty(token, 256)) return null;
    const extensionId = origin.slice("chrome-extension://".length);
    const row = this.db.prepare("SELECT token_hash FROM chrome_clients WHERE extension_id=?").get(extensionId);
    if (!row) return null;
    return timingSafeEqual(Buffer.from(digest(token), "hex"), Buffer.from(row.token_hash, "hex"))
      ? extensionId : null;
  }

  sync(extensionId, payload, now = Date.now()) {
    if (!payload || payload.version !== 1 || !Array.isArray(payload.sessions) ||
        payload.sessions.length > 150) {
      throw new Error("지원하지 않는 Chrome 상태 포맷입니다.");
    }
    const watched=payload.migrationWatchSessionKeys;
    if(watched!==undefined &&
       (!Array.isArray(watched)||watched.length>150||
        watched.some(key=>!nonempty(key,80)||!IDENTIFIER.test(key))||
        new Set(watched).size!==watched.length))
      throw Error("잘못된 자동 이관 감시 목록입니다.");
    const seen = new Set();
    const validated = payload.sessions.map(item => {
      if (!item || !nonempty(item.sessionKey, 80) || !IDENTIFIER.test(item.sessionKey) ||
          !nonempty(item.groupKey, 80) || !IDENTIFIER.test(item.groupKey) ||
          !STATUSES.has(item.status) || seen.has(item.sessionKey)) {
        throw new Error("등록된 탭 목록이 올바르지 않습니다.");
      }
      seen.add(item.sessionKey);
      const origin = safeText(item.origin, 180);
      if (origin && origin !== "null" && !/^https?:\/\/[a-zA-Z0-9._:-]+$/.test(origin)) {
        throw new Error("탭 Origin 형식이 잘못되었습니다.");
      }
      return {
        sessionKey: item.sessionKey, groupKey: item.groupKey,
        groupLabel: safeText(item.groupLabel, 120), title: safeText(item.title, 200),
        origin, status: item.status
      };
    });
    return this.store.transaction(() => {
      const client = this.db.prepare("SELECT extension_id FROM chrome_clients WHERE extension_id=?")
        .get(extensionId);
      if (!client) throw new Error("페어링되지 않은 확장 프로그램입니다.");
      const insert = this.db.prepare(
        "INSERT INTO chrome_sessions " +
        "(extension_id,session_key,group_key,group_label,title,origin,status,reported_at) " +
        "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(extension_id,session_key) DO UPDATE SET " +
        "group_key=excluded.group_key,group_label=excluded.group_label," +
        "title=excluded.title,origin=excluded.origin,status=excluded.status," +
        "reported_at=excluded.reported_at"
      );
      for (const s of validated) insert.run(
        extensionId,s.sessionKey,s.groupKey,s.groupLabel,s.title,s.origin,s.status,now
      );
      // Keep historical IDs for a bound workstream, marking removal as missing.
      // Never remap the workstream merely because a new tab has the same URL.
      this.db.prepare(
        "UPDATE chrome_sessions SET status='missing',reported_at=? " +
        "WHERE extension_id=? AND session_key NOT IN (SELECT value FROM json_each(?))"
      ).run(now, extensionId, JSON.stringify(validated.map(s => s.sessionKey)));
      const build=payload.composerBuild===REQUIRED_COMPOSER_BUILD?REQUIRED_COMPOSER_BUILD:null;
      this.db.prepare("UPDATE chrome_clients SET last_seen_at=?,composer_build=? WHERE extension_id=?")
        .run(now,build,extensionId);
      const revoked=this.db.prepare(
        "SELECT session_key FROM migration_watch_revocations WHERE extension_id=?"
      ).all(extensionId).map(x=>x.session_key);
      // The extension acknowledges cleanup on its *next* sync by omitting
      // removed watch keys. Do not drop revocations after an unconfirmed send.
      if(watched!==undefined){
        for(const key of revoked.filter(key=>!watched.includes(key))){
          this.db.prepare(
            "DELETE FROM migration_watch_revocations WHERE extension_id=? AND session_key=?"
          ).run(extensionId,key);
        }
      }
      return {accepted:validated.length,observedAt:now,
        revokedWatchSessionKeys:watched===undefined?revoked:
          revoked.filter(key=>watched.includes(key))};
    });
  }

  unpair(extensionId, now = Date.now()) {
    return this.store.transaction(() => {
      this.db.prepare("DELETE FROM workstream_chrome_links WHERE extension_id=?").run(extensionId);
      this.db.prepare("DELETE FROM chrome_clients WHERE extension_id=?").run(extensionId);
      this.store.event(null, now, "bridge_unpaired", null, null, "explicit_operator_action");
    });
  }

  link(workstreamId, extensionId, sessionKey, now = Date.now()) {
    return this.store.transaction(() => {
      this.store.mustGet(workstreamId);
      if (sessionKey === null) {
        this.db.prepare("DELETE FROM workstream_chrome_links WHERE workstream_id=?").run(workstreamId);
        this.store.event(workstreamId, now, "chrome_unlinked", null, null, "operator_unlinked");
        return;
      }
      const session = this.db.prepare(
        "SELECT cs.*,cc.last_seen_at FROM chrome_sessions cs JOIN chrome_clients cc " +
        "USING(extension_id) WHERE cs.extension_id=? AND cs.session_key=?"
      ).get(extensionId,sessionKey);
      if (!session || !this.isFresh(session, now) || session.status !== "connected") {
        throw new Error("선택한 탭이 연결되지 않았거나 상태가 오래되었습니다.");
      }
      this.db.prepare(
        "INSERT INTO workstream_chrome_links(workstream_id,extension_id,session_key,linked_at) " +
        "VALUES(?,?,?,?) ON CONFLICT(workstream_id) DO UPDATE SET " +
        "extension_id=excluded.extension_id,session_key=excluded.session_key,linked_at=excluded.linked_at"
      ).run(workstreamId,extensionId,sessionKey,now);
      // A newly approved link supersedes an unacknowledged revocation for
      // the same exact tab; never revoke the replacement workstream's watch.
      this.db.prepare(
        "DELETE FROM migration_watch_revocations WHERE extension_id=? AND session_key=?"
      ).run(extensionId,sessionKey);
      this.store.event(workstreamId, now, "chrome_linked", null, null, "operator_confirmed_mapping");
    });
  }

  isFresh(row, now) {
    return Number.isSafeInteger(row.last_seen_at) &&
      now - row.last_seen_at <= BRIDGE_TTL_MS &&
      now - row.last_seen_at >= -5000;
  }

  getSnapshot(now = Date.now()) {
    const clients = this.db.prepare(
      "SELECT extension_id,paired_at,last_seen_at,composer_build FROM chrome_clients ORDER BY paired_at"
    ).all();
    const sessions = this.db.prepare(
      "SELECT cs.extension_id,cs.session_key,cs.group_key,cs.group_label,cs.title," +
      "cs.origin,cs.status,cs.reported_at,cc.last_seen_at " +
      "FROM chrome_sessions cs JOIN chrome_clients cc USING(extension_id) " +
      "ORDER BY cs.title,cs.session_key"
    ).all().map(s => ({
      extensionId: s.extension_id, sessionKey: s.session_key,
      groupKey: s.group_key, groupLabel: s.group_label,
      title: s.title, origin: s.origin,
      status: this.isFresh(s, now) ? s.status : "stale",
      reportedAt: s.reported_at
    }));
    const links = this.db.prepare(
      "SELECT l.workstream_id,l.extension_id,l.session_key,l.linked_at," +
      "cs.title,cs.status,cs.reported_at,cc.last_seen_at " +
      "FROM workstream_chrome_links l LEFT JOIN chrome_sessions cs " +
      "ON cs.extension_id=l.extension_id AND cs.session_key=l.session_key " +
      "LEFT JOIN chrome_clients cc ON cc.extension_id=l.extension_id " +
      "ORDER BY l.workstream_id"
    ).all().map(l => ({
      workstreamId: l.workstream_id, extensionId: l.extension_id,
      sessionKey: l.session_key, linkedAt: l.linked_at, title: l.title || "",
      status: !l.status ? "missing" : this.isFresh(l, now) ? l.status : "stale"
    }));
    return {
      version: 1, ttlMs: BRIDGE_TTL_MS,
      clients: clients.map(c => ({
        extensionId: c.extension_id, pairedAt: c.paired_at, lastSeenAt: c.last_seen_at,
        composerBuild: c.composer_build || null,
        status: c.last_seen_at && now-c.last_seen_at <= BRIDGE_TTL_MS ? "online" : "offline"
      })),
      sessions, links
    };
  }
}
