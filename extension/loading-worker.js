import {readRequestedObservation} from './observation-worker.js';
import {sessionStatus} from './core.js';

export async function executeLoadingReload(command,a){
  const receipt=outcome=>({operationId:command?.operationId,outcome});
  try{
    const resolve=async()=>{
      const [registry,view,epoch]=await Promise.all([a.load(),a.snapshot(),a.epoch()]);
      const s=registry.sessions.find(s=>s.key===command.sessionKey),g=registry.groups.find(g=>g.key===s?.groupKey);
      if(!s||s.paused||g?.paused||sessionStatus(s,registry,view,epoch)!=='connected')throw Error();
      if(await a.busy(s.key))throw Error();
      return {s,g,epoch};
    };
    const initial=await resolve(),request={...command,loadingRecoveryId:command.operationId};
    const safe=page=>page?.verified===false&&page.reasonCode==='ASSISTANT_RESPONSE_UNAVAILABLE'&&page.loadingSafety?.safe===true&&
      page.loadingSafety.failed===true&&page.loadingSafety.bindingFingerprint===command.bindingFingerprint&&
      page.loadingSafety.userFingerprint===command.userFingerprint;
    const page=await readRequestedObservation(request,a);
    if(!safe(page)||(await a.authorize(command.operationId,page))?.authorized!==true)return receipt('refused');
    // Reinspect immediately after the round trip; a newly typed draft or a new
    // user turn invalidates the effect even if the server granted permission.
    if(!safe(await readRequestedObservation(request,a))||JSON.stringify(initial)!==JSON.stringify(await resolve()))return receipt('refused');
    if(await a.markAttempt(command.operationId)!==true)return receipt('unknown');
    await a.reload(initial.s.tabId);return receipt('started');
  }catch{return receipt('unknown');} // Never retry an uncertain reload.
}
