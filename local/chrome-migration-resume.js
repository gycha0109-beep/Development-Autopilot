import {randomUUID} from 'node:crypto';
import {projectObservation} from './chat-observation.js';

// Read-only, process-local challenges. Restart discards every outstanding proof;
// the existing durable migration checkpoint, authority and limits remain intact.
export class ChromeMigrationResume {
  constructor({store,coordinator,transport,now=()=>Date.now()}){
    Object.assign(this,{store,coordinator,transport,now});this.pending=new Map();this.proofs=new Map();
    if(coordinator.migration.verify)throw Error('MIGRATION_VERIFIER_ALREADY_CONFIGURED');
    coordinator.migration.verify=request=>this.proofs.get(request.workstreamId)??null;
  }
  checkpoint(extensionId,sessionKey){
    const row=this.store.db.prepare("SELECT * FROM autopilot_migrations WHERE extension_id=? AND session_key=? AND status='paused'").get(extensionId,sessionKey);
    if(!row||!this.coordinator.migration.safe(row)||this.coordinator.handoffCapability?.(row.workstream_id)!==true)return null;
    try{const scope=this.transport.current(row.workstream_id);if(scope.extension_id!==extensionId||scope.session_key!==sessionKey)return null;}catch{return null;}
    return row;
  }
  challenge(extensionId,sessionKey){
    const row=this.checkpoint(extensionId,sessionKey);if(!row)return null;
    let c=this.pending.get(row.workstream_id);
    if(!c||c.migrationId!==row.id||this.now()>c.deadlineAt){
      c={requestId:randomUUID(),workstreamId:row.workstream_id,migrationId:row.id,extensionId,sessionKey,
        sourceBindingFingerprint:row.source_binding,issuedAt:this.now(),deadlineAt:this.now()+60000};this.pending.set(row.workstream_id,c);
    }
    return {...c};
  }
  async accept(extensionId,sessionKey,proof){
    const row=this.checkpoint(extensionId,sessionKey),c=row&&this.pending.get(row.workstream_id);
    if(!c||c.requestId!==proof?.requestId||c.extensionId!==extensionId||c.sessionKey!==sessionKey||
       c.migrationId!==row.id||c.sourceBindingFingerprint!==row.source_binding||this.now()>c.deadlineAt)
      throw Error('MIGRATION_PROOF_CHALLENGE_NOT_CURRENT');
    this.pending.delete(row.workstream_id); // An invalid or lost proof is never replayed.
    const page=projectObservation(proof.observation,c.issuedAt);
    if(page.verified!==true||page.contentComplete!==true||page.assistantBusy!==false||page.composerHasDraft!==false||
       page.uiAmbiguous!==false||page.connectionWarning||page.lengthWarning||page.providerRestriction||page.otherWarning)
      throw Error('MIGRATION_TARGET_OBSERVATION_UNVERIFIED');
    const value={...c,verified:true,bindingFingerprint:page.bindingFingerprint,observedAt:c.issuedAt,
      sourceBindingFingerprint:proof.sourceBindingFingerprint,
      ...Object.fromEntries(['samePhysicalTab','sameProject','sourceAuthored','firstReplyVerified','titleNPlusOneVerified','watchRetained'].map(k=>[k,proof[k]===true]))};
    this.proofs.set(row.workstream_id,value);
    try{
      if(!await this.coordinator.migration.verifyRebind(row.workstream_id))throw Error('MIGRATION_REBIND_PROOF_REQUIRED');
      this.transport.cancel(row.workstream_id);
      this.store.db.prepare('UPDATE chrome_observation_scopes SET latest=NULL WHERE workstream_id=?').run(row.workstream_id);
      return true;
    }finally{this.proofs.delete(row.workstream_id);}
  }
}
