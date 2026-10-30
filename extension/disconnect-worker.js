import {sessionStatus} from "./core.js";
import {readRequestedObservation} from "./observation-worker.js";
import {submitToExistingChatGPT} from "./chat-page.js";
import {clickVerifiedDisconnectStop,RECOVERY_REPORT_MESSAGE} from "./disconnect-page.js";

export async function executeRecoveryCommand(command,adapters){
  const receipt=(outcome="unknown",extra={})=>({operationId:command?.operationId,
    bindingFingerprint:command?.bindingFingerprint,outcome,...extra});
  if(!["stop","report"].includes(command?.kind)||!/^[a-f0-9-]{36}$/.test(command.operationId||""))return receipt();
  try{
    const resolve=async()=>{
      const [registry,view,epoch]=await Promise.all([adapters.load(),adapters.snapshot(),adapters.epoch()]);
      const session=registry.sessions.find(s=>s.key===command.sessionKey),group=registry.groups.find(g=>g.key===session?.groupKey);
      if(!session||session.paused||group?.paused||sessionStatus(session,registry,view,epoch)!=="connected")throw Error("RECOVERY_SESSION_CHANGED");
      return {session,group,epoch};
    };
    const initial=await resolve();
    const request={...command,recoveryOperationId:command.operationId};
    const pre=await readRequestedObservation(request,adapters);
    if(pre.verified!==true||pre.bindingFingerprint!==command.bindingFingerprint||
      pre.composerHasDraft!==false||pre.uiAmbiguous||pre.providerRestriction||pre.humanActionCue||pre.otherWarning||pre.lengthWarning)
      return receipt();
    if(command.kind==="stop"?pre.assistantBusy!==true||!pre.connectionWarning||!pre.stopControlVerified||pre.ciWaitCue:
      pre.assistantBusy!==false||pre.connectionWarning||pre.stopControlVerified)return receipt();
    if((await adapters.authorize(command.operationId,pre))?.authorized!==true)return receipt();
    const current=await resolve();
    if(JSON.stringify(initial)!==JSON.stringify(current))return receipt();
    const path=new URL(current.session.url).pathname;
    const results=await adapters.execute({target:{tabId:current.session.tabId,allFrames:false},world:"ISOLATED",
      func:command.kind==="stop"?clickVerifiedDisconnectStop:submitToExistingChatGPT,
      args:command.kind==="stop"?[{permitted:true,operationId:command.operationId,expectedPath:path}]:
        [RECOVERY_REPORT_MESSAGE,"continuation",path]});
    if(results.length!==1||results[0]?.result?.clicked!==true)return receipt();
    if(command.kind==="stop")return receipt("clicked");
    // A click is insufficient report provenance. Independently find exactly the
    // fixed prompt under a new user message ID in this same physical session.
    for(let attempt=0;attempt<20;attempt++){
      const observed=await readRequestedObservation(request,adapters),proof=observed.recoveryReportProof;
      if(observed.verified===true&&observed.bindingFingerprint===command.bindingFingerprint&&
        proof?.operationId===command.operationId&&proof.userFingerprint!==pre.recoveryUserFingerprint&&
        /^[a-f0-9]{64}$/.test(proof.userFingerprint||""))return receipt("submitted",{userFingerprint:proof.userFingerprint});
      await new Promise(resolve=>setTimeout(resolve,200));
    }
  }catch{ /* An uncertain write is terminal for this command, never retried. */ }
  return receipt();
}
