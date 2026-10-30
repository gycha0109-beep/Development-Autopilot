export const PORTABLE_WORKSTREAM_LIMIT = 100;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function canonical(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.name !== "string" || !item.name.trim() || item.name.length > 128 ||
      typeof item.projectKey !== "string" || !IDENT.test(item.projectKey) ||
      typeof item.repository !== "string" || !REPO.test(item.repository) ||
      (item.trackKey != null && !IDENT.test(item.trackKey)) ||
      !Number.isInteger(item.intervalMinutes) ||
      item.intervalMinutes < 1 || item.intervalMinutes > 1440 ||
      typeof item.enabled !== "boolean" || typeof item.paused !== "boolean" ||
      (item.sessionKey != null &&
        (typeof item.sessionKey !== "string" || !IDENT.test(item.sessionKey)))) {
    throw Error("INVALID_PORTABLE_WORKSTREAM");
  }
  return {
    name: item.name.trim(), projectKey: item.projectKey, repository: item.repository,
    trackKey: item.trackKey ?? null, intervalMinutes: item.intervalMinutes,
    enabled: item.enabled, paused: item.paused, sessionKey: item.sessionKey ?? null
  };
}

export class PortableWorkstreamConfig {
  constructor(store, bridge) {
    this.store = store;
    this.bridge = bridge;
    this.db = store.db;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS portable_link_intents (",
      "extension_id TEXT NOT NULL,workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,",
      "session_key TEXT NOT NULL,created_at INTEGER NOT NULL,",
      "PRIMARY KEY(extension_id,workstream_id)) STRICT;"
    ].join(" "));
  }

  export(extensionId) {
    const links = this.bridge.getSnapshot().links.filter(l => l.extensionId === extensionId);
    return {
      workstreams: this.store.list().map(w => {
        const link = links.find(l => l.workstreamId === w.id);
        return {
          name: w.name, projectKey: w.project_key,
          repository: w.repository, trackKey: w.track_key,
          intervalMinutes: w.interval_minutes,
          enabled: w.enabled, paused: w.paused,
          sessionKey: link?.sessionKey ?? null
        };
      })
    };
  }

  import(extensionId, items) {
    if (!Array.isArray(items) || items.length > PORTABLE_WORKSTREAM_LIMIT)
      throw Error("INVALID_PORTABLE_WORKSTREAM_LIST");
    const safe = items.map(canonical);
    if (new Set(safe.map(w => w.repository + "#" + (w.trackKey ?? ""))).size !== safe.length)
      throw Error("DUPLICATE_PORTABLE_WORKSTREAM");
    let created = 0;
    let existing = 0;
    let pending = 0;
    let linked = 0;
    for (const item of safe) {
      const matches = this.store.list().filter(w =>
        w.repository === item.repository && (w.track_key ?? null) === item.trackKey);
      if (matches.length > 1) throw Error("AMBIGUOUS_EXISTING_WORKSTREAM");
      let workstream = matches[0];
      if (!workstream) {
        workstream = this.store.create({
          name: item.name, projectKey: item.projectKey,
          repository: item.repository, trackKey: item.trackKey,
          intervalMinutes: item.intervalMinutes
        });
        if (!item.enabled || item.paused) {
          this.store.configure(workstream.id, {enabled:item.enabled,paused:item.paused});
        }
        created++;
      } else {
        existing++;
      }
      if (!item.sessionKey) continue;
      const occupied = this.bridge.getSnapshot().links.some(l =>
        l.workstreamId === workstream.id);
      if (occupied) continue;
      this.db.prepare(
        "INSERT INTO portable_link_intents(extension_id,workstream_id,session_key,created_at) " +
        "VALUES(?,?,?,?) ON CONFLICT(extension_id,workstream_id) DO UPDATE SET " +
        "session_key=excluded.session_key,created_at=excluded.created_at"
      ).run(extensionId,workstream.id,item.sessionKey,Date.now());
      pending++;
    }
    linked = this.reconcile(extensionId);
    return {created,existing,pending,linked};
  }

  reconcile(extensionId) {
    const rows = this.db.prepare(
      "SELECT workstream_id,session_key FROM portable_link_intents WHERE extension_id=?"
    ).all(extensionId);
    const snap = this.bridge.getSnapshot();
    let linked = 0;
    for (const intent of rows) {
      const occupied = snap.links.some(l => l.workstreamId === intent.workstream_id);
      if (occupied) {
        this.db.prepare("DELETE FROM portable_link_intents WHERE extension_id=? AND workstream_id=?")
          .run(extensionId,intent.workstream_id);
        continue;
      }
      const connected = snap.sessions.filter(s => s.extensionId === extensionId &&
        s.sessionKey === intent.session_key && s.status === "connected");
      if (connected.length !== 1) continue;
      const used = snap.links.some(l => l.extensionId === extensionId &&
        l.sessionKey === intent.session_key);
      if (used) continue;
      try {
        this.bridge.link(intent.workstream_id,extensionId,intent.session_key);
        this.db.prepare("DELETE FROM portable_link_intents WHERE extension_id=? AND workstream_id=?")
          .run(extensionId,intent.workstream_id);
        linked++;
        snap.links.push({workstreamId:intent.workstream_id,extensionId,sessionKey:intent.session_key});
      } catch {
        // Leave the intent pending. Never guess or override another workstream's link.
      }
    }
    return linked;
  }
}
