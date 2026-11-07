// These functions are serialized into the exact user-approved ChatGPT tab.
// They read only the latest source handoff reply or a transferred user turn.
export const GENERIC_HANDOFF_MARKER="AUTOPILOT_GENERIC_CHAT_HANDOFF";
export function captureGenericHandoff(marker,nonce,baselineAssistantId=null){
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com"||!/^\/c\/[^/]+\/?$/.test(location.pathname))
    return refuse("SOURCE_NOT_PLAIN_CHAT");
  if(typeof marker!=="string"||!/^[A-Z_]{12,60}$/.test(marker)||
    !/^[a-f0-9-]{36}$/.test(nonce||""))
    return refuse("HANDOFF_CONTEXT_INVALID");
  const busy=[...document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  )].some(b=>!b.disabled&&b.getClientRects?.().length);
  if(busy)return refuse("SOURCE_STILL_GENERATING");
  const articles=[...document.querySelectorAll('article[data-turn], [data-message-author-role]')];
  const unique=[...new Set(articles)].filter(x=>
    !x.parentElement?.closest?.('[data-message-author-role],article[data-turn]'));
  const role=el=>el.getAttribute("data-turn")||el.getAttribute("data-message-author-role");
  const filtered=unique.filter(x=>["assistant","user"].includes(role(x)));
  const last=filtered.at(-1);
  if(role(last)!=="assistant")return refuse("SOURCE_ASSISTANT_NOT_LAST");
  const prior=filtered.slice(0,-1).reverse().find(x=>role(x)==="user");
  if(!prior)return refuse("SOURCE_AUTHORING_REQUEST_NOT_FOUND");
  const request=(prior.innerText||prior.textContent||"").trim();
  if(!request.includes("AUTOPILOT_GENERIC_REQUEST_V1")||
    !request.includes(marker)||!request.includes(nonce))
    return refuse("SOURCE_AUTHORING_REQUEST_MISMATCH");
  const messageId=last.getAttribute("data-message-id")||
    last.getAttribute("data-turn-id")||null;
  if(baselineAssistantId&&messageId&&messageId===baselineAssistantId)
    return refuse("SOURCE_OLD_ASSISTANT_RESPONSE");
  const content=(last.querySelector(".markdown,[data-testid='message-content']")||last);
  const body=(content.innerText||content.textContent||"").trim();
  const markerLine=marker+" "+nonce;
  if(!body.startsWith(markerLine))return refuse("SOURCE_HANDOFF_MARKER_NOT_FIRST");
  const handoff=body.slice(markerLine.length).trim();
  if(handoff.length<120||handoff.length>24000)
    return refuse("SOURCE_HANDOFF_LENGTH_INVALID");
  return {ok:true,body:handoff,evidence:"VERIFIED_ASSISTANT_AFTER_EXACT_SOURCE_REQUEST",
    messageId,nonce};
}
export function inspectGenericTransferredChat(marker,nonce,projectId=null,trackTitle=null){
  const refuse=reason=>({ok:false,reason});
  const path=location.pathname;
  const target=projectId?
    new RegExp("^/g/"+projectId+"/c/[^/]+/?$"):
    /^\/c\/[^/]+\/?$/;
  if(location.origin!=="https://chatgpt.com"||
    (projectId!==null&&!/^g-p-[a-zA-Z0-9-]+$/.test(projectId))||
    !target.test(path))
    return refuse("TRANSFER_TARGET_WRONG_SCOPE");
  const rows=[...document.querySelectorAll('article[data-turn], [data-message-author-role]')];
  const unique=[...new Set(rows)].filter(x=>
    !x.parentElement?.closest?.('[data-message-author-role],article[data-turn]'));
  const role=x=>x.getAttribute("data-turn")||x.getAttribute("data-message-author-role");
  const users=unique.filter(x=>role(x)==="user");
  let submitted=users.at(-1);
  // Current ChatGPT DIL renderer may omit legacy author-role nodes. Accept
  // only the latest exact user unit under a uniquely identified live turn.
  if(!submitted){
    const main=document.querySelector?.("main");
    const turns=[...document.querySelectorAll("[data-content-search-turn-key]")]
      .filter(el=>main?.contains?.(el));
    const turn=turns.at(-1),turnKey=turn?.getAttribute?.("data-content-search-turn-key");
    if(turn&&turnKey){
      const units=[...turn.querySelectorAll("[data-chatgpt-search-unit-key]")]
        .filter(el=>el.closest?.("[data-content-search-turn-key]")===turn);
      const user=units.filter(el=>{
        const key=el.getAttribute("data-chatgpt-search-unit-key")||"";
        return key.startsWith(turnKey+":")&&/:\d+:user$/.test(key);
      });
      if(user.length===1)submitted=user[0];
    }
  }
  if(!submitted)return refuse("TRANSFER_USER_TURN_NOT_FOUND");
  const text=(submitted.innerText||submitted.textContent||"").trim();
  if(!text.includes(marker+" "+nonce)||text.length<120||text.length>30000)
    return refuse("TRANSFER_HANDOFF_NOT_VERIFIED");
  if(typeof trackTitle!=="string"||trackTitle.length<2||
     !text.includes("AUTOPILOT_TRACK_LOCK_V1 "+nonce+" :: "+trackTitle))
    return refuse("TRANSFER_TRACK_IDENTITY_UNVERIFIED");
  return {ok:true,source:"EXACT_TRANSFER_USER_TURN"};
}
export function inspectGenericFirstReply(marker,nonce,projectId=null,trackTitle=null){
  const refused=reason=>({ok:false,reason});
  const target=projectId?
    new RegExp("^/g/"+projectId+"/c/[^/]+/?$"):
    /^\/c\/[^/]+\/?$/;
  if(location.origin!=="https://chatgpt.com"||
    (projectId!==null&&!/^g-p-[a-zA-Z0-9-]+$/.test(projectId))||
    !target.test(location.pathname)||
    !/^[a-f0-9-]{36}$/.test(nonce||"")||
    !/^[A-Z_]{12,60}$/.test(marker||""))
    return refused("TRANSFER_TARGET_NOT_PLAIN_CHAT");
  const transferredUsers=[...document.querySelectorAll(
    'article[data-turn="user"],[data-message-author-role="user"]')];
  const uniqueUsers=[...new Set(transferredUsers)].filter(x=>
    !x.parentElement?.closest?.('[data-message-author-role],article[data-turn]'));
  let transferred=uniqueUsers.at(-1),dilTurn=null,dilUnits=[];
  if(!transferred){
    const main=document.querySelector?.("main");
    const turns=[...document.querySelectorAll("[data-content-search-turn-key]")]
      .filter(el=>main?.contains?.(el));
    const turn=turns.at(-1),turnKey=turn?.getAttribute?.("data-content-search-turn-key");
    if(turn&&turnKey){
      const units=[...turn.querySelectorAll("[data-chatgpt-search-unit-key]")]
        .filter(el=>el.closest?.("[data-content-search-turn-key]")===turn);
      const users=units.filter(el=>{
        const key=el.getAttribute("data-chatgpt-search-unit-key")||"";
        return key.startsWith(turnKey+":")&&/:\d+:user$/.test(key);
      });
      if(users.length===1 && users[0].getClientRects?.().length){
        transferred=users[0];dilTurn=turn;dilUnits=units;
      }
    }
  }
  const handoff=(transferred?.innerText||transferred?.textContent||"").trim();
  if(!handoff.includes(marker+" "+nonce)||handoff.length<120||
    handoff.length>30000)
    return refused("TRANSFER_HANDOFF_NOT_VERIFIED");
  if(typeof trackTitle!=="string"||trackTitle.length<2||
     !handoff.includes("AUTOPILOT_TRACK_LOCK_V1 "+nonce+" :: "+trackTitle))
    return refused("TRANSFER_TRACK_IDENTITY_UNVERIFIED");
  const busy=[...document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  )].some(b=>!b.disabled&&b.getClientRects?.().length);
  if(busy)return refused("TARGET_REPLY_STILL_GENERATING");
  const rows=[...document.querySelectorAll('article[data-turn], [data-message-author-role]')];
  const unique=[...new Set(rows)].filter(x=>
    !x.parentElement?.closest?.('[data-message-author-role],article[data-turn]'));
  const role=x=>x?.getAttribute?.("data-turn")||x?.getAttribute?.("data-message-author-role");
  let text="";
  if(role(unique.at(-1))==="assistant"){
    text=(unique.at(-1).innerText||unique.at(-1).textContent||"").trim();
  }else if(dilTurn&&dilUnits.length){
    // Current DIL renderer: require a uniquely identified, completed final
    // assistant body in the same turn as the exact transferred user request.
    const turnKey=dilTurn.getAttribute("data-content-search-turn-key")||"";
    const assistants=dilUnits.filter(el=>{
      const key=el.getAttribute("data-chatgpt-search-unit-key")||"";
      return key.startsWith(turnKey+":")&&/:\d+:assistant$/.test(key);
    });
    if(assistants.length!==1)return refused("TARGET_ASSISTANT_NOT_LAST");
    const assistant=assistants[0],i=dilUnits.indexOf(assistant);
    if(i<0||dilUnits.slice(i+1).some(el=>
      /:\d+:user$/.test(el.getAttribute("data-chatgpt-search-unit-key")||"")))
      return refused("TARGET_ASSISTANT_NOT_LAST");
    const ids=[...new Set((assistant.getAttribute("data-chatgpt-search-message-ids")||"")
      .split(/\s+/).filter(Boolean))];
    const bodies=[...assistant.querySelectorAll("[data-dil-message-id]")]
      .filter(el=>el.getClientRects?.().length);
    const states=[...dilTurn.querySelectorAll("[data-talvt-turn-state]")]
      .filter(el=>el.getClientRects?.().length);
    const body=bodies.length===1?bodies[0]:null;
    if(ids.length!==1||!/^[a-zA-Z0-9-]{1,100}$/.test(ids[0])||
       body?.getAttribute("data-dil-message-id")!==ids[0]||
       !body?.closest?.('[data-markdown-text-style="assistant-message"]')||
       states.length!==1||states[0].getAttribute("data-talvt-turn-state")!=="complete"||
       !states[0].contains?.(assistant))
      return refused("TARGET_REPLY_COMPLETION_NOT_VERIFIED");
    text=(body.innerText||body.textContent||"").trim();
  }else return refused("TARGET_ASSISTANT_NOT_LAST");
  if(text.length<20||text.length>100000)return refused("TARGET_REPLY_BODY_UNVERIFIED");
  if(!text.slice(0,600).includes("AUTOPILOT_TRACK_ACK "+nonce+" :: "+trackTitle))
    return refused("TARGET_TRACK_ACK_NOT_VERIFIED");
  let hash=2166136261;
  for(const char of text)hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;
  return {ok:true,replyFingerprint:text.length+":"+hash.toString(16)};
}
