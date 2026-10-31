import {createHash} from "node:crypto";
import {sendWindowsTelegramText} from "./windows-telegram-compat.js";

const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MINUTE=60_000;
const ALERTABLE=new Set(["CI_FAILED","CI_CANCELLED","CI_STALLED",
  "CI_COLLECTION_UNAVAILABLE","CI_REGISTRY_UNAVAILABLE","CI_REGISTRY_DRIFT",
  "TRACK_CONFLICT","TRACK_REVIEW_REQUIRED","PR_HEAD_DRIFT",
  "PR_EVIDENCE_MISSING","PR_EVIDENCE_UNVERIFIED","PR_CHECKS_FAILED",
  "EXPECTED_CHECK_STALLED","WORKSTREAM_GITHUB_DRIFT",
  "CI_ATTEMPT_DRIFT","CI_TARGET_DRIFT","CI_AUTH_OR_API_UNAVAILABLE",
  "ARCHIVE_HEAD_CONFLICT"]);
const parse=value=>typeof value==="string"?Date.parse(value):NaN;
const recent=(at,now,max=300_000)=>Number.isSafeInteger(at)&&at<=now+5000&&now-at<=max;
const clean=value=>String(value??"").replace(/[^A-Za-z0-9_.:/-]/g,"").slice(0,160);
const finding=(scope,subject,code,severity="normal",detail=null)=>
  ({scope,subject,code,severity,detail:clean(detail)});

