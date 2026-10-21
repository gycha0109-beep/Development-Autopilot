import {randomUUID} from 'node:crypto';
import {hashAction} from './autopilot-decision.js';
import {projectObservation} from './chat-observation.js';
import {LOADING_WORKER_BUILD} from '../extension/loading-page.js';

const terminal=s=>['DONE','FAILED','UNKNOWN'].includes(s);
const error=p=>p?.verified===false&&p.reasonCode==='ASSISTANT_RESPONSE_UNAVAILABLE';
const hex=v=>/^[a-f0-9]{64}$/.test(v||'');
export class LoadingRecovery{
  constructor(store,{transport,state,inbox,now=()=>Date.now()}={}){
    Object.assign(this,{store,db:store.db,transport,state,inbox,now});this.workers=new Map();this.jobs=new Map();this.closed=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS loading_recovery_scopes(
      workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),extension_id TEXT NOT NULL,session_key TEXT NOT NULL,
      linked_at INTEGER NOT NULL,task_revision INTEGER NOT NULL,enabled INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS loading_recoveries(
      operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,workstream_id TEXT NOT NULL REFERENCES workstreams(id),
      extension_id TEXT NOT NULL,session_key TEXT NOT NULL,linked_at INTEGER NOT NULL,task_revision INTEGER NOT NULL,
      binding_fingerprint TEXT NOT NULL,user_fingerprint TEXT NOT NULL,stage TEXT NOT NULL,reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,next_read_at INTEGER NOT NULL,deadline_at INTEGER NOT NULL,
      authorized_at INTEGER,attempted_at INTEGER,acked_at INTEGER,first_normal TEXT,
      UNIQUE(workstream_id,binding_fingerprint,user_fingerprint)) STRICT;
      CREATE TABLE IF NOT EXISTS loading_reload_budget(
      id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,next_at INTEGER NOT NULL,failures INTEGER NOT NULL) STRICT;
      INSERT OR IGNORE INTO loading_reload_budget VALUES(1,NULL,0,0);`);
    // A persisted intent might already have navigated. Neither server nor worker
    // restarts may replay it. Read-only post-ACK verification can continue.
    for(const row of this.db.prepare("SELECT * FROM loading_recoveries WHERE stage IN ('QUEUED','CLAIMED')").all())
      this.fail(row,'LOADING_RESTART_NO_REPLAY','UNKNOWN');
  }
  get(id){return this.db.prepare('SELECT * FROM loading_recoveries WHERE workstream_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id)||null;}
  row(op){return this.db.prepare('SELECT * FROM loading_recoveries WHERE operation_id=?').get(op)||null;}
  active(id){const row=this.get(id);return row&&!terminal(row.stage)?row:null;}
  blocked(id){return !!this.get(id)&&this.get(id).stage!=='DONE';}
  heartbeat(id,build){if(build===LOADING_WORKER_BUILD)this.workers.set(id,this.now());else this.workers.delete(id);}
  supported(id){try{const s=this.transport.current(id),at=this.workers.get(s.extension_id);return Number.isSafeInteger(at)&&this.now()-at<=150_000;}catch{return false;}}
  configure(id,enabled){
    if(enabled!==true)throw Error('LOADING_EXPLICIT_PERMISSION_REQUIRED');
    const s=this.transport.current(id);
    if(!this.supported(id)||this.active(id)||this.state.pending(id))throw Error('LOADING_SCOPE_NOT_READY');
    this.db.prepare(`INSERT INTO loading_recovery_scopes VALUES(?,?,?,?,?,1,?) ON CONFLICT(workstream_id) DO UPDATE SET
      extension_id=excluded.extension_id,session_key=excluded.session_key,linked_at=excluded.linked_at,
      task_revision=excluded.task_revision,enabled=1,expires_at=excluded.expires_at`)
      .run(id,s.extension_id,s.session_key,s.linked_at,s.task_revision,this.now()+3_600_000);
    this.store.event(id,this.now(),'loading_permission',null,null,'READ_RECHECK_ONE_RELOAD_NO_MESSAGES');
    return {enabled:true,expiresAt:this.now()+3_600_000};
  }
  current(row){
    const s=this.transport.current(row.workstream_id),p=this.db.prepare('SELECT * FROM loading_recovery_scopes WHERE workstream_id=?').get(row.workstream_id),ws=this.store.mustGet(row.workstream_id);
    if(!p?.enabled||p.expires_at<=this.now()||!this.supported(row.workstream_id)||
      ['extension_id','session_key','linked_at','task_revision'].some(k=>s[k]!==row[k]||p[k]!==row[k])||
      this.state.pending(row.workstream_id,{loadingId:row.operation_id})||ws.active_operation_id||!['OBSERVING','READY'].includes(ws.state))
      throw Error('LOADING_PRECONDITION_CHANGED');
    return s;
  }
  change(row,stage,reason){
    this.db.prepare('UPDATE loading_recoveries SET stage=?,reason=?,updated_at=? WHERE operation_id=?').run(stage,reason,this.now(),row.operation_id);
    this.store.event(row.workstream_id,this.now(),'loading_stage',null,null,reason,row.operation_id);
  }
  fail(row,reason,stage='FAILED'){
    if(!row||terminal(this.row(row.operation_id)?.stage))return;
    this.change(row,stage,reason);
    this.db.prepare("UPDATE operations SET status='abandoned',result=?,finished_at=? WHERE id=?").run(reason,this.now(),row.operation_id);
    const b=this.db.prepare('SELECT * FROM loading_reload_budget WHERE id=1').get();
    if(b.owner===row.operation_id)this.db.prepare('UPDATE loading_reload_budget SET owner=NULL,failures=failures+1,next_at=? WHERE id=1')
      .run(this.now()+Math.min(900_000,60_000*2**Math.min(b.failures+1,4)));
    this.inbox.open(row.workstream_id,{reasonCategory:'recovery',reasonCode:reason,
      actionFingerprint:hashAction([row.operation_id,reason]),evidenceTimestamp:this.now(),expiresAt:this.now()+3_600_000});
  }
  notice(id,page){
    if(this.closed)return;
    let row=this.get(id);
    if(!row||row.stage==='DONE'){
      if(!error(page)||!this.db.prepare('SELECT 1 FROM loading_recovery_scopes WHERE workstream_id=? AND enabled=1 AND expires_at>?').get(id,this.now()))return;
      const s=this.transport.current(id),proof=page.loadingSafety,binding=proof?.bindingFingerprint||'',user=proof?.userFingerprint||'';
      const old=this.db.prepare('SELECT * FROM loading_recoveries WHERE workstream_id=? AND binding_fingerprint=? AND user_fingerprint=?').get(id,binding,user);
      if(old){
        // Same request recurring after success must not earn another reload.
        if(old.stage==='DONE'){
          this.change(old,'REOBSERVE','LOADING_RECURRED_NO_RELOAD');this.fail(old,'LOADING_REQUEST_RECURRED_REVIEW');
        }return;
      }
      const op=randomUUID();
      this.store.transaction(()=>{
        this.db.prepare("INSERT INTO operations(id,workstream_id,task_revision,kind,dedupe_key,status,started_at) VALUES(?,?,?,'response-loading-recovery',?,'reserved',?)")
          .run(op,id,s.task_revision,hashAction([id,binding,user]),this.now());
        this.db.prepare(`INSERT INTO loading_recoveries VALUES(?,?,?,?,?,?,?,?,'REOBSERVE','LOADING_READ_ONLY_RECHECK',?,?,?,?,NULL,NULL,NULL,NULL)`)
          .run(op,id,s.extension_id,s.session_key,s.linked_at,s.task_revision,binding,user,this.now(),this.now(),this.now()+30_000,this.now()+600_000);
      });
      this.store.event(id,this.now(),'loading_detected',null,null,'SEND_BLOCKED_RECHECK_WITHOUT_NAVIGATION',op);return;
    }
    if(terminal(row.stage)||['QUEUED','CLAIMED'].includes(row.stage))return;
    if(!page||page.observedAt<=row.created_at||this.now()<row.next_read_at)return;
    try{this.current(row);}catch{return this.fail(row,'LOADING_PRECONDITION_CHANGED');}
    const proof=page.loadingSafety;
    if(proof?.safe!==true||proof.bindingFingerprint!==row.binding_fingerprint||proof.userFingerprint!==row.user_fingerprint)
      return this.fail(row,'LOADING_IDENTITY_OR_UI_UNPROVEN');
    if(error(page)){
      if(proof.failed!==true)return this.fail(row,'LOADING_ERROR_UI_UNPROVEN');
      if(['POST_RELOAD','VERIFYING'].includes(row.stage))return this.fail(row,'LOADING_RELOAD_DID_NOT_RECOVER');
      const budget=this.db.prepare('SELECT * FROM loading_reload_budget WHERE id=1').get();
      const first=this.db.prepare("SELECT operation_id FROM loading_recoveries WHERE stage IN ('REOBSERVE','WAIT_SLOT') ORDER BY created_at,rowid LIMIT 1").get();
      if(budget.owner||budget.next_at>this.now()||first?.operation_id!==row.operation_id){
        // Five healthy serialized recoveries can exceed the initial ten-minute
        // read/recheck window with the production one-minute worker heartbeat.
        // Bound queue waiting separately, never renew it on each recheck, and
        // retain the original permission expiry and five-minute effect lease.
        if(row.stage!=='WAIT_SLOT'){
          const permission=this.db.prepare('SELECT expires_at FROM loading_recovery_scopes WHERE workstream_id=?').get(id);
          this.db.prepare('UPDATE loading_recoveries SET deadline_at=? WHERE operation_id=?')
            .run(Math.min(permission.expires_at,row.created_at+1_800_000),row.operation_id);
        }
        this.change(row,'WAIT_SLOT','LOADING_GLOBAL_BACKOFF');
        this.db.prepare('UPDATE loading_recoveries SET next_read_at=? WHERE operation_id=?').run(this.now()+30_000,row.operation_id);return;
      }
      this.store.transaction(()=>{
        this.db.prepare('UPDATE loading_reload_budget SET owner=?,next_at=? WHERE id=1').run(row.operation_id,this.now()+60_000);
        this.change(row,'QUEUED','LOADING_ONE_RELOAD_INTENT');
        this.db.prepare('UPDATE loading_recoveries SET deadline_at=? WHERE operation_id=?').run(this.now()+300_000,row.operation_id);
      });return;
    }
    if(page.verified!==true||proof.failed!==false||page.assistantBusy!==false||page.composerHasDraft!==false||page.uiAmbiguous||
      !page.contentComplete||!hex(page.replyFingerprint)||page.bindingFingerprint!==row.binding_fingerprint)return this.fail(row,'LOADING_NORMAL_RESPONSE_UNPROVEN');
    if(row.acked_at!==null&&page.observedAt<=row.acked_at)return;
    const prior=row.first_normal?JSON.parse(row.first_normal):null;
    if(!prior||prior.replyFingerprint!==page.replyFingerprint){
      this.change(row,'VERIFYING','LOADING_FRESH_RESPONSE_STABILIZING');
      this.db.prepare('UPDATE loading_recoveries SET first_normal=?,next_read_at=? WHERE operation_id=?')
        .run(JSON.stringify({replyFingerprint:page.replyFingerprint,observedAt:page.observedAt}),this.now()+30_000,row.operation_id);return;
    }
    if(page.observedAt-prior.observedAt<30_000)return;
    this.change(row,'DONE',row.attempted_at===null?'LOADING_READ_ONLY_RECOVERED':'LOADING_RELOAD_INDEPENDENTLY_VERIFIED');
    this.db.prepare("UPDATE operations SET status='completed',result='FRESH_STABLE_RESPONSE',finished_at=? WHERE id=?").run(this.now(),row.operation_id);
    this.db.prepare('UPDATE loading_reload_budget SET owner=NULL,failures=0 WHERE id=1 AND owner=?').run(row.operation_id);
    // Discard all pre-recovery admission evidence. Normal coordinator must read
    // again, pass stability, campaign, CI, response-consumed and claim guards.
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='autopilot_schedules'").get())
      this.db.prepare('UPDATE autopilot_schedules SET observation_after=?,next_inspect_at=0 WHERE workstream_id=?').run(this.now(),id);
  }
  claim(extensionId,protocol){
    if(protocol!==LOADING_WORKER_BUILD)return null;
    const row=this.db.prepare("SELECT * FROM loading_recoveries WHERE extension_id=? AND stage='QUEUED' ORDER BY created_at,rowid LIMIT 1").get(extensionId);
    if(!row)return null;
    try{this.current(row);if(this.now()>=row.deadline_at)throw Error();}catch{this.fail(row,'LOADING_CLAIM_REFUSED');return null;}
    this.change(row,'CLAIMED','LOADING_CLAIMED_ONCE');
    return {operationId:row.operation_id,workstreamId:row.workstream_id,sessionKey:row.session_key,
      bindingFingerprint:row.binding_fingerprint,userFingerprint:row.user_fingerprint};
  }
  authorize(ext,id,input){
    const row=this.row(id);if(row?.extension_id!==ext||row.stage!=='CLAIMED'||row.authorized_at!==null)return {authorized:false};
    try{
      this.current(row);const page=projectObservation(input,this.now()),p=page.loadingSafety;
      if(this.now()>=row.deadline_at||!error(page)||p?.safe!==true||p.failed!==true||p.bindingFingerprint!==row.binding_fingerprint||p.userFingerprint!==row.user_fingerprint)throw Error();
      this.db.prepare('UPDATE loading_recoveries SET authorized_at=? WHERE operation_id=?').run(this.now(),id);return {authorized:true};
    }catch{this.fail(row,'LOADING_PRE_EFFECT_REFUSED');return {authorized:false};}
  }
  ack(ext,{operationId,outcome}={}){
    const row=this.row(operationId);if(row?.extension_id!==ext||row.stage!=='CLAIMED')throw Error('LOADING_ACK_NOT_CURRENT');
    try{
      this.current(row);if(outcome!=='started'||row.authorized_at===null||this.now()-row.authorized_at>30_000||this.now()>=row.deadline_at)throw Error();
      this.change(row,'POST_RELOAD','LOADING_ACK_IS_NOT_RECOVERY');
      this.db.prepare('UPDATE loading_recoveries SET attempted_at=?,acked_at=?,next_read_at=? WHERE operation_id=?')
        .run(row.authorized_at,this.now(),this.now()+30_000,operationId);return {accepted:true};
    }catch{this.fail(row,'LOADING_RELOAD_UNKNOWN_NO_REPLAY','UNKNOWN');return {accepted:false};}
  }
  tick(){
    if(this.closed)return;
    for(const row of this.db.prepare("SELECT * FROM loading_recoveries WHERE stage NOT IN ('DONE','FAILED','UNKNOWN')").all()){
      if(this.now()>=row.deadline_at){this.fail(row,'LOADING_RECOVERY_TIMEOUT','UNKNOWN');continue;}
      if(['QUEUED','CLAIMED'].includes(row.stage)||row.next_read_at>this.now()||this.transport.pending.has(row.workstream_id)||this.jobs.has(row.workstream_id))continue;
      const job=Promise.resolve().then(()=>{this.current(row);return this.transport.read(row.workstream_id,{loadingRecoveryId:row.operation_id});})
        .then(page=>{if(!page&&!this.closed)this.fail(row,'LOADING_OBSERVATION_UNAVAILABLE');})
        .catch(()=>{if(!this.closed)this.fail(row,'LOADING_PRECONDITION_CHANGED');}).finally(()=>this.jobs.delete(row.workstream_id));
      this.jobs.set(row.workstream_id,job);
    }
  }
  stop(id){
    this.db.prepare('UPDATE loading_recovery_scopes SET enabled=0 WHERE workstream_id=?').run(id);
    const row=this.active(id);if(row)this.fail(row,'LOADING_PERMISSION_REVOKED','UNKNOWN');
  }
  close(){this.closed=true;return Promise.allSettled([...this.jobs.values()]);}
}
