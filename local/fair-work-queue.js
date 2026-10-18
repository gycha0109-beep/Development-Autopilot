import {randomUUID} from "node:crypto";
import {hashAction} from "./autopilot-decision.js";
export const QUEUE_KINDS=Object.freeze(["inspect","ci","dispatch","recovery","notify"]);
const kinds=QUEUE_KINDS;
const readonly=kind=>kind==="inspect"||kind==="ci";

// Tickets persist eligibility/fairness/leases, never callbacks or authority.
// External writers must still use their domain's pre-effect intent/receipt.
export class FairWorkQueue {
  constructor(store,{limits,now=()=>Date.now()}={}){
    this.store=store;this.db=store.db;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS autopilot_queue_policies(
      kind TEXT PRIMARY KEY,policy TEXT NOT NULL,next_start_at INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS autopilot_queue_tasks(
      id TEXT PRIMARY KEY,workstream_id TEXT REFERENCES workstreams(id),kind TEXT NOT NULL,resource_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','unknown')),
      requested_at INTEGER NOT NULL,next_eligible_at INTEGER NOT NULL,last_started_at INTEGER,
      lease_owner TEXT,lease_until INTEGER,failures INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL,
      UNIQUE(kind,resource_key)) STRICT;`);
    this.store.transaction(()=>{
      for(const kind of kinds){
        const input=limits?.[kind],policy={};
        for(const key of ["maxConcurrent","minIntervalMs","leaseMs","backoffMs","maxFailures"]){
          if(!Number.isSafeInteger(input?.[key]))throw Error("EXPLICIT_QUEUE_LIMITS_REQUIRED");
          policy[key]=input[key];
        }
        if(policy.maxConcurrent<1||policy.maxConcurrent>100||policy.minIntervalMs<0||policy.minIntervalMs>86_400_000||
          policy.leaseMs<1000||policy.leaseMs>86_400_000||policy.backoffMs<1||policy.backoffMs>86_400_000||
          policy.maxFailures<1||policy.maxFailures>10)throw Error("INVALID_QUEUE_LIMITS");
        const existing=this.db.prepare("SELECT policy FROM autopilot_queue_policies WHERE kind=?").get(kind);
        if(existing&&existing.policy!==JSON.stringify(policy))throw Error("QUEUE_POLICY_CHANGE_REQUIRES_REVIEW");
        this.db.prepare("INSERT OR IGNORE INTO autopilot_queue_policies(kind,policy) VALUES(?,?)").run(kind,JSON.stringify(policy));
      }
    });
  }
  policy(kind){const row=this.db.prepare("SELECT policy,next_start_at FROM autopilot_queue_policies WHERE kind=?").get(kind);
    if(!row)throw Error("UNSUPPORTED_QUEUE_KIND");return {...JSON.parse(row.policy),nextStartAt:row.next_start_at};}
  task(kind,key){return this.db.prepare("SELECT * FROM autopilot_queue_tasks WHERE kind=? AND resource_key=?").get(kind,key)||null;}
  delay(policy,id,failures){return Math.min(86_400_000,policy.backoffMs*2**(failures-1)+parseInt(id.slice(0,6),16)%Math.min(1000,policy.backoffMs));}
  reconcile(){
    return this.store.transaction(()=>{
      const expired=this.db.prepare("SELECT * FROM autopilot_queue_tasks WHERE status='running' AND lease_until<=?").all(this.now());
      for(const row of expired){
        const policy=this.policy(row.kind),failures=row.failures+1;
        const retry=readonly(row.kind)&&failures<policy.maxFailures;
        this.db.prepare("UPDATE autopilot_queue_tasks SET status=?,failures=?,next_eligible_at=?,lease_owner=NULL,lease_until=NULL,reason=? WHERE id=?")
          .run(retry?"pending":"unknown",failures,this.now()+this.delay(policy,row.id,failures),"LEASE_EXPIRED_NO_WRITE_REPLAY",row.id);
      }
      return expired.length;
    });
  }
  cancelPending(workstreamId,kind=null){return this.db.prepare("UPDATE autopilot_queue_tasks SET status='completed',reason='OWNER_NO_LONGER_ELIGIBLE' WHERE workstream_id=? AND status='pending' AND (? IS NULL OR kind=?)").run(workstreamId,kind,kind).changes;}
  async run({kind,resourceKey,workstreamId=null},execute){
    if(!kinds.includes(kind)||typeof resourceKey!=="string"||!/^[A-Za-z0-9._:-]{1,100}$/.test(resourceKey)||typeof execute!=="function")
      throw Error("INVALID_QUEUE_TASK");
    this.reconcile();
    const lease=this.store.transaction(()=>{
      const now=this.now(),policy=this.policy(kind),deny=(reasonCode,retryAt=now+1,blocked=false)=>({ran:false,reasonCode,retryAt,blocked});
      if(this.store.isStopped())return deny("GLOBAL_STOP");
      if(workstreamId!==null){const stream=this.store.mustGet(workstreamId);
        if(!stream.enabled||(stream.paused&&kind!=="notify")){this.cancelPending(workstreamId,kind);return deny("WORKSTREAM_PAUSED");}}
      const old=this.task(kind,resourceKey);
      if(old&&old.workstream_id!==workstreamId)throw Error("QUEUE_RESOURCE_OWNER_MISMATCH");
      if(old?.status==="unknown")return deny("QUEUE_REQUIRES_OPERATOR",null,true);
      if(old?.status==="running")return deny("QUEUE_RESOURCE_BUSY");
      const id=hashAction([kind,resourceKey]);
      if(!old)this.db.prepare("INSERT INTO autopilot_queue_tasks(id,workstream_id,kind,resource_key,status,requested_at,next_eligible_at,reason) VALUES(?,?,?,?,'pending',?,?,'REQUESTED')")
        .run(id,workstreamId,kind,resourceKey,now,now);
      else if(old.status==="completed")this.db.prepare("UPDATE autopilot_queue_tasks SET status='pending',requested_at=?,next_eligible_at=?,reason='REQUESTED' WHERE id=?").run(now,now,id);
      const pending=this.task(kind,resourceKey);
      if(pending.next_eligible_at>now)return deny("QUEUE_BACKOFF",pending.next_eligible_at);
      if(policy.nextStartAt>now)return deny("QUEUE_RATE_LIMIT",policy.nextStartAt);
      const running=this.db.prepare("SELECT count(*) n FROM autopilot_queue_tasks WHERE kind=? AND status='running'").get(kind).n;
      if(running>=policy.maxConcurrent)return deny("QUEUE_CONCURRENCY_LIMIT");
      const first=this.db.prepare(`SELECT q.id FROM autopilot_queue_tasks q LEFT JOIN workstreams w ON q.workstream_id=w.id
        WHERE q.kind=? AND q.status='pending' AND q.next_eligible_at<=?
        AND (q.workstream_id IS NULL OR (w.enabled=1 AND (w.paused=0 OR q.kind='notify')))
        ORDER BY COALESCE(q.last_started_at,-1),q.requested_at,q.resource_key LIMIT 1`).get(kind,now);
      if(first?.id!==id)return deny("QUEUE_FAIR_TURN");
      const owner=randomUUID();
      this.db.prepare("UPDATE autopilot_queue_tasks SET status='running',last_started_at=?,lease_owner=?,lease_until=?,reason='LEASED' WHERE id=?")
        .run(now,owner,now+policy.leaseMs,id);
      this.db.prepare("UPDATE autopilot_queue_policies SET next_start_at=? WHERE kind=?").run(now+policy.minIntervalMs,kind);
      return {ran:true,id,owner,policy};
    });
    if(!lease.ran)return lease;
    let value,failed=false;try{value=await execute();}catch{failed=true;}
    return this.store.transaction(()=>{
      const current=this.task(kind,resourceKey);
      if(current.status!=="running"||current.lease_owner!==lease.owner||current.lease_until<=this.now()){
        // Reconcile outside nested transactions on the next run; discard late results.
        return {ran:true,outcome:"unknown",reasonCode:"QUEUE_LEASE_LOST",value:null};
      }
      const failures=failed?current.failures+1:0,retry=failed&&readonly(kind)&&failures<lease.policy.maxFailures;
      const status=failed?(retry?"pending":"unknown"):"completed";
      this.db.prepare("UPDATE autopilot_queue_tasks SET status=?,failures=?,next_eligible_at=?,lease_owner=NULL,lease_until=NULL,reason=? WHERE id=?")
        .run(status,failures,retry?this.now()+this.delay(lease.policy,lease.id,failures):this.now(),
          failed?"JOB_FAILED_REDACTED":"COMPLETED",lease.id);
      return {ran:true,outcome:failed?"failed":"completed",value:failed?null:value,
        reasonCode:failed?status==="unknown"?"QUEUE_REQUIRES_OPERATOR":"QUEUE_BACKOFF":"QUEUE_COMPLETED",
        blocked:status==="unknown",retryAt:retry?this.task(kind,resourceKey).next_eligible_at:null};
    });
  }
}
