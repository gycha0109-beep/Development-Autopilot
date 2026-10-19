import { applyAction, activeGroupFor, normalizedRegistry, sessionStatus } from "./core.js";
import { classifyChatGPTRoute, isCreatedChatRoute } from "./chat-routes.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/i;
const maxCandidates=80;

// An opaque fingerprint lets localhost verify a selected candidate without
// receiving the conversation URL or accidentally selecting a navigated tab.
export async function fingerprintChatUrl(url){
  const bytes=new TextEncoder().encode(url);
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,"0")).join("");
}

export async function discoverChatCandidates(rawRegistry,snapshot,token,{
  hashUrl=fingerprintChatUrl
}={}){
  const registry=normalizedRegistry(rawRegistry);
  const groups=new Map(snapshot.groups.map(g=>[g.id,g]));
  const candidates=[];
  for(const tab of snapshot.tabs){
    const known=registry.sessions.filter(s=>s.tabId===tab.id);
    let rebind=null;
    if(known.length){
      const session=known[0];
      if(known.length!==1||session.paused||
         registry.groups.find(g=>g.key===session.groupKey)?.paused||
         sessionStatus(session,registry,snapshot,token)!=="url-changed"||
         !isCreatedChatRoute(session.url,tab.url))continue;
      rebind={sessionKey:session.key,previousUrlHash:await hashUrl(session.url)};
    }
    const group=groups.get(tab.groupId);
    if(!group||group.windowId!==tab.windowId)continue;
    const route=classifyChatGPTRoute(tab.url);
    if(!route)continue;
    // Offer only grouped ChatGPT tabs. No full URL, transcript, or draft leaves Chrome.
    candidates.push({
      tabId:tab.id,groupId:group.id,windowId:tab.windowId,
      groupLabel:String(group.title||"이름 없는 그룹").slice(0,120),
      title:String(tab.title||"ChatGPT").slice(0,200),
      route,urlHash:await hashUrl(tab.url),...rebind
    });
    if(candidates.length>=maxCandidates)break;
  }
  return candidates;
}

// Called only for a server intent that the operator explicitly created on the
// same-origin localhost dashboard. Recheck the live tab, group and URL before
// touching extension registry; repeated delivery of one intent is idempotent.
export async function enrollApprovedCandidate(intent,{
  load,snapshot,epoch,save,hashUrl=fingerprintChatUrl,now=()=>Date.now()
}){
  if(!intent||!UUID.test(intent.id)||!Number.isSafeInteger(intent.tabId)||
     !Number.isSafeInteger(intent.groupId)||!Number.isSafeInteger(intent.windowId)||
     !HASH.test(intent.urlHash||"")||
     !["new","project-new","existing"].includes(intent.route))
    throw Error("ENROLLMENT_INVALID_INTENT");
  if(intent.expiresAt!=null&&(!Number.isSafeInteger(intent.expiresAt)||now()>intent.expiresAt))
    throw Error("ENROLLMENT_INTENT_EXPIRED");
  const [raw,live,token]=await Promise.all([load(),snapshot(),epoch()]);
  const registry=normalizedRegistry(raw);
  const group=live.groups.find(g=>g.id===intent.groupId&&g.windowId===intent.windowId);
  const tab=live.tabs.find(t=>t.id===intent.tabId&&
    t.groupId===intent.groupId&&t.windowId===intent.windowId);
  if(!group||!tab||classifyChatGPTRoute(tab.url)!==intent.route)
    throw Error("ENROLLMENT_TARGET_CHANGED");
  if(await hashUrl(tab.url)!==intent.urlHash)
    throw Error("ENROLLMENT_CONVERSATION_CHANGED");
  if(intent.sessionKey){
    if(!UUID.test(intent.sessionKey)||!HASH.test(intent.previousUrlHash||"")||intent.route!=="existing"||!Number.isSafeInteger(intent.expiresAt))
      throw Error("ENROLLMENT_INVALID_REBIND");
    const session=registry.sessions.find(s=>s.key===intent.sessionKey);
    const owner=registry.groups.find(g=>g.key===session?.groupKey);
    if(!session||session.tabId!==tab.id||session.paused||owner?.paused||
       owner?.groupId!==group.id||owner?.windowId!==group.windowId||
       session.sessionToken!==token||owner.sessionToken!==token||
       registry.sessions.filter(s=>s.tabId===tab.id).length!==1)
      throw Error("ENROLLMENT_REBIND_TARGET_CHANGED");
    if(session.url===tab.url)return {sessionKey:session.key,urlHash:intent.urlHash,alreadyApplied:true};
    if(!isCreatedChatRoute(session.url,tab.url)||await hashUrl(session.url)!==intent.previousUrlHash)
      throw Error("ENROLLMENT_REBIND_SOURCE_CHANGED");
    const [latest,current,currentEpoch]=await Promise.all([load(),snapshot(),epoch()]);
    if(now()>intent.expiresAt||JSON.stringify(normalizedRegistry(latest))!==JSON.stringify(registry)||currentEpoch!==token||
       !current.tabs.some(t=>t.id===tab.id&&t.windowId===tab.windowId&&t.groupId===tab.groupId&&t.url===tab.url)||
       !current.groups.some(g=>g.id===group.id&&g.windowId===group.windowId))
      throw Error("ENROLLMENT_REBIND_TARGET_CHANGED");
    await save(applyAction(registry,{type:"rebindTab",sessionKey:session.key,tabId:tab.id},live,token));
    return {sessionKey:session.key,urlHash:intent.urlHash,alreadyApplied:false};
  }
  const existing=registry.sessions.find(s=>s.key===intent.id);
  if(existing){
    if(existing.tabId!==tab.id||
       sessionStatus(existing,registry,live,token)!=="connected")
      throw Error("ENROLLMENT_INTENT_ALREADY_APPLIED_DIFFERENT_TARGET");
    return {sessionKey:existing.key,alreadyApplied:true};
  }
  if(registry.sessions.some(s=>s.tabId===tab.id))
    throw Error("ENROLLMENT_TAB_ALREADY_REGISTERED");

  let next=registry;
  let groupKey=activeGroupFor(registry,live,token,group.id)?.key;
  if(!groupKey){
    // Never resurrect a stale registration or repoint it to a new group.
    if(registry.groups.some(g=>g.groupId===group.id))
      throw Error("ENROLLMENT_EXISTING_GROUP_REQUIRES_REBIND");
    next=applyAction(next,{type:"enrollGroup",groupId:group.id},
      live,token,()=>intent.id+"-group",now());
    groupKey=intent.id+"-group";
  }
  next=applyAction(next,{type:"enrollTab",groupKey,tabId:tab.id},
    live,token,()=>intent.id,now());
  await save(next);
  return {sessionKey:intent.id,alreadyApplied:false};
}
