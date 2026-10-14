// Each function is self-contained: Chrome serializes it into the registered
// page's isolated world. Never transmit full transcripts or arbitrary messages.

export function inspectMigrationSource() {
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))
    return refuse("MIGRATION_SOURCE_MUST_BE_EXISTING_CHAT");
  // Boolean only; text is neither stored nor sent to the bridge.
  const pageText=document.body?.innerText||"";
  const atLimit=/이 대화의 최대 길이에 도달|maximum length (?:for |of )?this conversation/i
    .test(pageText);
  const assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const last=assistants.at(-1);
  return {
    ok:true,atLimit,assistantCount:assistants.length,
    lastAssistantId:last?.getAttribute?.("data-message-id")||null
  };
}

export function copyLastMigrationAssistant(expectedCount,marker,maxChars=30000,baselineAssistantId=null) {
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))
    return refuse("MIGRATION_SOURCE_CHANGED");
  if((expectedCount!==null&&(!Number.isInteger(expectedCount)||expectedCount<0)) ||
     typeof marker!=="string"||marker.length<10||marker.length>60 ||
     typeof maxChars!=="number"||maxChars>30000||maxChars<80)
    return refuse("MIGRATION_CAPTURE_INVALID");
  const busy=[...document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  )].some(x=>!x.disabled&&x.getClientRects?.().length);
  if(busy)return refuse("MIGRATION_RESPONSE_STILL_GENERATING");
  const assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const message=assistants.at(-1);
  if(!message)return refuse("MIGRATION_NEW_RESPONSE_NOT_FOUND");
  const content=message.querySelector?.('.markdown,[data-testid="message-content"]')||message;
  // The rendered assistant node may be virtualized or replaced by React.
  // Never rely solely on a count of currently mounted assistant nodes.
  const text=(content?.innerText||content?.textContent||"").trim();
  const id=message.getAttribute?.("data-message-id")||null;
  const newByCount=expectedCount!==null&&assistants.length>expectedCount;
  const newById=!!(id&&baselineAssistantId&&id!==baselineAssistantId);
  // Independently prove that this assistant reply follows the specific user
  // instruction asking the original conversation to author the handoff.
  // This also works for a previously completed answer after extension reload
  // where the old per-page assistant count is no longer available.
  const turns=[...document.querySelectorAll('[data-message-author-role]')];
  const current=turns.lastIndexOf(message);
  const previousUser=turns.slice(0,current<0?0:current).reverse()
    .find(node=>node.getAttribute?.("data-message-author-role")==="user");
  const request=(previousUser?.innerText||previousUser?.textContent||"").trim();
  const authoredAfterRequest=current>=0 &&
    turns.slice(current+1).every(node=>
      node.getAttribute?.("data-message-author-role")!=="user") &&
    request.includes(marker) &&
    request.includes("이관 프롬프트") &&
    request.includes("새 프로젝트 채팅") &&
    request.includes("로드맵");
  if(!newByCount&&!newById&&!authoredAfterRequest)
    return refuse("MIGRATION_NEW_RESPONSE_NOT_FOUND");
  if(!text.startsWith(marker))return refuse("MIGRATION_MARKER_NOT_FOUND");
  const payload=text.slice(marker.length).trim();
  if(payload.length<80)return refuse("MIGRATION_PROMPT_TOO_SHORT");
  if(payload.length>maxChars)return refuse("MIGRATION_PROMPT_TOO_LONG");
  return {ok:true,body:payload,length:payload.length,
    evidence:newById?"NEW_ASSISTANT_ID":newByCount?"NEW_ASSISTANT_COUNT":
      "ORIGINAL_USER_REQUEST_PRECEDES_ASSISTANT"};
}

export function inspectMigrationTarget() {
  if(location.origin!=="https://chatgpt.com")
    return {ok:false,reason:"MIGRATION_TARGET_WRONG_ORIGIN"};
  const path=location.pathname;
  const projectNew=/^\/g\/g-p-[^/]+(?:\/project)?\/?$/.test(path);
  const projectConversation=/^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(path);
  const busy=[...document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  )].some(x=>!x.disabled&&x.getClientRects?.().length);
  const replies=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const last=replies.at(-1);
  const text=last?.innerText||last?.textContent||"";
  let hash=2166136261;
  for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619)>>>0;
  return {
    ok:projectNew||projectConversation,
    projectNew,projectConversation,busy,
    assistantCount:replies.length,
    lastReplyFingerprint:text.length>=20 ? text.length+":"+hash.toString(16) : null,
    reason:projectNew||projectConversation?null:"MIGRATION_TARGET_NOT_PROJECT_CHAT"
  };
}

