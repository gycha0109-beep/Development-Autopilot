import {randomUUID} from "node:crypto";
import {projectObservation} from "./chat-observation.js";
import {decideNextAction} from "./autopilot-decision.js";

// Additive local DB records, never Watchtower's registry or operator data.
export class AutopilotState {
  constructor(store,{now=()=>Date.now()}={}) {
    this.store=store;this.db=store.db;this.now=now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autopilot_observations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id TEXT NOT NULL REFERENCES workstreams(id),task_revision INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,snapshot TEXT NOT NULL,decision TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS autopilot_observation_latest ON autopilot_observations(workstream_id,id DESC);
      CREATE TABLE IF NOT EXISTS autopilot_response_claims(
        operation_id TEXT PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id),
        task_revision INTEGER NOT NULL,binding_fingerprint TEXT NOT NULL,reply_fingerprint TEXT NOT NULL,
        action_fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('reserved','submitted','blocked','unknown')),
        command_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        UNIQUE(workstream_id,binding_fingerprint,reply_fingerprint)) STRICT;
    `);
  }
  latest(id,offset=0) {
    const row=this.db.prepare("SELECT * FROM autopilot_observations WHERE workstream_id=? ORDER BY id DESC LIMIT 1 OFFSET ?").get(id,offset);
    return row?{...row,observation:JSON.parse(row.snapshot),decision:JSON.parse(row.decision)}:null;
  }
  pending(id,{intentId="",commandId="",recoveryId="",migrationId=""}={}) {
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_requests'").get()){
      const request=this.db.prepare("SELECT id,state AS status FROM operator_requests WHERE workstream_id=? AND state NOT IN ('closed','consumed') LIMIT 1").get(id);
      if(request)return request;
    }
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autopilot_migrations'").get()){
      const migration=this.db.prepare("SELECT id,status FROM autopilot_migrations WHERE workstream_id=? AND id<>? AND status<>'completed'").get(id,migrationId);
      if(migration)return migration;
    }
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autopilot_recoveries'").get()){
      const recovery=this.db.prepare("SELECT episode_id AS id,stage AS status FROM autopilot_recoveries WHERE workstream_id=? AND episode_id<>? AND stage<>'DONE'").get(id,recoveryId);
      if(recovery)return recovery;
    }
    const claim=this.db.prepare("SELECT operation_id AS id,status FROM autopilot_response_claims WHERE workstream_id=? AND operation_id<>? AND status IN ('reserved','unknown') LIMIT 1").get(id,intentId);
    if(claim)return claim;
    const table=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_continuation_commands'").get();
    return table ? this.db.prepare("SELECT id,state AS status FROM chat_continuation_commands WHERE workstream_id=? AND id<>? AND state IN ('queued','claimed','unknown') LIMIT 1").get(id,commandId)||null : null;
  }
  context(id,context) {
    return {...context,workstream:this.store.mustGet(id),globalStopped:this.store.isStopped(),operation:this.pending(id),now:this.now()};
  }
  evaluate(id,input,context={}) {
    return this.store.transaction(()=>{
      const observation=projectObservation(input);
      const prior=this.latest(id);
      const revision=this.store.mustGet(id).task_revision;
      if(prior && observation.observedAt<=prior.observed_at)
        return {...decideNextAction({...this.context(id,context),observation,
          operation:{status:"non-monotonic"}}),reasonCode:"NON_MONOTONIC_OBSERVATION"};
      const decision=decideNextAction({...this.context(id,context),observation,
        previous:prior?.task_revision===revision?prior.observation:null});
      this.db.prepare("INSERT INTO autopilot_observations(workstream_id,task_revision,observed_at,snapshot,decision) VALUES(?,?,?,?,?)")
        .run(id,revision,observation.observedAt??this.now(),JSON.stringify(observation),JSON.stringify(decision));
      this.store.event(id,this.now(),"autopilot_observed",null,null,decision.reasonCode);
      return decision;
    });
  }
  reserve(id,expectedActionFingerprint,context={}) {
    return this.store.transaction(()=>{
      const current=this.latest(id),prior=this.latest(id,1);
      if(!current)return null;
      const input=this.context(id,context);
      const decision=decideNextAction({...input,observation:current.observation,
        previous:prior?.task_revision===input.workstream.task_revision?prior.observation:null});
      if(current.task_revision!==input.workstream.task_revision || decision.nextAction!=="CONTINUE" ||
          decision.actionFingerprint!==expectedActionFingerprint)return null;
      const exists=this.db.prepare("SELECT 1 FROM autopilot_response_claims WHERE workstream_id=? AND binding_fingerprint=? AND reply_fingerprint=?")
        .get(id,current.observation.bindingFingerprint,current.observation.replyFingerprint);
      if(exists)return null;
      const operationId=randomUUID();
      this.db.prepare("INSERT INTO autopilot_response_claims(operation_id,workstream_id,task_revision,binding_fingerprint,reply_fingerprint,action_fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'reserved',?,?)")
        .run(operationId,id,current.task_revision,current.observation.bindingFingerprint,current.observation.replyFingerprint,
          decision.actionFingerprint,this.now(),this.now());
      this.store.event(id,this.now(),"autopilot_intent",null,null,"RESERVED_BEFORE_DISPATCH",operationId);
      return {operationId,workstreamId:id,actionFingerprint:decision.actionFingerprint};
    });
  }
  reconsider(id,context={}) {
    return this.store.transaction(()=>{
      const current=this.latest(id),prior=this.latest(id,1);
      if(!current)return null;
      const workstream=this.store.mustGet(id);
      const decision=decideNextAction({...this.context(id,context),observation:current.observation,
        previous:prior?.task_revision===workstream.task_revision?prior.observation:null});
      this.db.prepare("UPDATE autopilot_observations SET decision=? WHERE id=?").run(JSON.stringify(decision),current.id);
      if(decision.reasonCode!==current.decision.reasonCode)this.store.event(id,this.now(),"autopilot_reconsidered",null,null,decision.reasonCode);
      return decision;
    });
  }
  settle(operationId,status,commandId=null) {
    if(!["submitted","blocked","unknown"].includes(status) || (commandId!==null && typeof commandId!=="string"))throw Error("INVALID_AUTOPILOT_RECEIPT");
    return this.store.transaction(()=>{
      const row=this.db.prepare("SELECT * FROM autopilot_response_claims WHERE operation_id=?").get(operationId);
      if(!row||row.status!=="reserved")throw Error("AUTOPILOT_INTENT_ALREADY_SETTLED");
      this.db.prepare("UPDATE autopilot_response_claims SET status=?,command_id=?,updated_at=? WHERE operation_id=?").run(status,commandId,this.now(),operationId);
      this.store.event(row.workstream_id,this.now(),"autopilot_receipt",null,null,status.toUpperCase(),operationId);
      return {operationId,status,commandId};
    });
  }
  reconcile() {
    return this.store.transaction(()=>{
      const rows=this.db.prepare("SELECT operation_id,workstream_id FROM autopilot_response_claims WHERE status='reserved'").all();
      for(const row of rows){
        this.db.prepare("UPDATE autopilot_response_claims SET status='unknown',updated_at=? WHERE operation_id=?").run(this.now(),row.operation_id);
        this.store.event(row.workstream_id,this.now(),"autopilot_unknown",null,null,"RESTART_NO_REPLAY",row.operation_id);
      }
      return rows.length;
    });
  }
}
