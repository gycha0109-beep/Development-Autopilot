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
  const articles=[...document.querySelectorAll('article[data-turn="user"],article[data-turn="assistant"]')];
  const turns=articles.length?articles:
    [...document.querySelectorAll('[data-message-author-role]')];
  const role=node=>node.getAttribute?.("data-turn")||
    node.getAttribute?.("data-message-author-role");
  const identity=node=>node?.getAttribute?.("data-message-id")||
    node?.getAttribute?.("data-turn-id")||null;
  const assistants=turns.filter(node=>role(node)==="assistant");
  const users=turns.filter(node=>role(node)==="user");
  return {
    ok:true,atLimit,assistantCount:assistants.length,
    lastAssistantId:identity(assistants.at(-1)),
    lastUserId:identity(users.at(-1))
  };
}

export function copyLastMigrationAssistant(expectedCount,marker,maxChars=30000,baselineAssistantId=null,baselineUserId=null,allowUnattributed=false,requiredSourceContext=null) {
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))
    return refuse("MIGRATION_SOURCE_CHANGED");
  if((expectedCount!==null&&(!Number.isInteger(expectedCount)||expectedCount<0)) ||
     typeof marker!=="string"||marker.length<10||marker.length>60 ||
     typeof maxChars!=="number"||maxChars>30000||maxChars<80)
    return refuse("MIGRATION_CAPTURE_INVALID");
  if(requiredSourceContext!==null && (
     typeof requiredSourceContext!=="object" ||
     typeof requiredSourceContext.repository!=="string" ||
     typeof requiredSourceContext.trackTitle!=="string" ||
     requiredSourceContext.repository.length<3 ||
     requiredSourceContext.repository.length>160 ||
     requiredSourceContext.trackTitle.length<2 ||
     requiredSourceContext.trackTitle.length>160))
    return refuse("MIGRATION_CAPTURE_INVALID_SOURCE_CONTEXT");
  const matchesRequiredSource=text=>requiredSourceContext===null ||
    (text.includes(requiredSourceContext.repository) &&
     text.includes(requiredSourceContext.trackTitle));
  const busy=[...document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  )].some(x=>!x.disabled&&x.getClientRects?.().length);
  if(busy)return refuse("MIGRATION_RESPONSE_STILL_GENERATING");
  const articles=[...document.querySelectorAll('article[data-turn="user"],article[data-turn="assistant"]')];
  const turns=articles.length?articles:
    [...document.querySelectorAll('[data-message-author-role]')];
  const role=node=>node.getAttribute?.("data-turn")||
    node.getAttribute?.("data-message-author-role");
  const identity=node=>node?.getAttribute?.("data-message-id")||
    node?.getAttribute?.("data-turn-id")||null;
  const assistants=turns.filter(node=>role(node)==="assistant");
  const message=assistants.at(-1);
  if(!message && allowUnattributed===true){
    // Operator-confirmed recovery only. Current ChatGPT layouts sometimes have
    // neither classic message role attributes nor article[data-turn] wrappers.
    // Do not guess assistant ownership from visual order alone: require the
    // exact visible handoff marker, the preceding original authoring request
    // and precisely one adjacent code payload. Never scrape an entire thread.
    const main=document.querySelector?.("main");
    if(!main||!document.createTreeWalker)
      return refuse("MIGRATION_UNATTRIBUTED_MAIN_NOT_FOUND");
    const walker=document.createTreeWalker(main,4);
    const markerNodes=[],requestNodes=[],textNodes=[];
    let node;
    while((node=walker.nextNode())){
      const value=(node.textContent||"").trim();
      const el=node.parentElement;
      if(!el||el.closest?.('textarea,[contenteditable="true"],nav,aside,button,[aria-hidden="true"]'))
        continue;
      if(value)textNodes.push(node);
      if(value===marker)markerNodes.push(node);
      if(value.includes("현재 개발 채팅의 길이 제한으로 다음 채팅에 이관해야 합니다."))
        requestNodes.push(node);
    }
    if(!markerNodes.length)
      return refuse("MIGRATION_UNATTRIBUTED_MARKER_NOT_FOUND");
    // The original user instruction itself quotes the marker, sometimes as
    // a separate text node. Quoted/user markers are NOT assistant handoffs.
    // Find the latest actual authoring request first; then qualify markers by
    // their own bounded marker -> code-block scope.
    const authoringRequests=requestNodes.filter(candidate=>{
      if(candidate.parentElement?.closest?.("pre,code,blockquote"))return false;
      for(let p=candidate.parentElement,depth=0;
          p&&p!==main&&depth<7;p=p.parentElement,depth++){
        const t=p.innerText||p.textContent||"";
        if(t.length>6000)break;
        if(t.includes("이관 프롬프트")&&t.includes("새 프로젝트 채팅")&&
           t.includes("로드맵")&&t.includes(marker)&&
           matchesRequiredSource(t))return true;
      }
      return false;
    });
    if(!authoringRequests.length)
      return refuse("MIGRATION_UNATTRIBUTED_SOURCE_REQUEST_NOT_FOUND");
    const requestNode=authoringRequests.at(-1);
    // A complete user instruction can quote the marker as its own sibling.
    // Exclude markers contained in its *smallest* proven authoring bubble.
    let requestRoot=null;
    for(let p=requestNode.parentElement,depth=0;p&&p!==main&&depth<8;
        p=p.parentElement,depth++){
      const t=p.innerText||p.textContent||"";
      if(t.length<=6000 && t.includes("이관 프롬프트") &&
         t.includes("새 프로젝트 채팅")&&t.includes("로드맵")&&
         t.includes(marker)){requestRoot=p;break;}
    }
    // Some code blocks are mounted in a sibling renderer, not within any
    // ancestor of the marker before the ancestor also contains the user turn.
    // Read structured CODE elements across main, but qualify by DOM order,
    // proximity, source boundary, and absence of intervening handoff markers.
    const explicitCodes=[...main.querySelectorAll?.("pre code")||[]];
    const allCodes=explicitCodes.length?explicitCodes:
      [...main.querySelectorAll?.("pre")||[]];
    const follows=(left,right)=>!!(left?.compareDocumentPosition?.(right)&4);
    const diag={markers:markerNodes.length,requests:authoringRequests.length,
      structuredCodes:allCodes.length};
    const responseMarkers=markerNodes.filter(markerNode=>
      !markerNode.parentElement?.closest?.("pre,code,blockquote") &&
      !requestRoot?.contains?.(markerNode) &&
      follows(requestNode,markerNode));
    // Portalled renderers may group all marker nodes before all code blocks.
    // Pairing only the final marker to the first available code can silently
    // select someone else's payload. Multiple possible assistant markers
    // after the current request are never safe to disambiguate by proximity.
    if(responseMarkers.length>1)return {ok:false,
      reason:"MIGRATION_UNATTRIBUTED_MARKER_AMBIGUOUS",
      diagnostic:{...diag,qualifiedMarkers:responseMarkers.length}};
    const valid=[];
    let ambiguousBlocks=false;
    let orderFallbacks=0;
    for(const markerNode of responseMarkers){
      const markerEl=markerNode.parentElement;
      let foundInScope=false;
      for(let p=markerEl,depth=0;p&&p!==main&&depth<8;
          p=p.parentElement,depth++){
        // Do not expand the scope to the shared conversation container.
        // It would let a quoted marker steal a different reply's code block.
        if(p.contains?.(requestNode))break;
        const codes=[...p.querySelectorAll("pre code")];
        const raw=codes.length?codes:[...p.querySelectorAll("pre")];
        const after=raw.filter(el=>
          !!(markerNode.compareDocumentPosition?.(el)&4));
        if(!after.length)continue;
        if(after.length!==1){ambiguousBlocks=true;foundInScope=true;break;}
        valid.push({markerNode,code:after[0]});
        foundInScope=true;break;
      }
      if(foundInScope)continue;
      // Structural fallback: the code block is a sibling/portal rather than
      // a descendant of the bounded marker subtree. Never copy a random
      // later code block from another turn.
      const following=allCodes.filter(code=>follows(markerNode,code));
      const code=following[0];
      if(!code)continue;
      if(markerNodes.some(next=>next!==markerNode &&
          follows(markerNode,next)&&follows(next,code)))continue;
      const intervening=textNodes.filter(textNode=>
        textNode!==markerNode &&
        follows(markerNode,textNode)&&follows(textNode,code) &&
        !code.contains?.(textNode) &&
        !textNode.parentElement?.closest?.("pre,code,button,nav,aside"));
      // At most a few labels/language controls may separate the marker from
      // the immediately following block. A distant block is not provenance.
      if(intervening.length>12)continue;
      valid.push({markerNode,code});orderFallbacks++;
    }
    // Some ChatGPT code-looking blocks are rendered as ordinary styled
    // containers with no PRE/CODE elements at all. For an operator-confirmed
    // recovery, accept text only from the *smallest* reply-only ancestor
    // containing the unique verified response marker and substantial content.
    // Never fall back to main.innerText or scrape another conversation turn.
    let unstructuredPayload=null;
    let boundedTextScopes=0;
    if(valid.length===0 && !ambiguousBlocks && allCodes.length===0 &&
       responseMarkers.length===1){
      const marked=responseMarkers[0];
      for(let p=marked.parentElement,depth=0;
          p&&p!==main&&depth<10;p=p.parentElement,depth++){
        if(p.contains?.(requestNode))break;
        const visible=(p.innerText||p.textContent||"").trim();
        if(!visible.startsWith(marker))continue;
        const payload=visible.slice(marker.length).trim();
        if(payload.length<80 || payload.length>maxChars ||
           payload.includes(marker) ||
           payload.includes("현재 개발 채팅의 길이 제한으로 다음 채팅에 이관해야 합니다."))
          continue;
        // If control labels share the reply container, read only actual text
        // nodes outside interactive UI. Otherwise preserve innerText line
        // breaks and whitespace from the rendered authored answer.
        const controls=[...p.querySelectorAll?.(
          "button,[role='button'],textarea,[contenteditable='true']")||[]];
        let clean=payload;
        if(controls.length){
          const nodes=textNodes.filter(n=>
            n!==marked && follows(marked,n) && p.contains?.(n) &&
            !n.parentElement?.closest?.(
              "button,[role='button'],textarea,[contenteditable='true'],nav,aside,[aria-hidden='true']"));
          clean=nodes.map(n=>n.textContent||"").join("\n").trim();
        }
        if(clean.length<80 || clean.length>maxChars ||
           clean.includes(marker) ||
           clean.includes("현재 개발 채팅의 길이 제한으로 다음 채팅에 이관해야 합니다."))
          continue;
        boundedTextScopes++;
        unstructuredPayload=clean;
        break;
      }
    }
    if(unstructuredPayload!==null)
      return {ok:true,body:unstructuredPayload,
        length:unstructuredPayload.length,
        evidence:"UNATTRIBUTED_SOURCE_REQUEST_MARKER_TEXT",
        sourceContextVerified:requiredSourceContext!==null};
    if(valid.length!==1){
      const reason=valid.length>1?
        "MIGRATION_UNATTRIBUTED_MARKER_AMBIGUOUS":ambiguousBlocks?
        "MIGRATION_UNATTRIBUTED_CODE_BLOCK_AMBIGUOUS":
        "MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND";
      return {ok:false,reason,diagnostic:{...diag,
        qualifiedReplies:valid.length,orderFallbacks,boundedTextScopes,
        textNodesAfterMarker:responseMarkers.length===1?
          textNodes.filter(n=>follows(responseMarkers[0],n)).length:0}};
    }
    const code=valid[0].code;
    const payload=(code.innerText||code.textContent||"").trim();
    if(payload.startsWith(marker))return refuse("MIGRATION_UNATTRIBUTED_NESTED_MARKER");
    if(payload.length<80)return refuse("MIGRATION_PROMPT_TOO_SHORT");
    if(payload.length>maxChars)return refuse("MIGRATION_PROMPT_TOO_LONG");
    // No DOM assistant turn is known, so only manual recovery may use this
    // separately identified source request -> marker -> codeblock chain.
    return {ok:true,body:payload,length:payload.length,
      evidence:"UNATTRIBUTED_SOURCE_REQUEST_MARKER_CODEBLOCK",
      sourceContextVerified:requiredSourceContext!==null};
  }
  if(!message)return refuse("MIGRATION_ASSISTANT_DOM_NOT_FOUND");
  const content=message.querySelector?.('.markdown,[data-testid="message-content"]')||message;
  // The rendered assistant node may be virtualized or replaced by React.
  // Never rely solely on a count of currently mounted assistant nodes.
  const text=(content?.innerText||content?.textContent||"").trim();
  const id=identity(message);
  const newByCount=expectedCount!==null&&assistants.length>expectedCount;
  const newById=!!(id&&baselineAssistantId&&id!==baselineAssistantId);
  // Independently prove that this assistant reply follows the specific user
  // instruction asking the original conversation to author the handoff.
  // This also works for a previously completed answer after extension reload
  // where the old per-page assistant count is no longer available.
  const current=turns.lastIndexOf(message);
  if(current<0)return refuse("MIGRATION_ASSISTANT_TURN_NOT_FOUND");
  // An assistant must be the latest turn, not an earlier response to copy.
  if(turns.slice(current+1).some(node=>
    role(node)==="user"))
    return refuse("MIGRATION_ASSISTANT_NOT_LATEST_TURN");
  const previousUser=turns.slice(0,current).reverse()
    .find(node=>role(node)==="user");
  const request=(previousUser?.innerText||previousUser?.textContent||"").trim();
  const authoredAfterRequest=!!previousUser &&
    request.includes(marker) &&
    request.includes("이관 프롬프트") &&
    request.includes("새 프로젝트 채팅") &&
    request.includes("로드맵") && matchesRequiredSource(request);
  // ID/count changes never authorize a reply to an unrelated visible request.
  if(previousUser&&!authoredAfterRequest)
    return refuse("MIGRATION_SOURCE_REQUEST_MISMATCH");
  const previousUserId=identity(previousUser);
  if(baselineUserId&&previousUserId===baselineUserId)
    return refuse("MIGRATION_SOURCE_REQUEST_NOT_NEW");
  // Rehydrated old messages can increase DOM count without a new reply.
  if(!previousUser&&!newById)
    return refuse("MIGRATION_SOURCE_REQUEST_PROVENANCE_UNCERTAIN");
  if(!newByCount&&!newById&&!authoredAfterRequest)
    return refuse("MIGRATION_NEW_RESPONSE_NOT_FOUND");
  const rendered=(message.innerText||message.textContent||"").trim();
  const hasMarkerLine=rendered.split(/\r?\n/).some(line=>line.trim()===marker);
  if(!text.startsWith(marker)&&!hasMarkerLine)
    return refuse("MIGRATION_MARKER_NOT_FOUND");
  const codeBlocks=[...message.querySelectorAll?.("pre code")||[]];
  const onlyBlocks=codeBlocks.length?codeBlocks:
    [...message.querySelectorAll?.("pre")||[]];
  // Prefer code content only when the marker is a separate leading line and
  // a single fenced block contains the handoff. Do not append copy UI labels.
  const payload=(hasMarkerLine&&onlyBlocks.length===1?
    (onlyBlocks[0].innerText||onlyBlocks[0].textContent||""):
    text.startsWith(marker)?text.slice(marker.length):rendered.split(marker).slice(1).join(marker)).trim();
  if(payload.length<80)return refuse("MIGRATION_PROMPT_TOO_SHORT");
  if(payload.length>maxChars)return refuse("MIGRATION_PROMPT_TOO_LONG");
  return {ok:true,body:payload,length:payload.length,
    sourceContextVerified:requiredSourceContext!==null && authoredAfterRequest,
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