export function inspectCiAnomalies({registry,scan,github,directCore,archive,workstreams=[],
  now=Date.now(),stallMs=30*MINUTE}={}){
  const findings=[],scopes=new Set();
  const add=(...args)=>findings.push(finding(...args));
  if(registry?.status==="observed"&&recent(registry.checkedAt,now)){
    scopes.add("registry");
    const keys=new Set();
    for(const track of registry.tracks||[]){
      const key=String(track.projectId)+"/"+String(track.canonicalTrackKey);
      if(keys.has(key))add("registry",key,"TRACK_REGISTRY_AMBIGUOUS","critical");
      keys.add(key);
    }
  }else if(registry?.status==="unavailable"){
    scopes.add("registry");
    add("registry","registry","CI_REGISTRY_UNAVAILABLE","normal",registry.errorCode||"UNKNOWN");
  }
  if(scan?.status==="observed"&&recent(scan.checkedAt,now)&&Array.isArray(scan.repositories)){
    scopes.add("collection");
    for(const repo of scan.repositories){
      if(typeof repo?.repository!=="string"||!repo.repository)continue;
      const scope="repo:"+repo.repository;
      if(repo.status==="not_checked")continue;
      scopes.add(scope);
      if(repo.status!=="observed"||!Array.isArray(repo.runs)||
        !Number.isFinite(parse(repo.observedAt))||
        Math.abs(now-parse(repo.observedAt))>5*MINUTE){
        add(scope,"collection","CI_COLLECTION_UNAVAILABLE","normal",repo.reason||"STALE");
        continue;
      }
      for(const run of repo.runs){
        if(!Number.isSafeInteger(run.runId)||!Number.isSafeInteger(run.runAttempt)||
           run.runId<1||run.runAttempt<1)continue;
        const subject="run:"+run.runId+":"+run.runAttempt;
        const runScope=scope+":"+run.runId+":"+run.runAttempt;
        scopes.add(runScope);
        if(["FAILURE","OTHER_TERMINAL"].includes(run.ciState))
          add(runScope,subject,run.ciState==="FAILURE"?"CI_FAILED":"CI_CANCELLED","critical");
        else if(["QUEUED","RUNNING"].includes(run.ciState)&&
          Number.isFinite(parse(run.createdAt))&&now-parse(run.createdAt)>stallMs)
          add(runScope,subject,"CI_STALLED","normal");
        const stored=archive?.findRun?.(repo.repository,run.runId,run.runAttempt)||null;
        if(stored&&stored.headSha?.toLowerCase()!==run.headSha?.toLowerCase())
          add(runScope,subject,"ARCHIVE_HEAD_CONFLICT","critical");
        if(stored?.attribution==="CONFLICT")add(runScope,subject,"TRACK_CONFLICT");
        else if(stored?.attribution==="UNATTRIBUTED")
          add(runScope,subject,"TRACK_UNATTRIBUTED");
      }
    }
  }else if(scan?.status==="unavailable"||
    (scan?.status==="not_checked"&&Number.isSafeInteger(scan.checkedAt)&&
      now-scan.checkedAt>15*MINUTE)){
    scopes.add("collection");
    add("collection","scanner","CI_COLLECTION_UNAVAILABLE","normal",scan.errorCode||"STALE");
  }
  if(github?.status==="observed"&&recent(github.checkedAt,now)){
    for(const target of github.targets||[]){
      const scope="target:"+target.workstreamId;
      scopes.add(scope);
      const matches=(github.results||[]).filter(x=>x.workstreamId===target.workstreamId);
      if(matches.length!==1){add(scope,"github","PR_EVIDENCE_MISSING");continue;}
      const observed=matches[0];
      if(observed.reason==="PR_HEAD_SHA_DRIFT")add(scope,"github","PR_HEAD_DRIFT","critical");
      else if(observed.state==="UNKNOWN"||observed.reason==="GITHUB_UNAVAILABLE")
        add(scope,"github","PR_EVIDENCE_UNVERIFIED","normal",observed.reason);
      if(observed.state==="FAILURE")add(scope,"github","PR_CHECKS_FAILED","critical");
      if(observed.state==="WAIT_EXTERNAL"&&Array.isArray(observed.checks)&&
        observed.checks.some(c=>c.state==="PENDING")&&
        Number.isSafeInteger(target.configuredAt)&&
        now-target.configuredAt>stallMs)
        add(scope,"github","EXPECTED_CHECK_STALLED","normal");
      const ws=workstreams.find(x=>x.id===target.workstreamId);
      if(ws?.state==="COMPLETE"&&observed.state!=="MERGED_CONFIRMED")
        add(scope,"workstream","WORKSTREAM_GITHUB_DRIFT","critical",observed.state);
    }
  }
  if(directCore?.status==="observed"&&recent(directCore.checkedAt,now)){
    for(const item of directCore.results||[]){
      const scope="target:"+item.workstreamId;
      scopes.add(scope);
      if(item.reason==="DIRECT_ATTEMPT_CHANGED")
        add(scope,"direct","CI_ATTEMPT_DRIFT","critical");
      else if(["DIRECT_TARGET_UNVERIFIED","DIRECT_TARGET_BINDING_MISMATCH",
        "DIRECT_CONTRACT_OR_IDENTITY_MISMATCH","DIRECT_RUN_PR_UNVERIFIED"].includes(item.reason))
        add(scope,"direct","CI_TARGET_DRIFT","critical",item.reason);
      else if(["CORE_INSPECT_UNAVAILABLE","GITHUB_UNAUTHORIZED","GITHUB_RATE_LIMITED",
        "GITHUB_FORBIDDEN","DIRECT_AUTH_BACKOFF"].includes(item.reason))
        add(scope,"direct","CI_AUTH_OR_API_UNAVAILABLE","normal",item.reason);
    }
  }
  const unique=new Map();
  for(const item of findings)unique.set(hash([item.scope,item.subject,item.code]),item);
  return {findings:[...unique.entries()].map(([key,item])=>({...item,key})),
    scopes:[...scopes],safeToAdvance:false,completeCoverage:false};
}