// Attempt the public ChatGPT UI, never a private ChatGPT endpoint.
// If the UI no longer exposes an unambiguous rename control, return manual
// action required. No optimistic success / DOM title mutation.
export async function renameMigrationConversation(title) {
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com"||
     !/^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(location.pathname))
    return refuse("MIGRATION_TITLE_NOT_PROJECT_CONVERSATION");
  if(typeof title!=="string"||title.length<2||title.length>160)
    return refuse("MIGRATION_TITLE_INVALID");
  const visible=e=>!!e?.getClientRects?.().length &&
    !e.closest?.('[aria-hidden="true"],[inert]');
  const matched=[...document.querySelectorAll('a[href]')].filter(link=>{
    try{
      return visible(link) && new URL(link.href,location.origin).pathname===location.pathname;
    }catch{return false}
  });
  // Prefer the single sidebar history link, not any duplicate header link.
  const sidebar=matched.filter(link=>link.closest?.('nav,aside,[data-sidebar]'));
  const history=sidebar.length===1?sidebar:matched;
  if(history.length!==1)return refuse("MIGRATION_TITLE_CHAT_MENU_NOT_FOUND");
  const link=history[0];
  const item=link.closest?.(
    'li,[data-testid*="history-item"],[data-sidebar="menu-item"],[role="listitem"]'
  ) || link.parentElement?.parentElement;
  if(!item)return refuse("MIGRATION_TITLE_CHAT_MENU_NOT_FOUND");
  item.dispatchEvent?.(new MouseEvent("mouseover",{bubbles:true}));
  const menuButtons=[...item.querySelectorAll("button")].filter(button=>visible(button) &&
    (/more|options|더보기|메뉴|ellipsis|overflow/i.test([
      button.getAttribute("aria-label")||"",
      button.getAttribute("title")||"",
      button.getAttribute("data-testid")||""
    ].join(" ")) ||
    button.getAttribute("aria-haspopup")==="menu"));
  if(menuButtons.length!==1)return refuse("MIGRATION_TITLE_CHAT_MENU_NOT_FOUND");
  menuButtons[0].click();
  await new Promise(r=>setTimeout(r,160));
  const renameItems=[...document.querySelectorAll(
    '[role="menuitem"],[data-radix-menu-content] button'
  )].filter(el=>visible(el)&&/^(rename(?: chat| conversation)?|이름 바꾸기|이름 변경|제목 변경|대화 이름 변경)$/i
    .test((el.innerText||el.textContent||"").trim()));
  if(renameItems.length!==1)return refuse("MIGRATION_TITLE_RENAME_ACTION_NOT_FOUND");
  renameItems[0].click();
  await new Promise(r=>setTimeout(r,160));
  const inDialog=[...document.querySelectorAll(
    '[role="dialog"] input[type="text"],[role="dialog"] input:not([type]),input[data-testid*="rename"]'
  )].filter(visible);
  const inline=[...item.querySelectorAll('input[type="text"],input:not([type])')]
    .filter(visible);
  const inputs=[...new Set([...inDialog,...inline])];
  if(inputs.length!==1)return refuse("MIGRATION_TITLE_EDITOR_NOT_FOUND");
  const editor=inputs[0];
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
  if(!setter)return refuse("MIGRATION_TITLE_EDITOR_UNSUPPORTED");
  setter.call(editor,title);
  editor.dispatchEvent(new Event("input",{bubbles:true}));
  editor.dispatchEvent(new Event("change",{bubbles:true}));
  if(editor.value!==title)return refuse("MIGRATION_TITLE_TEXT_MISMATCH");
  const form=editor.closest?.("form");
  if(form&&typeof form.requestSubmit==="function")form.requestSubmit();
  else {
    const save=[...new Set([
      ...document.querySelectorAll('[role="dialog"] button'),
      ...item.querySelectorAll("button")
    ])].filter(el=>
      visible(el)&&/^(save|저장|확인)$/i.test((el.innerText||el.textContent||"").trim()));
    if(save.length===1)save[0].click();
    else if(save.length===0 && inline.length===1){
      editor.dispatchEvent(new KeyboardEvent("keydown",{
        bubbles:true,key:"Enter",code:"Enter"
      }));
    }else return refuse("MIGRATION_TITLE_SAVE_NOT_FOUND");
  }
  // ChatGPT often rerenders its history row asynchronously after rename.
  for(let retry=0;retry<10;retry++){
    await new Promise(r=>setTimeout(r,200));
    const confirmed=[...document.querySelectorAll('a[href]')].some(link=>{
      try {return visible(link) &&
        new URL(link.href,location.origin).pathname===location.pathname &&
        (link.innerText||link.textContent||"").trim()===title;}
      catch {return false}
    });
    if(confirmed)return {ok:true,reason:"MIGRATION_TITLE_VERIFIED"};
  }
  return refuse("MIGRATION_TITLE_SAVE_UNVERIFIED");
}


