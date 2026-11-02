// Read-only detector for ChatGPT's unrecoverable "Unknown error" state.
// The source conversation cannot be trusted to compose a handoff.
export function inspectUnknownChatError() {
  const fail=reason=>({eligible:false,fatal:false,reason});
  const path=location.pathname;
  if(location.origin!=="https://chatgpt.com"||
    !/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(path))
    return fail("NOT_EXISTING_CHAT");
  const visible=el=>!!el?.getClientRects?.().length &&
    !el.closest?.('[aria-hidden="true"],[hidden],[inert]');
  const clean=v=>String(v||"").replace(/\s+/g," ").trim();
  const forbidden='[data-message-author-role],article[data-turn],'+
    'textarea,[contenteditable="true"],blockquote,pre,code';
  const safe=el=>visible(el)&&!el.closest?.(forbidden)&&
    !el.querySelector?.('[data-message-author-role],article[data-turn]');
  const errors=[...document.querySelectorAll(
    '[role="alert"],[role="status"],[data-testid*="error"],div,span,p'
  )].filter(el=>safe(el)&&clean(el.innerText||el.textContent)==="Unknown error");
  const buttons=[...document.querySelectorAll('button,[role="button"]')]
    .filter(el=>safe(el)&&/^(?:새 대화 시작|Start new chat|New chat|Start a new chat)$/i.test(
      clean(el.innerText||el.textContent||el.getAttribute?.("aria-label"))) &&
      !el.disabled);
  if(!errors.length||buttons.length!==1)
    return fail("UNKNOWN_ERROR_ACTION_NOT_VERIFIED");
  const button=buttons[0];
  // Require that a visible error and its recovery action share a compact
  // non-transcript parent. Merely quoting the phrase must not trigger this.
  const parents=[];
  for(let p=button.parentElement,depth=0;p&&depth<5;p=p.parentElement,depth++){
    if(!safe(p))break;
    const text=clean(p.innerText||p.textContent);
    if(text.length<=400&&text.includes("Unknown error")&&p.contains(button))
      parents.push(p);
  }
  const valid=parents.some(p=>errors.some(el=>p.contains(el)));
  if(!valid)return fail("UNKNOWN_ERROR_ACTION_NOT_LINKED");
  const project=path.match(/^\/g\/(g-p-[^/]+)\/c\/[^/]+\/?$/);
  return {eligible:true,fatal:true,reason:"UNKNOWN_ERROR_NEW_CHAT_REQUIRED",
    projectId:project?.[1]||null,sourcePath:path};
}
