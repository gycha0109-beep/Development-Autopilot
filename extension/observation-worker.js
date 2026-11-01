import {sessionStatus} from "./core.js";
import {captureChatObservation} from "./chat-observer.js";
import {inspectLoadingPage} from "./loading-page.js";

// This module reads only a server-requested, explicitly registered physical tab.
export async function readRequestedObservation(request,{load,snapshot,epoch,getTab,execute,now=()=>Date.now()}){
  const fail=()=>({schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",verified:false,observedAt:now()});
  try{
    const registry=await load(),view=await snapshot(),token=await epoch();
    const session=registry.sessions.find(s=>s.key===request.sessionKey);
    const group=registry.groups.find(g=>g.key===session?.groupKey);
    if(!session||session.paused||group?.paused||sessionStatus(session,registry,view,token)!=="connected")return fail();
    const windowId=session.groupKey===""?session.windowId:group?.windowId;
    const groupId=session.groupKey===""?-1:group?.groupId;
    if(!Number.isInteger(windowId)||!Number.isInteger(groupId))return fail();
    const matches=tab=>tab?.id===session.tabId&&tab.windowId===windowId&&
      tab.groupId===groupId&&tab.url===session.url;
    const url=new URL(session.url);
    if(url.origin!=="https://chatgpt.com"||url.search||url.hash||url.username||url.password||
      !/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(url.pathname)||!matches(await getTab(session.tabId)))return fail();
    const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([
      request.workstreamId,session.key,session.tabId,windowId,groupId,session.url])));
    const bindingFingerprint=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
    const results=await execute({target:{tabId:session.tabId,allFrames:false},world:"ISOLATED",
      func:captureChatObservation,args:[{permitted:true,expectedPath:url.pathname,bindingFingerprint,
        ...(request.recoveryOperationId?{recoveryOperationId:request.recoveryOperationId}:{})}]});
    if(results.length!==1)return fail();
    if(results[0]?.result?.reasonCode==='ASSISTANT_RESPONSE_UNAVAILABLE'||request.loadingRecoveryId){
      const proof=await execute({target:{tabId:session.tabId,allFrames:false},world:'ISOLATED',func:inspectLoadingPage,
        args:[{permitted:true,expectedPath:url.pathname,bindingFingerprint}]});
      if(proof.length===1&&proof[0]?.result)results[0].result.loadingSafety=proof[0].result;
    }
    if(!matches(await getTab(session.tabId)))return fail();
    const after=await load(),afterSession=after.sessions.find(s=>s.key===session.key);
    if(JSON.stringify(afterSession)!==JSON.stringify(session)||
      (group&&JSON.stringify(after.groups.find(g=>g.key===group.key))!==JSON.stringify(group))||
      await epoch()!==token)return fail();
    return {...results[0].result,observedAt:now()};
  }catch{return fail();}
}

export function matchesContinuationProof(observation,proof){
  return !!proof&&observation?.verified===true&&observation.bindingFingerprint===proof.bindingFingerprint&&
    observation.replyFingerprint===proof.replyFingerprint&&observation.assistantBusy===false&&
    observation.composerHasDraft===false&&observation.contentComplete===true&&
    ["stopControlVerified","connectionWarning","lengthWarning","providerRestriction","otherWarning","uiAmbiguous",
      "humanActionCue","scopeCompleteCue"].every(key=>observation[key]===false)&&
    observation.ciWaitCue===proof.ciWaitCue;
}
