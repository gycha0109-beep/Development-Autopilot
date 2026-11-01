import {sessionStatus} from "./core.js";
import {classifyChatGPTRoute} from "./chat-routes.js";
import {submitToExistingChatGPT} from "./chat-page.js";
import {readRequestedObservation,matchesContinuationProof,
  matchesRecoveryProof} from "./observation-worker.js";

// Common physical ChatGPT dispatch lane for Workstream and chat-only macros.
// Claims and acknowledgements remain in the existing persistent stores.
export async function dispatchRegisteredChatCommand(command,adapters,{allowNew=false}={}){
  const result=(status,reason)=>({status,reason});
  if(!command||typeof command.sessionKey!=="string"||
    typeof command.message!=="string"||!command.message.length||
    command.message.length>800)return result("blocked","COMMAND_INVALID");
  try{
    const [registry,view,token]=await Promise.all([
      adapters.load(),adapters.snapshot(),adapters.epoch()
    ]);
    const session=registry.sessions.find(s=>s.key===command.sessionKey);
    const group=registry.groups.find(g=>g.key===session?.groupKey);
    if(!session||session.paused||group?.paused||
      sessionStatus(session,registry,view,token)!=="connected")
      return result("blocked","SESSION_NOT_CONNECTED");
    const tab=view.tabs.find(t=>t.id===session.tabId);
    const route=classifyChatGPTRoute(tab?.url);
    if(!route||(route!=="existing"&&
      !(allowNew===true&&["new","project-new"].includes(route))))
      return result("blocked","UNSUPPORTED_CHATGPT_PAGE");
    if(command.observationProof||command.recoveryProof){
      const request={sessionKey:command.sessionKey,
        workstreamId:command.workstreamId||"macro:"+command.sessionKey,
        permitted:true};
      const proof=await readRequestedObservation(request,adapters);
      if(command.observationProof&&
        !matchesContinuationProof(proof,command.observationProof))
        return result("blocked","OBSERVATION_PRECONDITION_CHANGED");
      if(command.recoveryProof&&
        !matchesRecoveryProof(proof,command.recoveryProof))
        return result("blocked","RECOVERY_PRECONDITION_CHANGED");
    }
    if((await adapters.authorized())!==true)
      return result("blocked","GLOBAL_STOP_OR_PAIRING_CHANGED");
    // Both the registration and the physical tab must remain unchanged
    // immediately before execution; merely matching a title is insufficient.
    const [latestRegistry,latestView,latestEpoch,latestTab]=await Promise.all([
      adapters.load(),adapters.snapshot(),adapters.epoch(),adapters.getTab(session.tabId)
    ]);
    const latest=latestRegistry.sessions.find(s=>s.key===session.key);
    if(latestEpoch!==token||JSON.stringify(latest)!==JSON.stringify(session)||
      sessionStatus(latest,latestRegistry,latestView,latestEpoch)!=="connected"||
      latestTab?.url!==session.url||latestTab?.id!==session.tabId||
      latestTab?.windowId!==tab.windowId||latestTab?.groupId!==tab.groupId)
      return result("blocked","CHAT_IDENTITY_CHANGED");
    const path=new URL(session.url).pathname;
    const sent=await adapters.execute({
      target:{tabId:session.tabId,allFrames:false},world:"ISOLATED",
      func:submitToExistingChatGPT,
      args:[command.message,"continuation",path]
    });
    if(sent.length!==1||!sent[0]?.result)return result("unknown","INJECTION_RESULT_UNCERTAIN");
    return sent[0].result.clicked===true?
      result("sent",sent[0].result.reason||"COMPOSER_CLICK_CONFIRMED"):
      result("blocked",sent[0].result.reason||"COMPOSER_REFUSED");
  }catch{
    // The browser may have performed a side effect before throwing.
    // An uncertain command is terminal, never automatically resent.
    return result("unknown","DISPATCH_EXCEPTION_UNCERTAIN");
  }
}
