// Persistent CI Run/Attempt history owned by Autopilot, not WatchTower.
// Advisory only: historical or partial observations never authorize execution.
import {createHash,randomUUID} from "node:crypto";

const SHA=/^[a-f0-9]{40}$/i;
const STATES=new Set(["QUEUED","RUNNING","SUCCESS","FAILURE","OTHER_TERMINAL","UNKNOWN"]);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const date=s=>typeof s==="string"?Date.parse(s):NaN;
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const safeText=(s,n=120)=>typeof s==="string"?s.slice(0,n):"";

export class CiArchiveError extends Error{
  constructor(code){super(code);this.name="CiArchiveError";this.code=code;}
}
export class CoreRunArchive{
  constructor(store,{now=()=>Date.now()}={}){
    this.store=store;this.db=store.db;this.now=now;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS ci_core_runs(",
      "repository TEXT NOT NULL,repository_id INTEGER NOT NULL,project_id INTEGER NOT NULL,",
      "run_id INTEGER NOT NULL,run_attempt INTEGER NOT NULL,workflow_id INTEGER NOT NULL,",
      "workflow_name TEXT NOT NULL,head_sha TEXT NOT NULL,ci_kind TEXT NOT NULL,",
      "ci_state TEXT NOT NULL,status TEXT NOT NULL,conclusion TEXT,github_updated_at TEXT NOT NULL,",
      "first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,track_id INTEGER,track_key TEXT,",
      "attribution TEXT NOT NULL,PRIMARY KEY(repository,run_id,run_attempt)) STRICT;",
      "CREATE INDEX IF NOT EXISTS ci_core_runs_recent ON ci_core_runs(last_seen_at DESC);",
      "CREATE TABLE IF NOT EXISTS ci_core_events(",
      "event_key TEXT PRIMARY KEY,repository TEXT NOT NULL,run_id INTEGER NOT NULL,",
      "run_attempt INTEGER NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL) STRICT;",
      "CREATE INDEX IF NOT EXISTS ci_core_events_recent ON ci_core_events(at DESC);",
      "CREATE TABLE IF NOT EXISTS ci_core_receipts(",
      "repository TEXT PRIMARY KEY,repository_id INTEGER NOT NULL,",
      "observed_at TEXT NOT NULL,recorded_at INTEGER NOT NULL,accepted INTEGER NOT NULL,",
      "sample_count INTEGER NOT NULL,complete_coverage INTEGER NOT NULL DEFAULT 0",
      "CHECK(complete_coverage=0)) STRICT;"
    ].join(" "));
    this.last={status:"not_checked",checkedAt:null,accepted:0,changes:0,
      scanRepositories:0,reason:null,completeCoverage:false,safeToAdvance:false};
  }
  current(){
    const totals=this.db.prepare("SELECT COUNT(*) AS attempts,COUNT(DISTINCT repository||':'||run_id) AS runs FROM ci_core_runs").get();
    const tracked=this.db.prepare("SELECT COUNT(*) AS n FROM ci_core_runs WHERE track_id IS NOT NULL").get().n;
    const failures=this.db.prepare("SELECT COUNT(*) AS n FROM ci_core_runs WHERE ci_state='FAILURE'").get().n;
    const receipts=this.db.prepare("SELECT COUNT(*) AS n FROM ci_core_receipts").get().n;
    return {...this.last,totals:{...totals,trackAttributed:tracked,failedAttempts:failures,
      scannedRepositories:receipts},completeCoverage:false,safeToAdvance:false};
  }
  latest(limit=60){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new CiArchiveError("INVALID_LIMIT");
    return this.db.prepare("SELECT repository,repository_id AS repositoryId,project_id AS projectId,"+
      "run_id AS runId,run_attempt AS runAttempt,workflow_name AS workflowName,"+
      "head_sha AS headSha,ci_state AS ciState,conclusion,github_updated_at AS githubUpdatedAt,"+
      "last_seen_at AS lastSeenAt,track_id AS trackId,track_key AS trackKey,attribution "+
      "FROM ci_core_runs ORDER BY last_seen_at DESC,run_id DESC LIMIT ?").all(limit)
      .map(row=>({...row,historicalOnly:true,completeCoverage:false,safeToAdvance:false}));
  }
  events(limit=50){
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new CiArchiveError("INVALID_LIMIT");
    return this.db.prepare("SELECT repository,run_id AS runId,run_attempt AS runAttempt,"+
      "kind,state,at FROM ci_core_events ORDER BY at DESC,ROWID DESC LIMIT ?").all(limit);
  }
  capture(scan,registry,history){
    const at=this.now();
    if(registry?.status!=="observed"||scan?.status!=="observed"||
       !Number.isSafeInteger(scan.checkedAt)||Math.abs(at-scan.checkedAt)>95_000||
       scan.safeToAdvance!==false||scan.completeCoverage!==false||
       !Array.isArray(scan.repositories)||!Array.isArray(registry.repositories)){
      this.last={status:"unavailable",checkedAt:at,accepted:0,changes:0,
        scanRepositories:0,reason:"FRESH_SCAN_REQUIRED",safeToAdvance:false,completeCoverage:false};
      return this.current();
    }
    const repos=new Map(registry.repositories.filter(x=>x?.enabled===true&&
      positive(x.id)&&positive(x.projectId)&&typeof x.name==="string")
      .map(x=>[x.name,x]));
    const historical=new Map((history?.status==="observed"?history.repositories:[])
      .filter(x=>x.status==="observed").map(x=>[x.repository,x.runs]));
    const batches=[],seenRepos=new Set();
    for(const row of scan.repositories){
      if(row.status!=="observed")continue;
      const repo=repos.get(row.repository);
      if(!repo||repo.id!==row.repositoryId||seenRepos.has(row.repository)||
         !Number.isFinite(date(row.observedAt))||Math.abs(at-date(row.observedAt))>95_000||
         !Array.isArray(row.runs)||row.runs.length>50){
        return this._bad("SCAN_IDENTITY_INVALID",at);
      }
      seenRepos.add(row.repository);
      const seenRuns=new Set();
      for(const run of row.runs){
        if(!positive(run.runId)||!positive(run.runAttempt)||!positive(run.workflowId)||
           seenRuns.has(run.runId)||!SHA.test(run.headSha||"")||
           !STATES.has(run.ciState)||!Number.isFinite(date(run.updatedAt))||
           date(run.updatedAt)>at+300_000||
           run.safeToAdvance!==false||run.targetVerified!==false||
           run.requiredChecksVerified!==false)
          return this._bad("RUN_IDENTITY_INVALID",at);
        seenRuns.add(run.runId);
      }
      batches.push({repo,runs:row.runs,observedAt:row.observedAt,
        history:historical.get(row.repository)||[]});
    }
    if(!batches.length)return this._bad("NO_FRESH_REPOSITORY",at);
    let accepted=0,changes=0,scanRepositories=0;
    try{
      this.store.transaction(()=>{
        const find=this.db.prepare("SELECT head_sha AS headSha,ci_state AS ciState,"+
          "conclusion,github_updated_at AS githubUpdatedAt,track_id AS trackId,"+
          "track_key AS trackKey,attribution FROM ci_core_runs "+
          "WHERE repository=? AND run_id=? AND run_attempt=?");
        const write=this.db.prepare(
          "INSERT INTO ci_core_runs(repository,repository_id,project_id,run_id,run_attempt,"+
          "workflow_id,workflow_name,head_sha,ci_kind,ci_state,status,conclusion,"+
          "github_updated_at,first_seen_at,last_seen_at,track_id,track_key,attribution) "+
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "+
          "ON CONFLICT(repository,run_id,run_attempt) DO UPDATE SET "+
          "ci_state=excluded.ci_state,status=excluded.status,conclusion=excluded.conclusion,"+
          "github_updated_at=excluded.github_updated_at,last_seen_at=excluded.last_seen_at,"+
          "track_id=CASE WHEN ci_core_runs.attribution IN ('MANUAL','MANUAL_UNASSIGNED') "+
          "THEN ci_core_runs.track_id ELSE COALESCE(ci_core_runs.track_id,excluded.track_id) END,"+
          "track_key=CASE WHEN ci_core_runs.attribution IN ('MANUAL','MANUAL_UNASSIGNED') "+
          "OR ci_core_runs.track_id IS NOT NULL THEN ci_core_runs.track_key "+
          "ELSE excluded.track_key END,"+
          "attribution=CASE WHEN ci_core_runs.attribution IN ('MANUAL','MANUAL_UNASSIGNED') "+
          "OR ci_core_runs.track_id IS NOT NULL THEN ci_core_runs.attribution "+
          "ELSE excluded.attribution END");
        const event=this.db.prepare("INSERT OR IGNORE INTO ci_core_events"+
          "(event_key,repository,run_id,run_attempt,kind,state,at) VALUES(?,?,?,?,?,?,?)");
        const receipt=this.db.prepare("INSERT INTO ci_core_receipts"+
          "(repository,repository_id,observed_at,recorded_at,accepted,sample_count,complete_coverage) "+
          "VALUES(?,?,?,?,?,?,0) ON CONFLICT(repository) DO UPDATE SET "+
          "observed_at=excluded.observed_at,recorded_at=excluded.recorded_at,"+
          "accepted=excluded.accepted,sample_count=excluded.sample_count");
        for(const batch of batches){
          const prior=this.db.prepare("SELECT observed_at FROM ci_core_receipts WHERE repository=?")
            .get(batch.repo.name);
          if(prior&&date(prior.observed_at)>=date(batch.observedAt))continue;
          scanRepositories++;
          let acceptedHere=0;
          for(const run of batch.runs){
            const old=find.get(batch.repo.name,run.runId,run.runAttempt);
            if(old&&old.headSha.toLowerCase()!==run.headSha.toLowerCase())
              throw new CiArchiveError("RUN_HEAD_CONFLICT");
            if(old&&date(old.githubUpdatedAt)>date(run.updatedAt))continue;
            const related=batch.history.filter(x=>x.runId===run.runId&&
              x.headSha?.toLowerCase()===run.headSha.toLowerCase());
            let trackId=null,trackKey=null,attribution="UNATTRIBUTED";
            if(related.length===1){
              const evidence=related[0];
              if(evidence.attributionConflict===true)attribution="CONFLICT";
              else if(positive(evidence.workTrackId)&&
                registry.tracks?.some(t=>t.id===evidence.workTrackId&&
                  t.projectId===batch.repo.projectId&&
                  t.canonicalTrackKey===evidence.workTrackKey)){
                trackId=evidence.workTrackId;
                trackKey=evidence.workTrackKey;
                attribution="HISTORICAL_EXACT";
              }
            }
            write.run(batch.repo.name,batch.repo.id,batch.repo.projectId,
              run.runId,run.runAttempt,run.workflowId,safeText(run.workflowName,200),
              run.headSha.toLowerCase(),safeText(run.ciKind,100),run.ciState,
              safeText(run.status,60),run.conclusion||null,run.updatedAt,
              at,at,trackId,trackKey,attribution);
            accepted++;acceptedHere++;
            if(!old||old.ciState!==run.ciState||old.conclusion!==(run.conclusion||null)){
              const kind=old?"STATE_CHANGED":"DISCOVERED";
              const key=hash([batch.repo.name,run.runId,run.runAttempt,kind,
                run.ciState,run.conclusion||null]);
              changes+=event.run(key,batch.repo.name,run.runId,run.runAttempt,
                kind,run.ciState,at).changes;
            }
          }
          receipt.run(batch.repo.name,batch.repo.id,batch.observedAt,at,
            acceptedHere,batch.runs.length);
        }
      });
      this.last={status:"recorded",checkedAt:at,accepted,changes,scanRepositories,
        reason:null,completeCoverage:false,safeToAdvance:false};
    }catch(error){
      return this._bad(error instanceof CiArchiveError?error.code:"CI_ARCHIVE_WRITE_FAILED",at);
    }
    return this.current();
  }
  assignTrack({repository,runId,runAttempt,headSha,trackId},registry){
    if(typeof repository!=="string"||!positive(runId)||!positive(runAttempt)||
       !SHA.test(headSha||"")||!(trackId===null||positive(trackId))||
       registry?.status!=="observed")
      throw new CiArchiveError("MANUAL_TRACK_TARGET_INVALID");
    const repo=registry.repositories?.find(r=>r.name===repository&&r.enabled===true);
    if(!repo||!positive(repo.id)||!positive(repo.projectId))
      throw new CiArchiveError("MANUAL_TRACK_REPOSITORY_UNKNOWN");
    const track=trackId===null?null:registry.tracks?.find(t=>t.id===trackId&&
      t.projectId===repo.projectId&&t.active===true&&
      typeof t.canonicalTrackKey==="string");
    if(trackId!==null&&!track)throw new CiArchiveError("MANUAL_TRACK_PROJECT_MISMATCH");
    return this.store.transaction(()=>{
      const record=this.db.prepare("SELECT repository_id AS repositoryId,project_id AS projectId,"+
        "head_sha AS headSha,track_id AS trackId,track_key AS trackKey,ci_state AS ciState,"+
        "attribution FROM ci_core_runs WHERE repository=? AND run_id=? AND run_attempt=?")
        .get(repository,runId,runAttempt);
      if(!record||record.repositoryId!==repo.id||record.projectId!==repo.projectId||
         record.headSha.toLowerCase()!==headSha.toLowerCase())
        throw new CiArchiveError("MANUAL_TRACK_STALE_TARGET");
      if(record.trackId===trackId&&record.attribution===(track?"MANUAL":"MANUAL_UNASSIGNED"))
        return {changed:false,repository,runId,runAttempt,trackId,safeToAdvance:false};
      const at=this.now();
      this.db.prepare("UPDATE ci_core_runs SET track_id=?,track_key=?,attribution=? "+
        "WHERE repository=? AND run_id=? AND run_attempt=?")
        .run(track?.id||null,track?.canonicalTrackKey||null,
          track?"MANUAL":"MANUAL_UNASSIGNED",repository,runId,runAttempt);
      this.db.prepare("INSERT INTO ci_core_events"+
        "(event_key,repository,run_id,run_attempt,kind,state,at) VALUES(?,?,?,?,?,?,?)")
        .run(randomUUID(),repository,runId,runAttempt,
          track?"MANUAL_TRACK_ASSIGNED":"MANUAL_TRACK_CLEARED",record.ciState,at);
      return {changed:true,repository,runId,runAttempt,trackId,safeToAdvance:false};
    });
  }
  _bad(reason,at){
    this.last={status:"unavailable",checkedAt:at,accepted:0,changes:0,
      scanRepositories:0,reason,completeCoverage:false,safeToAdvance:false};
    return this.current();
  }
}
