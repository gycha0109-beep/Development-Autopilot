import {randomUUID} from "node:crypto";
import {hashAction} from "./autopilot-decision.js";

// Pause/resume hooks run inside existing ChatContinuation transactions.
// Proof acquisition is read-only and has no default real-browser adapter.
export class MigrationContinuity {
  constructor(coordinator,{verify=null}={}){
    this.owner=coordinator;this.verify=verify;
    this.db=coordinator.db;this.store=coordinator.store;
    this.db.exec(`CREATE TABLE IF NOT EXISTS autopilot_migrations(
      workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),id TEXT NOT NULL,
      extension_id TEXT NOT NULL,session_key TEXT NOT NULL,task_revision INTEGER NOT NULL,
      source_binding TEXT NOT NULL,target_binding TEXT,campaign_hash TEXT NOT NULL,target_hash TEXT NOT NULL,
      schedule TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('paused','verified','completed','unknown')),
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;`);
  }
  get(id){return this.db.prepare("SELECT * FROM autopilot_migrations WHERE workstream_id=?").get(id)||null;}
  campaign(id){const cfg=this.owner.chat.config(id);return hashAction([cfg?.mode,cfg?.message,cfg?.intervalMinutes,
    cfg?.approvedAt,cfg?.expiresAt,cfg?.sentCount,cfg?.maxMessages,cfg?.evidenceHash]);}
  targets(id){return hashAction([this.owner.watchtower.targets.list().filter(t=>t.workstreamId===id),
    this.owner.github.targets.list().filter(t=>t.workstreamId===id)]);}
  pause(id,extensionId,sessionKey){
    if(this.owner.loading?.blocked(id))throw Error('MIGRATION_LOADING_RECOVERY_PENDING');
    const recovery=this.owner.recovery?.get(id);
    if(recovery&&recovery.stage!=="DONE")throw Error("MIGRATION_RECOVERY_PENDING");
    const schedule=this.owner.get(id);if(!schedule)return;
    const existing=this.get(id);
    if(existing&&existing.status!=="completed")return;
    const record={enabled:schedule.enabled,nextInspectAt:schedule.next_inspect_at,
      nextExternalCheckAt:schedule.next_external_check_at};
    this.db.prepare(`INSERT INTO autopilot_migrations(workstream_id,id,extension_id,session_key,task_revision,
      source_binding,campaign_hash,target_hash,schedule,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'paused',?,?) ON CONFLICT(workstream_id) DO UPDATE SET id=excluded.id,
      extension_id=excluded.extension_id,session_key=excluded.session_key,task_revision=excluded.task_revision,
      source_binding=excluded.source_binding,target_binding=NULL,campaign_hash=excluded.campaign_hash,
      target_hash=excluded.target_hash,schedule=excluded.schedule,status='paused',created_at=excluded.created_at,updated_at=excluded.updated_at`)
      .run(id,randomUUID(),extensionId,sessionKey,schedule.task_revision,schedule.binding_fingerprint,this.campaign(id),
        this.targets(id),JSON.stringify(record),this.owner.now(),this.owner.now());
    this.db.prepare("UPDATE autopilot_schedules SET enabled=0,updated_at=? WHERE workstream_id=?").run(this.owner.now(),id);
    this.store.event(id,this.owner.now(),"autopilot_migration_paused",null,null,"EXISTING_IDENTITY_AND_TIMERS_RETAINED");
  }
  safe(row){
    const stream=this.store.mustGet(row.workstream_id),cfg=this.owner.chat.config(row.workstream_id);
    if(this.owner.handoffCapability&&this.owner.handoffCapability(row.workstream_id)!==true)return false;
    return !this.store.isStopped()&&stream.enabled&&!stream.paused&&stream.task_revision===row.task_revision&&
      !stream.active_operation_id&&["OBSERVING","READY"].includes(stream.state)&&
      cfg?.statusReason==="MIGRATION_IN_PROGRESS"&&cfg.expiresAt>this.owner.now()&&cfg.sentCount<cfg.maxMessages&&
      this.campaign(row.workstream_id)===row.campaign_hash&&this.targets(row.workstream_id)===row.target_hash&&
      (row.status!=="verified"||this.owner.now()-row.updated_at<=this.owner.get(row.workstream_id).policy.maxAgeMs)&&
      !this.owner.state.pending(row.workstream_id,{migrationId:row.id});
  }
  async verifyRebind(id){
    const row=this.get(id);
    if(!row||row.status!=="paused"||!this.verify||!this.safe(row))return false;
    let proof;try{proof=await this.verify({workstreamId:id,migrationId:row.id,extensionId:row.extension_id,
      sessionKey:row.session_key,sourceBindingFingerprint:row.source_binding});}catch{return false;}
    return this.store.transaction(()=>{
      const current=this.get(id);
      if(current?.id!==row.id||current.status!=="paused"||!this.safe(current))return false;
      if(proof?.verified!==true||proof.migrationId!==row.id||proof.sourceBindingFingerprint!==row.source_binding||
        proof.workstreamId!==id||proof.extensionId!==row.extension_id||proof.sessionKey!==row.session_key||
        proof.samePhysicalTab!==true||proof.sameProject!==true||proof.sourceAuthored!==true||
        proof.firstReplyVerified!==true||proof.titleNPlusOneVerified!==true||proof.watchRetained!==true||
        !/^[a-f0-9]{64}$/.test(proof.bindingFingerprint||"")||proof.bindingFingerprint===row.source_binding||
        !Number.isSafeInteger(proof.observedAt)||proof.observedAt<row.created_at||proof.observedAt>this.owner.now()||
        this.owner.now()-proof.observedAt>this.owner.get(id).policy.maxAgeMs)return false;
      this.db.prepare("UPDATE autopilot_migrations SET target_binding=?,status='verified',updated_at=? WHERE workstream_id=?")
        .run(proof.bindingFingerprint,proof.observedAt,id);
      return true;
    });
  }
  canResume(id){
    if(!this.owner.get(id))return true;
    const row=this.get(id);
    if(row?.status==="completed")return true;
    return !!row&&row.status==="verified"&&this.safe(row);
  }
  resumed(id){
    if(!this.owner.get(id))return;
    const row=this.get(id);if(!row||row.status!=="verified")throw Error("MIGRATION_REBIND_PROOF_REQUIRED");
    const before=JSON.parse(row.schedule),schedule=this.owner.get(id),now=this.owner.now();
    this.db.prepare("UPDATE autopilot_schedules SET enabled=?,binding_fingerprint=?,next_inspect_at=?,next_external_check_at=?,updated_at=?,observation_after=? WHERE workstream_id=?")
      .run(Number(before.enabled),row.target_binding,Math.max(now,before.nextInspectAt),
        before.nextExternalCheckAt===null?null:Math.max(now+schedule.policy.externalIntervalMs,before.nextExternalCheckAt),now,now,id);
    this.db.prepare("UPDATE autopilot_migrations SET status='completed',updated_at=? WHERE workstream_id=?").run(now,id);
    this.store.event(id,now,"autopilot_migration_resumed",null,null,"VERIFIED_SAME_TAB_SCOPE_AND_TIMERS_RESTORED");
  }
}