// Hard-stop fallback captures only the single most recent assistant response,
// never the entire historical conversation. Used solely after the old chat
// refuses to generate a full migration prompt. Operator must review it.
export function copyLastAssistantContext(maxChars=6000) {
  if(location.origin!=="https://chatgpt.com"||
     !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))
    return {ok:false,reason:"MIGRATION_SOURCE_CHANGED"};
  const assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
  if(!assistants.length)return {ok:false,reason:"MIGRATION_LAST_ASSISTANT_NOT_FOUND"};
  const message=assistants.at(-1);
  const content=message.querySelector?.('.markdown,[data-testid="message-content"]')||message;
  const text=(content?.innerText||content?.textContent||"").trim();
  if(!text)return {ok:false,reason:"MIGRATION_LAST_ASSISTANT_EMPTY"};
  return {ok:true,body:text.slice(0,maxChars),truncated:text.length>maxChars};
}


// Check only visible non-chat warning components. Do not scan/return the
// transcript; quoted discussion of the banner inside messages does not count.
export function inspectChatLengthLimit() {
  const path=location.pathname;
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(path))
    return {eligible:false,warning:false,reason:"NOT_PROJECT_OR_EXISTING_CHAT"};
  const expression=/이 대화의 최대 길이에 도달|대화의 최대 길이에 도달|this conversation (?:has reached|reached) (?:its |the )?(?:maximum |max )?length|maximum length for this conversation/i;
  // The limit banner can be nested in buttons, alert wrappers or React
  // portals. The old detector only read direct text nodes of div/p/span,
  // missing banners whose text was split among nested elements.
  const nodes=[...document.querySelectorAll(
    '[role="alert"],[role="status"],[data-testid*="limit"],div,p,span,button'
  )];
  let inspected=0;
  for(const el of nodes){
    if(el.closest?.('[data-message-author-role],[contenteditable="true"],textarea'))continue;
    if(!el.getClientRects?.().length)continue;
    // Never scan chat messages even when they are descendants of a larger
    // wrapper. Avoid treating a quoted warning as a real system banner.
    if(el.querySelector?.('[data-message-author-role],[contenteditable="true"],textarea'))continue;
    const text=(el.innerText||el.textContent||"").replace(/\s+/g," ").trim();
    if(text.length<12||text.length>420)continue;
    inspected++;
    if(expression.test(text))
      return {eligible:true,warning:true,reason:"VISIBLE_LENGTH_WARNING_DETECTED"};
  }
  return {eligible:true,warning:false,reason:inspected?
    "NO_VISIBLE_LENGTH_WARNING_MATCH":"NO_VISIBLE_NON_CHAT_WARNING_TEXT"};
}

// Read the exact registered ChatGPT conversation title from its sidebar.
// Unlike the browser tab's static title, this is tied to the conversation URL.
// Never infer a numeric suffix from unrelated page text or assistant replies.
export function readRegisteredChatTitle() {
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))
    return refuse("CHAT_TITLE_NOT_EXISTING_CONVERSATION");
  const clean=value=>String(value||"").replace(/\s+/g," ").trim();
  const valid=value=>value.length>=3 && value.length<=160 &&
    /^.+\S\s+[0-9]{1,3}$/.test(value) && !/^ChatGPT(?:\s+\d+)?$/i.test(value);
  const matching=[...document.querySelectorAll('a[href]')].filter(link=>{
    try {
      const url=new URL(link.getAttribute("href")||link.href,location.origin);
      return url.origin===location.origin &&
        url.pathname.replace(/\/$/,"")===location.pathname.replace(/\/$/,"") &&
        Boolean(link.getClientRects?.().length);
    } catch {return false}
  });
  const sidebar=matching.filter(link=>link.closest?.('nav,aside,[data-sidebar]'));
  const eligible=sidebar.length?sidebar:matching;
  const titles=[...new Set(eligible.map(link=>clean(link.innerText||link.textContent))
    .filter(valid))];
  if(titles.length===1) return {ok:true,title:titles[0],source:"chat-sidebar"};
  if(titles.length>1)return refuse("CHAT_TITLE_MULTIPLE_MATCHES");
  const browserTitle=clean(document.title)
    .replace(/\s*[-–—|]\s*ChatGPT\s*$/i,"");
  // Browser title is a fallback only when exactly numbered. Never use a generic
  // project/browser title or any assistant message as the track name.
  if(valid(browserTitle))return {ok:true,title:browserTitle,source:"browser-title"};
  return refuse("CHAT_TITLE_NOT_FOUND_OR_UNNUMBERED");
}