export class CiMonitor {
  constructor(store,{now=()=>Date.now(),sender=sendWindowsTelegramText,
    alertsEnabled=process.env.AUTOPILOT_TELEGRAM_ENABLED==="1"&&
      process.env.AUTOPILOT_CI_ALERTS_ENABLED==="1"}={}){
    this.store=store;this.db=store.db;this.now=now;this.sender=sender;
    this.alertsEnabled=alertsEnabled===true;this.processing=false;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS ci_monitor_incidents(",
      "incident_key TEXT PRIMARY KEY,scope TEXT NOT NULL,subject TEXT NOT NULL,",
      "code TEXT NOT NULL,severity TEXT NOT NULL,detail TEXT,",
      "state TEXT NOT NULL CHECK(state IN ('open','resolved')),",
      "revision INTEGER NOT NULL CHECK(revision>0),",
      "opened_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS ci_monitor_registry_baseline(",
      "source_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,observed_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS ci_monitor_seen_scopes(",
      "scope TEXT PRIMARY KEY,initialized_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS ci_monitor_events(",
      "event_key TEXT PRIMARY KEY,incident_key TEXT NOT NULL,",
      "revision INTEGER NOT NULL,event_type TEXT NOT NULL,recorded_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS ci_monitor_alerts(",
      "event_key TEXT PRIMARY KEY REFERENCES ci_monitor_events(event_key),",
      "state TEXT NOT NULL CHECK(state IN ('pending','claimed','accepted','unknown','suppressed')),",
      "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;"
    ].join(" "));
    this.db.prepare("UPDATE ci_monitor_alerts SET state='unknown',updated_at=? WHERE state='claimed'")
      .run(this.now());
    this.last={status:"not_checked",checkedAt:null,changes:0,open:0,
      safeToAdvance:false,completeCoverage:false};
  }
  event(key,revision,type,at,notify=false){
    const eventKey=hash([key,revision,type]);
    this.db.prepare("INSERT OR IGNORE INTO ci_monitor_events"+
      "(event_key,incident_key,revision,event_type,recorded_at) VALUES(?,?,?,?,?)")
      .run(eventKey,key,revision,type,at);
    this.db.prepare("INSERT OR IGNORE INTO ci_monitor_alerts"+
      "(event_key,state,created_at,updated_at) VALUES(?,?,?,?)")
      .run(eventKey,this.alertsEnabled&&notify?"pending":"suppressed",at,at);
  }
  capture(state){
    const at=this.now(),observed=inspectCiAnomalies({...state,now:at});
    let baselineSignature=null;
    const registry=state?.registry;
    if(registry?.status==="observed"&&recent(registry.checkedAt,at)&&
      Array.isArray(registry.repositories)&&Array.isArray(registry.tracks)){
      const ordered=values=>values.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      baselineSignature=hash([ordered(registry.projects||[]),
        ordered(registry.repositories.map(r=>({
          id:r.id,projectId:r.projectId,name:r.name,enabled:r.enabled
        }))),
        ordered(registry.tracks.map(t=>({
          id:t.id,projectId:t.projectId,key:t.canonicalTrackKey,active:t.active
        })))]);
      const original=this.db.prepare("SELECT fingerprint FROM ci_monitor_registry_baseline WHERE source_key='core'")
        .get();
      if(original&&original.fingerprint!==baselineSignature){
        const item=finding("registry","registry:"+baselineSignature.slice(0,16),
          "CI_REGISTRY_DRIFT","critical");
        observed.findings.push({...item,key:hash([item.scope,item.subject,item.code])});
      }
    }
    const present=new Set(observed.findings.map(x=>x.key));
    const scopes=new Set(observed.scopes);
    const initialized=new Set(this.db.prepare("SELECT scope FROM ci_monitor_seen_scopes")
      .all().map(x=>x.scope));
    let changes=0;
    this.store.transaction(()=>{
      for(const scope of scopes)
        this.db.prepare("INSERT OR IGNORE INTO ci_monitor_seen_scopes(scope,initialized_at) VALUES(?,?)")
          .run(scope,at);
      if(baselineSignature)
        this.db.prepare("INSERT OR IGNORE INTO ci_monitor_registry_baseline"+
          "(source_key,fingerprint,observed_at) VALUES('core',?,?)")
          .run(baselineSignature,at);
      for(const item of observed.findings){
        const old=this.db.prepare("SELECT state,revision FROM ci_monitor_incidents WHERE incident_key=?")
          .get(item.key);
        if(!old){
          this.db.prepare("INSERT INTO ci_monitor_incidents"+
            "(incident_key,scope,subject,code,severity,detail,state,revision,opened_at,updated_at)"+
            " VALUES(?,?,?,?,?,?,'open',1,?,?)")
            .run(item.key,item.scope,item.subject,item.code,item.severity,item.detail,at,at);
          this.event(item.key,1,"OPENED",at,
            initialized.has(item.scope)&&ALERTABLE.has(item.code));changes++;
        }else if(old.state==="resolved"){
          const revision=old.revision+1;
          this.db.prepare("UPDATE ci_monitor_incidents SET state='open',revision=?,"+
            "severity=?,detail=?,opened_at=?,updated_at=? WHERE incident_key=?")
            .run(revision,item.severity,item.detail,at,at,item.key);
          this.event(item.key,revision,"OPENED",at,
            initialized.has(item.scope)&&ALERTABLE.has(item.code));changes++;
        }else{
          this.db.prepare("UPDATE ci_monitor_incidents SET updated_at=? WHERE incident_key=?")
            .run(at,item.key);
        }
      }
      for(const old of this.db.prepare("SELECT incident_key,scope,revision FROM ci_monitor_incidents WHERE state='open'").all()){
        if(!scopes.has(old.scope)||present.has(old.incident_key))continue;
        this.db.prepare("UPDATE ci_monitor_incidents SET state='resolved',updated_at=? WHERE incident_key=?")
          .run(at,old.incident_key);
        this.event(old.incident_key,old.revision,"RECOVERED",at,
          initialized.has(old.scope));changes++;
      }
    });
    this.last={status:"observed",checkedAt:at,changes,
      open:this.db.prepare("SELECT COUNT(*) AS n FROM ci_monitor_incidents WHERE state='open'").get().n,
      safeToAdvance:false,completeCoverage:false};
    return this.current();
  }
  current(){
    return {...this.last,alertsEnabled:this.alertsEnabled,
      incidents:this.db.prepare("SELECT incident_key AS incidentKey,scope,subject,code,severity,"+
        "detail,state,revision,opened_at AS openedAt,updated_at AS updatedAt"+
        " FROM ci_monitor_incidents ORDER BY updated_at DESC LIMIT 80").all(),
      notifications:this.db.prepare("SELECT a.event_key AS eventKey,e.event_type AS eventType,"+
        "a.state,a.created_at AS createdAt FROM ci_monitor_alerts a"+
        " JOIN ci_monitor_events e ON a.event_key=e.event_key"+
        " ORDER BY a.created_at DESC LIMIT 50").all(),
      safeToAdvance:false,completeCoverage:false};
  }
  async drain(){
    if(!this.alertsEnabled||this.processing)return {status:"disabled_or_busy"};
    this.processing=true;
    try{
      const day=Math.floor(this.now()/86_400_000)*86_400_000;
      const sent=this.db.prepare("SELECT count(*) AS n FROM ci_monitor_alerts"+
        " WHERE state IN ('claimed','accepted','unknown') AND updated_at>=?")
        .get(day).n;
      if(sent>=12)return {status:"rate_budget"};
      const next=this.store.transaction(()=>{
        const row=this.db.prepare("SELECT a.event_key AS eventKey,i.scope,i.subject,i.code,"+
          "i.severity,e.event_type AS type FROM ci_monitor_alerts a"+
          " JOIN ci_monitor_events e ON e.event_key=a.event_key"+
          " JOIN ci_monitor_incidents i ON i.incident_key=e.incident_key"+
          " WHERE a.state='pending' ORDER BY a.created_at,a.event_key LIMIT 1").get();
        if(row)this.db.prepare("UPDATE ci_monitor_alerts SET state='claimed',updated_at=?"+
          " WHERE event_key=? AND state='pending'").run(this.now(),row.eventKey);
        return row||null;
      });
      if(!next)return {status:"empty"};
      const message=["[Development Autopilot] CI "+(next.type==="RECOVERED"?"복구":"관제 알림"),
        "대상: "+next.scope+" / "+next.subject,"이벤트: "+next.code,
        "중요도: "+next.severity,"조치: Autopilot 관리 화면에서 확인하십시오.",
        "이 메시지는 사용자 승인이나 자동 작업 재개를 의미하지 않습니다."].join("\n");
      let status="unknown";
      try{if(await this.sender(message)===true)status="accepted";}catch{}
      this.db.prepare("UPDATE ci_monitor_alerts SET state=?,updated_at=? WHERE event_key=? AND state='claimed'")
        .run(status,this.now(),next.eventKey);
      return {status,eventKey:next.eventKey};
    }finally{this.processing=false;}
  }
}
