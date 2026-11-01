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
export function inspectGenericTransferredChat(marker,nonce){
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com"||!/^\/c\/[^/]+\/?$/.test(location.pathname))
    return refuse("TRANSFER_TARGET_NOT_PLAIN_CHAT");
  const rows=[...document.querySelectorAll('article[data-turn], [data-message-author-role]')];
  const unique=[...new Set(rows)].filter(x=>
    !x.parentElement?.closest?.('[data-message-author-role],article[data-turn]'));
  const role=x=>x.getAttribute("data-turn")||x.getAttribute("data-message-author-role");
  const users=unique.filter(x=>role(x)==="user");
  const submitted=users.at(-1);
  if(!submitted)return refuse("TRANSFER_USER_TURN_NOT_FOUND");
  const text=(submitted.innerText||submitted.textContent||"").trim();
  if(!text.includes(marker+" "+nonce)||text.length<120||text.length>30000)
    return refuse("TRANSFER_HANDOFF_NOT_VERIFIED");
  return {ok:true,source:"EXACT_TRANSFER_USER_TURN"};
}
export function inspectGenericFirstReply(marker,nonce){
  const refused=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com"||
    !/^\/c\/[^/]+\/?$/.test(location.pathname)||
    !/^[a-f0-9-]{36}$/.test(nonce||"")||
    !/^[A-Z_]{12,60}$/.test(marker||""))
    return refused("TRANSFER_TARGET_NOT_PLAIN_CHAT");
  const transferredUsers=[...document.querySelectorAll(
    'article[data-turn="user"],[data-message-author-role="user"]')];
  const uniqueUsers=[...new Set(transferredUsers)].filter(x=>
    !x.parentElement?.closest?.('[data-message-author-role],article[data-turn]'));
  const transferred=uniqueUsers.at(-1);
  const handoff=(transferred?.innerText||transferred?.textContent||"").trim();
  if(!handoff.includes(marker+" "+nonce)||handoff.length<120||
    handoff.length>30000)
    return refused("TRANSFER_HANDOFF_NOT_VERIFIED");
  const busy=[...document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  )].some(b=>!b.disabled&&b.getClientRects?.().length);
  if(busy)return refused("TARGET_REPLY_STILL_GENERATING");
  const rows=[...document.querySelectorAll('article[data-turn], [data-message-author-role]')];
  const unique=[...new Set(rows)].filter(x=>
    !x.parentElement?.closest?.('[data-message-author-role],article[data-turn]'));
  const role=x=>x.getAttribute("data-turn")||x.getAttribute("data-message-author-role");
  if(role(unique.at(-1))!=="assistant")return refused("TARGET_ASSISTANT_NOT_LAST");
  const text=(unique.at(-1).innerText||unique.at(-1).textContent||"").trim();
  if(text.length<20||text.length>100000)return refused("TARGET_REPLY_BODY_UNVERIFIED");
  let hash=2166136261;
  for(const char of text)hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;
  return {ok:true,replyFingerprint:text.length+":"+hash.toString(16)};
}
