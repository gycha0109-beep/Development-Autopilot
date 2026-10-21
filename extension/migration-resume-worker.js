import {readRequestedObservation} from './observation-worker.js';
import {projectIdFromUrl} from './migration-core.js';
import {inspectMigrationTarget,readRegisteredChatTitle} from './migration-page.js';

// Evidence comes from the existing migration state machine plus fresh injected
// DOM observations. No extra message, navigation, title mutation or approval.
export async function collectMigrationResumeProof(challenge,state,{registry,snapshot,epoch,watchRetained,
  getTab,execute,now=()=>Date.now()}){
  if(!challenge||!state||state.stage!=='resume_pending'||state.sourceAuthored!==true||
    challenge.sessionKey!==state.sessionKey||now()>challenge.deadlineAt||state.targetTabId!==state.sourceTabId||
    !state.registryRebound||!state.targetConversationUrl||!state.replyFingerprint||!state.stableAt||now()-state.stableAt<6000)return null;
  const session=registry.sessions.find(s=>s.key===challenge.sessionKey),group=registry.groups.find(g=>g.key===session?.groupKey);
  const tab=await getTab(state.targetTabId);
  if(!session||!group||session.tabId!==state.sourceTabId||tab.url!==state.targetConversationUrl||
     session.url!==tab.url||tab.groupId!==state.groupId||tab.windowId!==state.windowId||
     group.groupId!==state.groupId||group.windowId!==state.windowId||!watchRetained||
     projectIdFromUrl(state.sourceUrl)!==state.projectId||projectIdFromUrl(tab.url)!==state.projectId)return null;
  const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(v=>v.toString(16).padStart(2,'0')).join('');
  const sourceBindingFingerprint=await digest([challenge.workstreamId,session.key,state.sourceTabId,state.windowId,state.groupId,state.sourceUrl]);
  if(sourceBindingFingerprint!==challenge.sourceBindingFingerprint)return null;
  const inject=async func=>{const r=await execute({target:{tabId:tab.id,allFrames:false},world:'ISOLATED',func,args:[]});return r.length===1?r[0].result:null;};
  const target=await inject(inspectMigrationTarget),title=await inject(readRegisteredChatTitle);
  if(!target?.ok||!target.projectConversation||target.busy||target.assistantCount<1||
    target.lastReplyFingerprint!==state.replyFingerprint||title?.ok!==true||title.title!==state.nextTitle)return null;
  const observation=await readRequestedObservation(challenge,{load:async()=>registry,snapshot:async()=>snapshot,epoch:async()=>epoch,getTab,execute,now});
  if(observation.verified!==true)return null;
  return {requestId:challenge.requestId,sourceBindingFingerprint,observation,samePhysicalTab:true,sameProject:true,
    sourceAuthored:true,firstReplyVerified:true,titleNPlusOneVerified:true,watchRetained:true};
}
