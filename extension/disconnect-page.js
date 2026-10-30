export const RECOVERY_WORKER_BUILD="disconnect-worker-1";
export const RECOVERY_REPORT_MESSAGE="현재까지 진행한 작업과 남은 작업을 보고해줘.";

// Serialized into the registered tab. Never stop an ordinary generation, an
// assistant's quotation, a restriction banner, or an ambiguous lookalike.
export function clickVerifiedDisconnectStop(request={}){
  const refuse=reason=>({clicked:false,reason});
  if(request.permitted!==true||!/^[a-f0-9-]{36}$/.test(request.operationId||""))return refuse("STOP_NOT_AUTHORIZED");
  if(location.origin!=="https://chatgpt.com"||location.pathname!==request.expectedPath||
    !/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))return refuse("STOP_CONVERSATION_MISMATCH");
  const visible=el=>!!el?.getClientRects?.().length&&!el.closest('[aria-hidden="true"],[hidden],[inert]');
  const nodes=selector=>[...document.querySelectorAll(selector)].filter(visible);
  const editors=nodes('textarea,[contenteditable="true"]'),stops=nodes('button[data-testid="stop-button"]');
  if(editors.length!==1||stops.length!==1||stops[0].disabled||stops[0].getAttribute("aria-disabled")==="true"||
    !stops[0].closest("form")?.contains(editors[0])||nodes('[role="dialog"][aria-modal="true"]').length||
    nodes('button[aria-label="Stop generating"],button[aria-label="Stop"]').some(el=>el!==stops[0]))return refuse("STOP_CONTROL_UNVERIFIED");
  let visited=0;
  const containsDraft=node=>{
    if(++visited>200)return true;
    if(node.nodeType===3)return node.length>0;
    return [...(node.childNodes||[])].some(containsDraft);
  };
  if(editors[0].tagName==="TEXTAREA"?!editors[0].matches(":placeholder-shown"):containsDraft(editors[0]))return refuse("STOP_DRAFT_PRESENT_OR_UNKNOWN");
  const banners=nodes('[role="alert"]').filter(el=>!el.closest('[data-message-author-role],[data-content-search-turn-key],article,blockquote,pre,code,[contenteditable="true"]'));
  if(banners.length!==1||banners[0].querySelector('pre,code,blockquote,q,textarea,input,[contenteditable="true"]')||
    !/^연결이 해제되었습니다\.?\s+전체 답변을 기다리는 중입니다\.?$/.test(banners[0].innerText.trim()))return refuse("STOP_WARNING_UNVERIFIED");
  const form=stops[0].closest("form");
  if(form.dataset.autopilotDisconnectOperation)return refuse("STOP_ALREADY_ATTEMPTED");
  // Record before the effect. Throwing/lost ACKs are uncertain, never retried.
  form.dataset.autopilotDisconnectOperation=request.operationId;
  stops[0].click();return {clicked:true,reason:"STOP_CLICKED_REQUIRES_INDEPENDENT_OBSERVATION"};
}
