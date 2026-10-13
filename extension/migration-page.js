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

export function copyLastMigrationAssistant(expectedCount,marker,maxChars=30000) {
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))
    return refuse("MIGRATION_SOURCE_CHANGED");
  if(!Number.isInteger(expectedCount)||expectedCount<0||
     typeof marker!=="string"||marker.length>60)
    return refuse("MIGRATION_CAPTURE_INVALID");
  const busy=[...document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  )].some(x=>!x.disabled&&x.getClientRects?.().length);
  if(busy)return refuse("MIGRATION_RESPONSE_STILL_GENERATING");
  const assistants=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
  if(assistants.length<=expectedCount)return refuse("MIGRATION_NEW_RESPONSE_NOT_FOUND");
  const message=assistants.at(-1);
  const content=message?.querySelector?.('.markdown,[data-testid="message-content"]')||message;
  const text=(content?.innerText||content?.textContent||"").trim();
  if(!text.startsWith(marker))return refuse("MIGRATION_MARKER_NOT_FOUND");
  const payload=text.slice(marker.length).trim();
  if(payload.length<80)return refuse("MIGRATION_PROMPT_TOO_SHORT");
  if(payload.length>maxChars)return refuse("MIGRATION_PROMPT_TOO_LONG");
  return {ok:true,body:payload,length:payload.length};
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
  if(matched.length!==1)return refuse("MIGRATION_TITLE_CHAT_MENU_NOT_FOUND");
  const item=matched[0].closest?.('li,[data-testid*="history-item"],[data-sidebar="menu-item"]');
  if(!item)return refuse("MIGRATION_TITLE_CHAT_MENU_NOT_FOUND");
  const menuButtons=[...item.querySelectorAll("button")].filter(button=>visible(button) &&
    /more|options|더보기|메뉴/i.test([
      button.getAttribute("aria-label")||"",
      button.getAttribute("title")||"",
      button.getAttribute("data-testid")||""
    ].join(" ")));
  if(menuButtons.length!==1)return refuse("MIGRATION_TITLE_CHAT_MENU_NOT_FOUND");
  menuButtons[0].click();
  await new Promise(r=>setTimeout(r,160));
  const renameItems=[...document.querySelectorAll(
    '[role="menuitem"],[data-radix-menu-content] button'
  )].filter(el=>visible(el)&&/^(rename|이름 바꾸기|이름 변경|제목 변경)$/i
    .test((el.innerText||el.textContent||"").trim()));
  if(renameItems.length!==1)return refuse("MIGRATION_TITLE_RENAME_ACTION_NOT_FOUND");
  renameItems[0].click();
  await new Promise(r=>setTimeout(r,160));
  const inputs=[...document.querySelectorAll(
    '[role="dialog"] input[type="text"],[role="dialog"] input:not([type]),input[data-testid*="rename"]'
  )].filter(visible);
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
    const save=[...document.querySelectorAll('[role="dialog"] button')].filter(el=>
      visible(el)&&/^(save|저장|확인)$/i.test((el.innerText||el.textContent||"").trim()));
    if(save.length!==1)return refuse("MIGRATION_TITLE_SAVE_NOT_FOUND");
    save[0].click();
  }
  await new Promise(r=>setTimeout(r,400));
  const confirmed=[...document.querySelectorAll('a[href]')].some(link=>{
    try {return visible(link) &&
      new URL(link.href,location.origin).pathname===location.pathname &&
      (link.innerText||link.textContent||"").trim()===title;}
    catch {return false}
  });
  return confirmed?{ok:true,reason:"MIGRATION_TITLE_VERIFIED"}:
    refuse("MIGRATION_TITLE_SAVE_UNVERIFIED");
}
