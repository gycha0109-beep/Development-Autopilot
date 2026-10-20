import {createHash} from "node:crypto";

export const CI_WAIT_TIMEOUT_MS=30*60_000;
export const CI_UNKNOWN_TIMEOUT_MS=5*60_000;
export function ciWaitIdentity({workstream,observation,ci}){
  const id=workstream.id;
  return createHash("sha256").update(JSON.stringify([1,id,workstream.task_revision,
    workstream.repository,workstream.project_key,workstream.track_key,
    observation?.bindingFingerprint,observation?.replyFingerprint,
    (ci.watchtower?.targets||[]).filter(t=>t.workstreamId===id),
    (ci.github?.targets||[]).filter(t=>t.workstreamId===id)])).digest("hex");
}
export function ciWaitTimeout(args,unknown){
  const wait=args.ci.wait;
  if(!wait||wait.fingerprint!==ciWaitIdentity(args))return null;
  const elapsed=at=>Number.isSafeInteger(at)&&at>=0&&at<=args.now?args.now-at:0;
  if(unknown&&wait.unknownSince!==null&&elapsed(wait.unknownSince)>=CI_UNKNOWN_TIMEOUT_MS)
    return "CI_QUERY_UNAVAILABLE_TOO_LONG";
  return elapsed(wait.startedAt)>=CI_WAIT_TIMEOUT_MS?"CI_WAIT_TOO_LONG":null;
}

// Each episode is retained; restarting or polling does not reset a deadline.
export class CIWaitLedger {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS autopilot_ci_waits(
      id INTEGER PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id),
      fingerprint TEXT NOT NULL,started_at INTEGER NOT NULL,unknown_since INTEGER,
      ended_at INTEGER,end_reason TEXT) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS autopilot_ci_wait_active
      ON autopilot_ci_waits(workstream_id) WHERE ended_at IS NULL;`);
  }
  current(id){return this.db.prepare(`SELECT fingerprint,started_at AS startedAt,
    unknown_since AS unknownSince FROM autopilot_ci_waits WHERE workstream_id=? AND ended_at IS NULL`).get(id)||null;}
  finish(id,now,reason){
    this.db.prepare("UPDATE autopilot_ci_waits SET ended_at=?,end_reason=? WHERE workstream_id=? AND ended_at IS NULL")
      .run(now,reason,id);
  }
  record(args,unknown){
    const id=args.workstream.id,fingerprint=ciWaitIdentity(args),now=args.now;
    return this.store.transaction(()=>{
      const old=this.current(id);
      if(old?.fingerprint!==fingerprint){
        this.finish(id,now,"CI_CONTEXT_CHANGED");
        this.db.prepare(`INSERT INTO autopilot_ci_waits(workstream_id,fingerprint,started_at,unknown_since)
          VALUES(?,?,?,?)`).run(id,fingerprint,now,unknown?now:null);
        this.store.event(id,now,"ci_wait_started",null,null,unknown?"CI_QUERY_UNVERIFIED":"CI_PENDING");
      }else{
        this.db.prepare("UPDATE autopilot_ci_waits SET unknown_since=? WHERE workstream_id=? AND ended_at IS NULL")
          .run(unknown?(old.unknownSince??now):null,id);
      }
      return this.current(id);
    });
  }
}
