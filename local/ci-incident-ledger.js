// Persistent advisory CI failure / blocker ledger. The ledger cannot send
// prompts, retry CI, approve a change, or deliver an external notification.
import {createHash} from "node:crypto";

const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SHA=/^[a-f0-9]{40}$/;
const EVIDENCE=/^[a-f0-9]{64}$/;
const CODE=/^[A-Z][A-Z0-9_]{1,99}$/;

export class CiIncidentLedger {
  constructor(store,{inbox=null,now=()=>Date.now(),maxRetries=2,threshold=3}={}){
    if(!Number.isInteger(maxRetries)||maxRetries<1||maxRetries>5||
       !Number.isInteger(threshold)||threshold<1||threshold>20)throw Error("INVALID_CI_INCIDENT_POLICY");
    this.store=store;this.db=store.db;this.inbox=inbox;this.now=now;
    this.maxRetries=maxRetries;this.threshold=threshold;
    this.db.exec(`CREATE TABLE IF NOT EXISTS ci_failure_incidents(
      workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,task_revision INTEGER NOT NULL,
      failed_checks TEXT NOT NULL,pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,evidence_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
      state TEXT NOT NULL CHECK(state IN ('open','resolved')),
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      PRIMARY KEY(workstream_id,fingerprint)) STRICT;
      CREATE TABLE IF NOT EXISTS ci_repair_receipts(
      operation_id TEXT PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,evidence_hash TEXT NOT NULL,recorded_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS ci_blockers(
      workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      blocker_key TEXT NOT NULL,reason_code TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('normal','critical')),
      state TEXT NOT NULL CHECK(state IN ('open','resolved')),
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      PRIMARY KEY(workstream_id,blocker_key)) STRICT;
      CREATE TABLE IF NOT EXISTS ci_alert_outbox(
      alert_key TEXT PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      event_kind TEXT NOT NULL,reason_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','unknown')),
      created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS ci_pause_episodes(
      workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,
      episode INTEGER NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;`);
  }
  incident(id,fingerprint){
    return this.db.prepare("SELECT * FROM ci_failure_incidents WHERE workstream_id=? AND fingerprint=?").get(id,fingerprint)||null;
  }
  count(id){
    const blockers=this.db.prepare("SELECT count(*) AS n FROM ci_blockers WHERE workstream_id=? AND state='open'").get(id).n;
    const pending=this.db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='operator_requests'`).get().n?
      this.db.prepare(`SELECT count(*) AS n FROM operator_requests WHERE workstream_id=? AND state IN ('pending','held') AND expires_at>?`).get(id,this.now()).n:0;
    const critical=this.db.prepare("SELECT count(*) AS n FROM ci_blockers WHERE workstream_id=? AND state='open' AND severity='critical'").get(id).n;
    return {blockers,approvals:pending,open:blockers+pending,critical};
  }
  holdIfNeeded(id){
    const counts=this.count(id);
    const episode=this.db.prepare("SELECT episode,active FROM ci_pause_episodes WHERE workstream_id=?").get(id);
    if(counts.open<this.threshold && counts.critical===0){
      if(episode?.active===1)this.db.prepare("UPDATE ci_pause_episodes SET active=0 WHERE workstream_id=?").run(id);
      return {paused:false,...counts};
    }
    const at=this.now(),wasPaused=this.store.mustGet(id).paused;
    this.db.prepare("UPDATE workstreams SET paused=1,updated_at=? WHERE id=? AND paused=0").run(at,id);
    if(episode?.active===1)return {paused:true,alertKey:hash([id,"ci-supervision-stop",episode.episode]),...counts};
    const nextEpisode=(episode?.episode||0)+1,key=hash([id,"ci-supervision-stop",nextEpisode]);
    this.db.prepare(`INSERT INTO ci_pause_episodes(workstream_id,episode,active) VALUES(?,?,1)
      ON CONFLICT(workstream_id) DO UPDATE SET episode=excluded.episode,active=1`).run(id,nextEpisode);
    this.db.prepare(`INSERT OR IGNORE INTO ci_alert_outbox
      (alert_key,workstream_id,event_kind,reason_code,status,created_at)
      VALUES(?,?,?,?,'pending',?)`).run(key,id,"workstream-paused",
        counts.critical>0?"CRITICAL_BLOCKER":"OPEN_ITEMS_THRESHOLD",at);
    if(!wasPaused)this.store.event(id,at,"ci_supervision_paused",null,null,
      counts.critical>0?"CRITICAL_BLOCKER":"OPEN_ITEMS_THRESHOLD");
    return {paused:true,alertKey:key,...counts};
  }
  addBlocker(id,{reasonCode,evidenceKey,severity="normal"}){
    this.store.mustGet(id);
    if(!CODE.test(reasonCode)||typeof evidenceKey!=="string"||!evidenceKey||evidenceKey.length>150||
      !["normal","critical"].includes(severity))throw Error("INVALID_CI_BLOCKER");
    const key=hash([id,reasonCode,evidenceKey]),at=this.now();
    return this.store.transaction(()=>{
      this.db.prepare(`INSERT INTO ci_blockers(workstream_id,blocker_key,reason_code,severity,state,created_at,updated_at)
        VALUES(?,?,?,?,'open',?,?) ON CONFLICT(workstream_id,blocker_key) DO UPDATE SET
        state='open',updated_at=excluded.updated_at`).run(id,key,reasonCode,severity,at,at);
      return {blockerKey:key,...this.holdIfNeeded(id)};
    });
  }
  resolveBlocker(id,key){
    this.store.mustGet(id);
    if(!EVIDENCE.test(key))throw Error("INVALID_CI_BLOCKER");
    this.db.prepare("UPDATE ci_blockers SET state='resolved',updated_at=? WHERE workstream_id=? AND blocker_key=?")
      .run(this.now(),id,key);
    this.holdIfNeeded(id);
    // Never auto-unpause. An operator must recheck the CI and approval gates.
    return this.count(id);
  }
  failedChecks(progress){
    const all=[...(progress.ordinaryChecks||[]),...(progress.integrationChecks||[])];
    const failed=all.filter(x=>x.state==="FAILURE").map(x=>x.name);
    const run=progress.observedIntegrationRun;
    if(run?.state==="RED"&&Number.isSafeInteger(run.runId)&&run.runId>0)
      failed.push("Integration Run #"+run.runId);
    return [...new Set(failed)].sort();
  }
  observe(progress){
    const id=progress?.workstreamId;
    if(typeof id!=="string"||!id)return {state:"IGNORED"};
    const ws=this.store.mustGet(id);
    if(progress.state==="UNKNOWN"||progress.state==="PENDING"||progress.verified!==true||
       !SHA.test(progress.headSha||"")||!EVIDENCE.test(progress.evidenceHash||""))
      return {state:"UNCHANGED",counts:this.count(id)};
    return this.store.transaction(()=>{
      if(progress.state==="GREEN"){
        const at=this.now();
        this.db.prepare("UPDATE ci_failure_incidents SET state='resolved',updated_at=? WHERE workstream_id=? AND state='open'").run(at,id);
        // Only auto-generated CI retry blockers; never clear unrelated/manual requests.
        const incidents=this.db.prepare("SELECT fingerprint FROM ci_failure_incidents WHERE workstream_id=?").all(id);
        for(const incident of incidents){
          this.db.prepare("UPDATE ci_blockers SET state='resolved',updated_at=? WHERE workstream_id=? AND blocker_key=? AND state='open'")
            .run(at,id,hash([id,"CI_RETRY_EXHAUSTED",incident.fingerprint]));
        }
        this.holdIfNeeded(id);
        return {state:"GREEN",counts:this.count(id)};
      }
      if(progress.state!=="RED")return {state:"UNCHANGED",counts:this.count(id)};
      const checks=this.failedChecks(progress);
      if(!checks.length)return {state:"UNKNOWN",counts:this.count(id)};
      const fingerprint=hash([id,ws.task_revision,ws.repository,checks]);
      const at=this.now(),old=this.incident(id,fingerprint);
      if(!old){
        this.db.prepare(`INSERT INTO ci_failure_incidents
          (workstream_id,fingerprint,task_revision,failed_checks,pr_number,
           head_sha,evidence_hash,attempts,state,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,0,'open',?,?)`)
          .run(id,fingerprint,ws.task_revision,JSON.stringify(checks),progress.prNumber,
            progress.headSha,progress.evidenceHash,at,at);
      }else if(old.state==="resolved"){
        this.db.prepare(`UPDATE ci_failure_incidents SET state='open',attempts=0,pr_number=?,
          head_sha=?,evidence_hash=?,updated_at=? WHERE workstream_id=? AND fingerprint=?`)
          .run(progress.prNumber,progress.headSha,progress.evidenceHash,at,id,fingerprint);
      }else if(old.evidence_hash!==progress.evidenceHash||old.head_sha!==progress.headSha){
        this.db.prepare(`UPDATE ci_failure_incidents SET pr_number=?,head_sha=?,evidence_hash=?,
          updated_at=? WHERE workstream_id=? AND fingerprint=?`)
          .run(progress.prNumber,progress.headSha,progress.evidenceHash,at,id,fingerprint);
      }
      const current=this.incident(id,fingerprint);
      if(current.attempts>=this.maxRetries){
        const key=hash([id,"CI_RETRY_EXHAUSTED",fingerprint]);
        this.db.prepare(`INSERT INTO ci_blockers(workstream_id,blocker_key,reason_code,severity,state,created_at,updated_at)
          VALUES(?,?,?,'normal','open',?,?) ON CONFLICT(workstream_id,blocker_key) DO UPDATE SET
          state='open',updated_at=excluded.updated_at`).run(id,key,"CI_RETRY_EXHAUSTED",at,at);
        this.holdIfNeeded(id);
      }
      return {state:current.attempts>=this.maxRetries?"BLOCKED":"REPAIR_REVIEW",
        fingerprint,attempts:current.attempts,remaining:this.maxRetries-current.attempts,
        counts:this.count(id)};
    });
  }
  // Called only by a trusted executor after accepting an authorized repair.
  // Polling, CI reruns and repeated snapshot reads must not burn retry budget.
  acknowledgeRepair({workstreamId,fingerprint,evidenceHash,operationId,accepted}={}){
    if(accepted!==true||!EVIDENCE.test(fingerprint||"")||!EVIDENCE.test(evidenceHash||"")||
      typeof operationId!=="string"||!/^[A-Za-z0-9:_-]{1,128}$/.test(operationId))
      throw Error("INVALID_CI_REPAIR_RECEIPT");
    return this.store.transaction(()=>{
      const row=this.incident(workstreamId,fingerprint),ws=this.store.mustGet(workstreamId);
      if(!row||row.state!=="open"||row.task_revision!==ws.task_revision||
        row.evidence_hash!==evidenceHash||ws.paused||this.store.isStopped()||
        row.attempts>=this.maxRetries)throw Error("CI_REPAIR_NOT_ELIGIBLE");
      if(this.db.prepare("SELECT 1 FROM ci_repair_receipts WHERE operation_id=?").get(operationId))
        throw Error("CI_REPAIR_DUPLICATE_OPERATION");
      this.db.prepare("INSERT INTO ci_repair_receipts VALUES(?,?,?,?,?)")
        .run(operationId,workstreamId,fingerprint,evidenceHash,this.now());
      this.db.prepare("UPDATE ci_failure_incidents SET attempts=attempts+1,updated_at=? WHERE workstream_id=? AND fingerprint=?")
        .run(this.now(),workstreamId,fingerprint);
      const updated=this.incident(workstreamId,fingerprint);
      // A second accepted repair is the limit; wait for the resulting CI
      // before converting a still-red result to an operator blocker.
      return {attempts:updated.attempts,remaining:this.maxRetries-updated.attempts};
    });
  }
  list(){
    const ids=this.store.list().map(w=>w.id);
    return ids.map(workstreamId=>({
      workstreamId,counts:this.count(workstreamId),
      incidents:this.db.prepare(`SELECT fingerprint,task_revision AS taskRevision,failed_checks AS failedChecks,
        pr_number AS prNumber,head_sha AS headSha,attempts,state,updated_at AS updatedAt
        FROM ci_failure_incidents WHERE workstream_id=? ORDER BY updated_at DESC`).all(workstreamId)
        .map(row=>({...row,failedChecks:JSON.parse(row.failedChecks)})),
      blockers:this.db.prepare(`SELECT blocker_key AS blockerKey,reason_code AS reasonCode,severity,state
        FROM ci_blockers WHERE workstream_id=? ORDER BY created_at`).all(workstreamId)
    }));
  }
  alerts(){
    return this.db.prepare(`SELECT alert_key AS alertKey,workstream_id AS workstreamId,
      event_kind AS eventKind,reason_code AS reasonCode,status,created_at AS createdAt
      FROM ci_alert_outbox ORDER BY created_at,alert_key`).all();
  }
}
