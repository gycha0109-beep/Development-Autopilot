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
  // October 2026 observed renderer. IDs must agree at all three boundaries;
  // never fall back to the legacy/proximity reader after a modern proof fails.
  const modernTurns=[...document.querySelectorAll('[data-content-search-turn-key]')]
    .filter(e=>e.closest('main')&&!e.closest('[hidden],[inert],[aria-hidden="true"],pre,code,blockquote'));
  const modernTurn=modernTurns.at(-1);
  const readModern=()=>{
    const visible=e=>!!e.getClientRects?.().length&&!e.closest('[hidden],[inert],[aria-hidden="true"]');
    const units=[...modernTurn.querySelectorAll('[data-chatgpt-search-unit-key]')].filter(visible);
    const unit=units.at(-1),user=units.at(-2),key=modernTurn.getAttribute('data-content-search-turn-key');
    const ids=e=>[...new Set((e?.getAttribute('data-chatgpt-search-message-ids')||'').split(/\s+/).filter(Boolean))];
    const aid=ids(unit),uid=ids(user);
    const nodes=selector=>[...unit?.querySelectorAll(selector)||[]].filter(visible);
    const bodies=nodes('[data-dil-message-id]'),sources=nodes('[data-dil-source-message-id]'),selections=nodes('[data-chatgpt-selection-message-id]');
    const states=[...modernTurn.querySelectorAll('[data-talvt-turn-state]')].filter(visible);
    const valid=!!key&&units.length===2&&unit.getAttribute('data-chatgpt-search-unit-key').startsWith(key+':')&&
      /:\d+:assistant$/.test(unit.getAttribute('data-chatgpt-search-unit-key'))&&
      user.getAttribute('data-chatgpt-search-unit-key').startsWith(key+':')&&/:\d+:user$/.test(user.getAttribute('data-chatgpt-search-unit-key'))&&
      aid.length===1&&uid.length===1&&[aid[0],uid[0]].every(id=>/^[a-zA-Z0-9-]{1,100}$/.test(id))&&
      bodies.length===1&&sources.length===1&&selections.length===1&&
      bodies[0].getAttribute('data-dil-message-id')===aid[0]&&sources[0].getAttribute('data-dil-source-message-id')===aid[0]&&
      selections[0].getAttribute('data-chatgpt-selection-message-id')===aid[0]&&sources[0].contains(bodies[0])&&selections[0].contains(bodies[0])&&
      !!bodies[0].closest('[data-markdown-text-style="assistant-message"]')&&states.length===1&&states[0].contains(unit);
    return valid?{body:bodies[0],user,assistantId:aid[0],userId:uid[0],complete:states[0].getAttribute('data-talvt-turn-state')==='complete'}:null;
  };
  if(modernTurn){
    const proof=readModern();
    if(!proof)return refuse('MIGRATION_CURRENT_IDENTITY_UNVERIFIED');
    return {ok:true,atLimit,assistantCount:modernTurns.length,lastAssistantId:proof.assistantId,lastUserId:proof.userId};
  }
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
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="중지"],button[aria-label="Stop"]'
  )].some(x=>!x.disabled&&x.getClientRects?.().length);
  if(busy)return refuse("MIGRATION_RESPONSE_STILL_GENERATING");
  // October 2026 observed renderer. IDs must agree at all three boundaries;
  // never fall back to the legacy/proximity reader after a modern proof fails.
  const modernTurns=[...document.querySelectorAll('[data-content-search-turn-key]')]
    .filter(e=>e.closest('main')&&!e.closest('[hidden],[inert],[aria-hidden="true"],pre,code,blockquote'));
  const modernTurn=modernTurns.at(-1);
  const readModern=()=>{
    const visible=e=>!!e.getClientRects?.().length&&!e.closest('[hidden],[inert],[aria-hidden="true"]');
    const units=[...modernTurn.querySelectorAll('[data-chatgpt-search-unit-key]')].filter(visible);
    const unit=units.at(-1),user=units.at(-2),key=modernTurn.getAttribute('data-content-search-turn-key');
    const ids=e=>[...new Set((e?.getAttribute('data-chatgpt-search-message-ids')||'').split(/\s+/).filter(Boolean))];
    const aid=ids(unit),uid=ids(user);
    const nodes=selector=>[...unit?.querySelectorAll(selector)||[]].filter(visible);
    const bodies=nodes('[data-dil-message-id]'),sources=nodes('[data-dil-source-message-id]'),selections=nodes('[data-chatgpt-selection-message-id]');
    const states=[...modernTurn.querySelectorAll('[data-talvt-turn-state]')].filter(visible);
    const valid=!!key&&units.length===2&&unit.getAttribute('data-chatgpt-search-unit-key').startsWith(key+':')&&
      /:\d+:assistant$/.test(unit.getAttribute('data-chatgpt-search-unit-key'))&&
      user.getAttribute('data-chatgpt-search-unit-key').startsWith(key+':')&&/:\d+:user$/.test(user.getAttribute('data-chatgpt-search-unit-key'))&&
      aid.length===1&&uid.length===1&&[aid[0],uid[0]].every(id=>/^[a-zA-Z0-9-]{1,100}$/.test(id))&&
      bodies.length===1&&sources.length===1&&selections.length===1&&
      bodies[0].getAttribute('data-dil-message-id')===aid[0]&&sources[0].getAttribute('data-dil-source-message-id')===aid[0]&&
      selections[0].getAttribute('data-chatgpt-selection-message-id')===aid[0]&&sources[0].contains(bodies[0])&&selections[0].contains(bodies[0])&&
      !!bodies[0].closest('[data-markdown-text-style="assistant-message"]')&&states.length===1&&states[0].contains(unit);
    return valid?{body:bodies[0],user,assistantId:aid[0],userId:uid[0],complete:states[0].getAttribute('data-talvt-turn-state')==='complete'}:null;
  };
  if(modernTurn){
    const proof=readModern();
    if(!proof)return refuse('MIGRATION_CURRENT_IDENTITY_UNVERIFIED');
    if(!proof.complete)return refuse('MIGRATION_RESPONSE_STILL_GENERATING');
    if(document.querySelector('[data-message-author-role]'))return refuse('MIGRATION_CURRENT_MIXED_RENDERERS');
    const request=(proof.user.innerText||'').trim();
    if(!requiredSourceContext||!matchesRequiredSource(request)||
       !['이관 프롬프트','새 프로젝트 채팅','로드맵',marker].every(value=>request.includes(value)))
      return refuse('MIGRATION_SOURCE_REQUEST_MISMATCH');
    if(proof.userId===baselineUserId||proof.assistantId===baselineAssistantId)
      return refuse('MIGRATION_SOURCE_REQUEST_NOT_NEW');
    const cards=[...proof.body.querySelectorAll('[data-testid="chatgpt-writing-block"]')];
    if(cards.length!==1)return refuse('MIGRATION_CURRENT_WRITING_BLOCK_AMBIGUOUS');
    const card=cards[0];
    const editors=[...card.querySelectorAll('.writing-block-editor [contenteditable="true"][role="textbox"]')];
    if(editors.length!==1||editors[0].closest('form')||
       editors[0].closest('[hidden],[inert],[aria-hidden="true"]')||!editors[0].getClientRects?.().length)
      return refuse('MIGRATION_CURRENT_WRITING_BODY_UNVERIFIED');
    const editor=editors[0];
    const descendants=[...editor.querySelectorAll('*')];
    if(descendants.length>2000||descendants.some(e=>!e.getClientRects?.().length))
      return refuse('MIGRATION_CURRENT_WRITING_BODY_INCOMPLETE');
    if(editor.querySelector('[hidden],[inert],[aria-hidden="true"],button,textarea,input,[contenteditable="true"]')||
       card.querySelector('[aria-busy="true"],[data-is-streaming="true"]'))
      return refuse('MIGRATION_CURRENT_WRITING_BODY_INCOMPLETE');
    // Read ONLY the owned complete document, never toolbar text or clipboard.
    // Marker may be the first document line or a separate assistant paragraph.
    let payload=(editor.innerText||'').trim();
    const markerInBody=payload.split(/\r?\n/).filter(line=>line.trim()===marker).length;
    const outsideMarkers=[...proof.body.querySelectorAll('p')].filter(p=>!card.contains(p)&&
      !p.closest('pre,code,blockquote,[contenteditable="true"]')&&(p.innerText||'').trim()===marker);
    if(markerInBody+outsideMarkers.length!==1||markerInBody===1&&!payload.startsWith(marker))
      return refuse('MIGRATION_MARKER_NOT_FOUND');
    if(markerInBody)payload=payload.slice(marker.length).trim();
    if(payload.length<80)return refuse('MIGRATION_PROMPT_TOO_SHORT');
    if(payload.length>maxChars)return refuse('MIGRATION_PROMPT_TOO_LONG');
    if(!matchesRequiredSource(payload))return refuse('MIGRATION_SOURCE_CONTEXT_MISMATCH');
    return {ok:true,body:payload,length:payload.length,evidence:'CURRENT_IDENTITY_WRITING_BLOCK',sourceContextVerified:true};
  }
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
      // Verified on actual Windows Chrome, October 2026:
      // <p><span>AUTOPILOT_MIGRATION_HANDOFF</span></p>
      // <div>...<code>the complete authored handoff</code>...</div>
      // The page has CODE elements but NO PRE elements. The first CODE in
      // the thread is a quoted marker in the earlier user request. Do not
      // search every CODE globally or read the surrounding chat transcript.
      const paragraph=markerEl?.closest?.("p");
      if(paragraph?.tagName?.toLowerCase()==="p" &&
         (paragraph.innerText||paragraph.textContent||"").trim()===marker &&
         paragraph.parentElement && paragraph.parentElement!==main &&
         !paragraph.parentElement.contains?.(requestNode)){
        const adjacent=paragraph.nextElementSibling;
        if(adjacent?.tagName?.toLowerCase()==="div" &&
           adjacent.parentElement===paragraph.parentElement &&
           !requestNodes.some(n=>adjacent.contains?.(n)) &&
           !markerNodes.some(n=>n!==markerNode && adjacent.contains?.(n))){
          const codes=[...adjacent.querySelectorAll?.("code")||[]]
            .filter(el=>!el.closest?.(
              'button,textarea,[contenteditable="true"],[aria-hidden="true"]'));
          if(codes.length>1){
            ambiguousBlocks=true;
            continue;
          }
          if(codes.length===1){
            valid.push({markerNode,code:codes[0]});
            continue;
          }
        }
      }
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
    // The current ChatGPT Writing Block renderer may produce a standalone
    // author marker followed by a titled "글쓰기" document card. Its content
    // is not PRE/CODE and may include contenteditable DOM. The source request
    // must have been verified above; never accept a generic page-wide article.
    if(valid.length===0 && !ambiguousBlocks && responseMarkers.length===1){
      const marked=responseMarkers[0];
      const paragraph=marked.parentElement?.closest?.("p");
      let writingCandidate=null;
      let writingMatches=0;
      let sawWritingCard=false;
      let cursor=paragraph||marked.parentElement;
      for(let depth=0;cursor&&cursor!==main&&depth<5;
          cursor=cursor.parentElement,depth++){
        if(cursor.contains?.(requestNode))break;
        const next=cursor.nextElementSibling;
        if(!next||next.contains?.(requestNode)||
           requestNodes.some(request=>next.contains?.(request)))continue;
        const visible=(next.innerText||next.textContent||"").trim();
        // The label and heading must be in the SAME immediate sibling.
        // A different assistant response must not be used as the handoff.
        const lines=visible.split(/\r?\n/).map(line=>line.trim())
          .filter(Boolean);
        const label=lines.findIndex(line=>/^(?:글쓰기|Writing)$/i.test(line));
        if(label>=0)sawWritingCard=true;
        const titleAt=lines.findIndex((line,i)=>i>label &&
          line.length>=8 && line.length<=180 &&
          /이관|handoff|transfer/i.test(line) &&
          (requiredSourceContext===null||
            line.includes(requiredSourceContext.trackTitle)));
        if(label<0||titleAt<0||titleAt>label+4)continue;
        const payload=visible.slice(visible.indexOf(lines[titleAt])).trim();
        if(payload.length<80||payload.length>maxChars)continue;
        if(!matchesRequiredSource(payload) &&
           !(requiredSourceContext!==null &&
             payload.includes(requiredSourceContext.repository) &&
             payload.includes(requiredSourceContext.trackTitle)))continue;
        if(!payload.includes("1.")&&!payload.includes("## ") &&
           !payload.includes("작업"))continue;
        // Exclude visible card toolbar lines at the tail, if present.
        const body=payload.replace(/(?:\r?\n(?:복사|Copy|전체 화면|Expand|글쓰기|Writing))+\s*$/i,"").trim();
        if(body.length<80||body.length>maxChars)continue;
        writingCandidate=body;writingMatches++;
      }
      if(writingMatches===1)
        return {ok:true,body:writingCandidate,length:writingCandidate.length,
          evidence:"UNATTRIBUTED_SOURCE_REQUEST_WRITING_BLOCK",
          sourceContextVerified:requiredSourceContext!==null};
      if(writingMatches>1)
        return refuse("MIGRATION_UNATTRIBUTED_WRITING_BLOCK_AMBIGUOUS");
      if(sawWritingCard)
        return refuse("MIGRATION_UNATTRIBUTED_WRITING_BLOCK_NOT_VERIFIED");
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
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="중지"],button[aria-label="Stop"]'
  )].some(x=>!x.disabled&&x.getClientRects?.().length);
  // October 2026 observed renderer. IDs must agree at all three boundaries;
  // never fall back to the legacy/proximity reader after a modern proof fails.
  const modernTurns=[...document.querySelectorAll('[data-content-search-turn-key]')]
    .filter(e=>e.closest('main')&&!e.closest('[hidden],[inert],[aria-hidden="true"],pre,code,blockquote'));
  const modernTurn=modernTurns.at(-1);
  const readModern=()=>{
    const visible=e=>!!e.getClientRects?.().length&&!e.closest('[hidden],[inert],[aria-hidden="true"]');
    const units=[...modernTurn.querySelectorAll('[data-chatgpt-search-unit-key]')].filter(visible);
    const unit=units.at(-1),user=units.at(-2),key=modernTurn.getAttribute('data-content-search-turn-key');
    const ids=e=>[...new Set((e?.getAttribute('data-chatgpt-search-message-ids')||'').split(/\s+/).filter(Boolean))];
    const aid=ids(unit),uid=ids(user);
    const nodes=selector=>[...unit?.querySelectorAll(selector)||[]].filter(visible);
    const bodies=nodes('[data-dil-message-id]'),sources=nodes('[data-dil-source-message-id]'),selections=nodes('[data-chatgpt-selection-message-id]');
    const states=[...modernTurn.querySelectorAll('[data-talvt-turn-state]')].filter(visible);
    const valid=!!key&&units.length===2&&unit.getAttribute('data-chatgpt-search-unit-key').startsWith(key+':')&&
      /:\d+:assistant$/.test(unit.getAttribute('data-chatgpt-search-unit-key'))&&
      user.getAttribute('data-chatgpt-search-unit-key').startsWith(key+':')&&/:\d+:user$/.test(user.getAttribute('data-chatgpt-search-unit-key'))&&
      aid.length===1&&uid.length===1&&[aid[0],uid[0]].every(id=>/^[a-zA-Z0-9-]{1,100}$/.test(id))&&
      bodies.length===1&&sources.length===1&&selections.length===1&&
      bodies[0].getAttribute('data-dil-message-id')===aid[0]&&sources[0].getAttribute('data-dil-source-message-id')===aid[0]&&
      selections[0].getAttribute('data-chatgpt-selection-message-id')===aid[0]&&sources[0].contains(bodies[0])&&selections[0].contains(bodies[0])&&
      !!bodies[0].closest('[data-markdown-text-style="assistant-message"]')&&states.length===1&&states[0].contains(unit);
    return valid?{body:bodies[0],user,assistantId:aid[0],userId:uid[0],complete:states[0].getAttribute('data-talvt-turn-state')==='complete'}:null;
  };
  if(modernTurn){
    const proof=readModern();
    if(!proof||document.querySelector('[data-message-author-role]'))return {ok:false,reason:'MIGRATION_CURRENT_IDENTITY_UNVERIFIED'};
    const text=(proof.body.innerText||'').trim();
    const complete=proof.complete&&!busy&&!proof.body.querySelector('[contenteditable="true"],[role="alert"],[role="status"]')&&
      !/이 응답을 불러오지 못했습니다|unable to load.*response/i.test(text);
    let hash=2166136261;for(const ch of proof.assistantId+'\0'+text)hash=Math.imul(hash^ch.charCodeAt(0),16777619)>>>0;
    return {ok:projectConversation,projectNew,projectConversation,busy:busy||!proof.complete,
      assistantCount:complete?modernTurns.length:0,lastReplyFingerprint:complete&&text.length>=20?'CURRENT_ASSISTANT_ID:'+text.length+':'+hash.toString(16):null,
      evidence:'CURRENT_ASSISTANT_ID',reason:projectConversation?null:'MIGRATION_TARGET_NOT_PROJECT_CHAT'};
  }
  const replies=[...new Set(document.querySelectorAll(
    '[data-message-author-role="assistant"],article[data-turn="assistant"]'
  ))];
  let last=replies.at(-1);
  let text=last?.innerText||last?.textContent||"";
  let evidence=last?"ASSISTANT_TURN_ROLE":"NONE";
  // Actual current ChatGPT may omit BOTH turn-role selectors. Do not infer
  // assistant completion from the user handoff text alone. The assistant
  // response feedback pair (positive AND negative) is surfaced only after a
  // completed answer. Pair buttons within one bounded toolbar rather than
  // conflating controls from unrelated messages. Never return actual text.
  let verifiedReplyCount=replies.length;
  if(!last && projectConversation && !busy){
    const main=document.querySelector?.("main");
    const positive=[...document.querySelectorAll(
      'button[data-testid*="good-response"],button[aria-label="Good response"],button[aria-label="좋아요"],button[aria-label="좋은 응답"]'
    )];
    const negative=[...document.querySelectorAll(
      'button[data-testid*="bad-response"],button[aria-label="Bad response"],button[aria-label="싫어요"],button[aria-label="나쁜 응답"]'
    )];
    const pairs=[];
    for(const good of positive){
      let shared=null;
      for(let p=good.parentElement,depth=0;p&&p!==main&&depth<6;
          p=p.parentElement,depth++){
        if(negative.some(bad=>p.contains?.(bad))){
          shared=p;break;
        }
      }
      if(shared&&main?.contains?.(shared))pairs.push(shared);
    }
    const body=(main?.innerText||main?.textContent||"").trim();
    if(pairs.length===1 && positive.length===1 && negative.length===1 &&
       body.length>=100 && body.length<=120000){
      verifiedReplyCount=1;
      text=body;
      evidence="ASSISTANT_FEEDBACK_PAIR";
    }
  }
  let hash=2166136261;
  for(let i=0;i<text.length;i++)
    hash=Math.imul(hash^text.charCodeAt(i),16777619)>>>0;
  return {
    ok:projectNew||projectConversation,
    projectNew,projectConversation,busy,
    assistantCount:verifiedReplyCount,
    lastReplyFingerprint:text.length>=20 ?
      evidence+":"+text.length+":"+hash.toString(16) : null,
    evidence,
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


// Recover the exact source -> target title from the transferred handoff, NOT
// from the mutable monitoring configuration. This is a read-only, manually
// initiated repair proof scoped to the current same-project conversation.
// No transcript content, DOM attributes or arbitrary candidate bodies escape.
export function inspectTransferredHandoffTrackPair(marker,repository){
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(location.pathname))
    return refuse("MIGRATION_REPAIR_WRONG_PROJECT_CHAT");
  if(typeof marker!=="string"||marker.length<8||marker.length>80 ||
     typeof repository!=="string"||
     !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    return refuse("MIGRATION_REPAIR_INVALID_CONTEXT");
  const main=document.querySelector("main");
  if(!main)return refuse("MIGRATION_REPAIR_MAIN_NOT_FOUND");
  const busy=[...document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="중지"]'
  )].some(x=>!x.disabled&&x.getClientRects?.().length);
  if(busy)return refuse("MIGRATION_REPAIR_TARGET_STILL_GENERATING");
  // In collapsed user messages, innerText may omit hidden content while
  // textContent retains it. Inspect both bounded variants, not the entire
  // page as a handoff payload.
  const variants=[...new Set([main.innerText,main.textContent]
    .filter(v=>typeof v==="string"&&v.length>=80&&v.length<=160000))];
  const diagnostics={
    renderedMarkerVisible:variants.some(t=>t.includes(marker)),
    renderedRepositoryVisible:variants.some(t=>t.includes(repository)),
    headingCandidates:0,fieldPairCandidates:0,
    hasExpandControl:[...(main.querySelectorAll?.("button")||[])]
      .some(b=>/^(?:더\s*보기|show more|read more)$/i.test(
        (b.innerText||b.textContent||b.getAttribute?.("aria-label")||"").trim()))
  };
  const refuseWithDiagnostic=reason=>({...refuse(reason),diagnostic:diagnostics});
  if(!variants.length)
    return refuseWithDiagnostic("MIGRATION_REPAIR_HANDOFF_PROVENANCE_NOT_VISIBLE");
  const clean=s=>String(s||"").replace(/\s+/g," ").trim()
    .replace(/^[*_]+|[*_]+$/g,"").trim();
  const bump=value=>{
    const m=value.match(/^(.*\S)\s+([0-9]{1,3})$/u);
    return m&&Number(m[2])<999?m[1]+" "+(Number(m[2])+1):null;
  };
  const pairs=[];
  for(const content of variants){
    if(!content.includes(marker))continue;
    const lines=content.split(/\r?\n/);
    let offset=0;
    const candidates=[];
    for(let i=0;i<lines.length;i++){
      const line=clean(lines[i]).replace(/^(?:#{1,6}\s*|[-•*]\s*)/,"")
        .replace(/^\*\*|\*\*$/g,"").trim();
      const field=line.match(/^(?:이전|원본|신규|다음|새)\s*트랙\s*[:：]\s*(.+)$/u);
      if(field){
        const type=/^(?:이전|원본)/u.test(line)?"source":"target";
        candidates.push({type,title:clean(field[1]),at:offset});
      }
      // The Writing Block heading embeds the original and target titles even
      // when its individual bullet rows are collapsed or differently spaced.
      const heading=line.match(/^(?:(?:채팅|개발)\s*)?이관\s*(?:프롬프트|문서)\s*[:：—–-]\s*(.+?)\s*(?:→|⇒|->)\s*(.+)$/u);
      if(heading){
        diagnostics.headingCandidates++;
        const sourceTitle=clean(heading[1]),nextTitle=clean(heading[2]);
        if(bump(sourceTitle)===nextTitle)
          candidates.push({type:"heading",sourceTitle,nextTitle,at:offset});
      }
      offset+=lines[i].length+1;
    }
    for(const c of candidates){
      let sourceTitle,nextTitle,at=c.at;
      if(c.type==="heading"){
        sourceTitle=c.sourceTitle;nextTitle=c.nextTitle;
      }else if(c.type==="source"){
        const target=candidates.find(x=>x.type==="target" &&
          x.at>c.at&&x.at-c.at<900);
        if(!target)continue;
        sourceTitle=c.title;nextTitle=target.title;
        diagnostics.fieldPairCandidates++;
      }else continue;
      if(!sourceTitle||!nextTitle||sourceTitle.length>160||
         nextTitle.length>160||bump(sourceTitle)!==nextTitle)continue;
      const around=content.slice(Math.max(0,at-1500),
        Math.min(content.length,at+4500));
      // Marker AND repository must belong to the bounded handoff context.
      if(!around.includes(marker)||!around.includes(repository))continue;
      pairs.push({sourceTitle,nextTitle});
    }
  }
  if(!diagnostics.renderedMarkerVisible)
    return refuseWithDiagnostic("MIGRATION_REPAIR_HANDOFF_MARKER_NOT_VISIBLE");
  if(!diagnostics.renderedRepositoryVisible)
    return refuseWithDiagnostic("MIGRATION_REPAIR_HANDOFF_REPOSITORY_NOT_VISIBLE");
  if(!pairs.length)
    return refuseWithDiagnostic("MIGRATION_REPAIR_HANDOFF_TRACK_PAIR_NOT_FOUND");
  const distinct=[...new Set(pairs.map(x=>JSON.stringify(x)))];
  if(distinct.length!==1)
    return refuseWithDiagnostic("MIGRATION_REPAIR_HANDOFF_TRACK_PAIR_AMBIGUOUS");
  return {ok:true,...pairs[0],evidence:"TRANSFERRED_HANDOFF_SOURCE_TARGET_PAIR"};
}

// Read-only provenance check for a previously transferred conversation when
// the extension was reloaded and the ephemeral migration progress was lost.
// This never returns transcript text or infers a target from a matching title.
export function inspectAlreadyTransferredHandoff(marker,repository,sourceTitle,nextTitle){
  const refuse=reason=>({ok:false,reason});
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(location.pathname))
    return refuse("MIGRATION_REPAIR_WRONG_PROJECT_CHAT");
  if([marker,repository,sourceTitle,nextTitle].some(v=>
    typeof v!=="string"||v.length<3||v.length>180))
    return refuse("MIGRATION_REPAIR_INVALID_CONTEXT");
  const busy=[...document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="중지"]'
  )].some(x=>!x.disabled&&x.getClientRects?.().length);
  if(busy)return refuse("MIGRATION_REPAIR_TARGET_STILL_GENERATING");
  const main=document.querySelector("main");
  if(!main)return refuse("MIGRATION_REPAIR_MAIN_NOT_FOUND");
  const texts=[...new Set([main.innerText,main.textContent]
    .filter(t=>typeof t==="string" && t.length>=150&&t.length<=160000))];
  // The actual transferred user handoff must remain present. Collapsed
  // messages can omit its hidden text in innerText yet retain textContent.
  // A sidebar title or operator input alone is never handoff provenance.
  if(!texts.some(text=>[marker,repository,sourceTitle,nextTitle]
    .every(v=>text.includes(v))))
    return refuse("MIGRATION_REPAIR_HANDOFF_PROVENANCE_NOT_VISIBLE");
  return {ok:true,evidence:"VISIBLE_TRANSFERRED_HANDOFF_CONTEXT"};
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
export function readRegisteredChatTitle(expectedTitle=null) {
  const clean=value=>String(value||"").replace(/\s+/g," ").trim();
  const valid=value=>value.length>=3 && value.length<=160 &&
    /^.+\S\s+[0-9]{1,3}$/.test(value) && !/^ChatGPT(?:\s+\d+)?$/i.test(value);
  const refuse=(reason,diagnostic=null)=>({ok:false,reason,
    ...(diagnostic?{diagnostic}:{})});
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))
    return refuse("CHAT_TITLE_NOT_EXISTING_CONVERSATION");
  // Explicit repair requires an exact N+1 title. Never decide that a
  // numbered but different title is close enough or infer one from the body.
  if(expectedTitle!==null &&
     (typeof expectedTitle!=="string" || !valid(clean(expectedTitle))))
    return refuse("CHAT_TITLE_EXPECTED_INVALID");
  const expected=expectedTitle===null?null:clean(expectedTitle);
  const links=[...document.querySelectorAll('a[href]')];
  const matching=links.filter(link=>{
    try{
      const url=new URL(link.getAttribute?.("href")||link.href,location.origin);
      return url.origin===location.origin &&
        url.pathname.replace(/\/$/,"")===location.pathname.replace(/\/$/,"");
    }catch{return false}
  });
  const sidebar=matching.filter(link=>link.closest?.('nav,aside,[data-sidebar]'));
  const candidates=sidebar.length?sidebar:matching;
  const visible=candidates.filter(link=>!!link.getClientRects?.().length);
  const selected=visible.length?visible:candidates;
  const fromLink=link=>{
    const source=[
      link.innerText,link.textContent,
      link.getAttribute?.("aria-label"),link.getAttribute?.("title")
    ];
    // ChatGPT sometimes wraps the title in a span while its anchor also
    // contains hover-menu and screen-reader labels.
    for(const child of [...(link.querySelectorAll?.("span,[title],[aria-label]")||[])].slice(0,50))
      source.push(child.innerText,child.textContent,
        child.getAttribute?.("aria-label"),child.getAttribute?.("title"));
    return [...new Set(source.map(clean).filter(valid))];
  };
  const titles=[...new Set(selected.flatMap(fromLink))];
  const browserTitle=clean(document.title)
    .replace(/\s*[-–—|]\s*ChatGPT\s*$/i,"");
  const diagnostic={
    currentConversationLinks:matching.length,
    sidebarConversationLinks:sidebar.length,
    renderedConversationLinks:visible.length,
    numberedTitleCandidates:titles.length,
    browserTitleNumbered:valid(browserTitle),
    expectedInLinkedTitle:expected===null?null:titles.includes(expected),
    expectedInBrowserTitle:expected===null?null:browserTitle===expected
  };
  if(expected!==null){
    if(titles.includes(expected) && titles.every(title=>title===expected))
      return {ok:true,title:expected,source:"chat-sidebar-exact",diagnostic};
    if(titles.length>0)
      return refuse(titles.includes(expected)?
        "CHAT_TITLE_CONFLICTING_LINK_TITLES":"CHAT_TITLE_LINK_TITLE_MISMATCH",diagnostic);
    // Browser title is used only if there is no verifiable numbered
    // sidebar candidate. Never override a contradictory sidebar title.
    if(browserTitle===expected)
      return {ok:true,title:expected,source:"browser-title-exact",diagnostic};
    return refuse(matching.length?
      "CHAT_TITLE_LINK_TITLE_NOT_READABLE":"CHAT_TITLE_NO_MATCHING_CONVERSATION_LINK",
      diagnostic);
  }
  // Keep the original API shape for ordinary track-title discovery.
  // Diagnostics apply only to explicit expected-title repair calls.
  if(titles.length===1)return {ok:true,title:titles[0],source:"chat-sidebar"};
  if(titles.length>1)return refuse("CHAT_TITLE_MULTIPLE_MATCHES");
  if(valid(browserTitle))return {ok:true,title:browserTitle,
    source:"browser-title"};
  return refuse("CHAT_TITLE_NOT_FOUND_OR_UNNUMBERED");
}

/**
 * Read-only structural diagnostics for a previously authored ChatGPT handoff.
 * Returns no message bodies, URLs, CSS classes, IDs, aria labels or text.
 * Operator runs it explicitly from the extension; it never sends a prompt.
 */
export function inspectAuthoredHandoffDomShape(marker="AUTOPILOT_MIGRATION_HANDOFF"){
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))
    return {ok:false,reason:"MIGRATION_DIAGNOSTIC_WRONG_CHAT"};
  const main=document.querySelector?.("main");
  if(!main||!document.createTreeWalker)
    return {ok:false,reason:"MIGRATION_DIAGNOSTIC_MAIN_MISSING"};
  const nodes=[],markers=[],requests=[];
  const walker=document.createTreeWalker(main,4);
  let node;
  while((node=walker.nextNode())){
    if(node.parentElement?.closest?.(
      'textarea,[contenteditable="true"],nav,aside,button,[aria-hidden="true"]'))continue;
    const value=(node.textContent||"").trim();
    if(!value)continue;
    nodes.push(node);
    if(value===marker)markers.push(node);
    if(value.includes("현재 개발 채팅의 길이 제한으로 다음 채팅에 이관해야 합니다."))
      requests.push(node);
  }
  // Report Writing Block shape even if source/marker text was virtualized
  // between the failed capture and this later operator-driven inspection.
  const writingLabels=[];
  const allTextWalker=document.createTreeWalker(main,4);
  let n;
  while((n=allTextWalker.nextNode())){
    if((n.textContent||"").trim()==="글쓰기")
      writingLabels.push(n);
  }
  const visibleText=(main.innerText||main.textContent||"");
  const follows=(a,b)=>!!(a?.compareDocumentPosition?.(b)&4);
  const isWithin=(element,child)=>!!element?.contains?.(child);
  const tag=element=>typeof element?.tagName==="string"?
    element.tagName.toLowerCase():"unknown";
  const sibling=node=>{
    const result=[];
    for(let p=node?.nextElementSibling;p&&result.length<3;p=p.nextElementSibling){
      const text=(p.innerText||p.textContent||"");
      result.push({tag:tag(p),chars:text.length,children:p.childElementCount||0,
        containsMarker:text.includes(marker),
        containsRequest:text.includes("현재 개발 채팅의 길이 제한으로")});
    }
    return result;
  };
  const describe=node=>{
    const result=[];
    for(let p=node.parentElement,depth=0;p&&depth<12;depth++,p=p.parentElement){
      const text=(p.innerText||p.textContent||"");
      result.push({depth,tag:tag(p),chars:text.length,
        children:p.childElementCount||0,
        textNodes:nodes.filter(n=>isWithin(p,n)).length,
        markerNodes:markers.filter(n=>isWithin(p,n)).length,
        requestNodes:requests.filter(n=>isWithin(p,n)).length,
        startsWithMarker:text.trimStart().startsWith(marker),
        testIdPresent:!!p.hasAttribute?.("data-testid"),
        rolePresent:!!p.hasAttribute?.("role"),
        authorRolePresent:!!p.hasAttribute?.("data-message-author-role"),
        turnAttrPresent:!!p.hasAttribute?.("data-turn"),
        classPresent:!!p.hasAttribute?.("class"),
        codeChildren:p.querySelectorAll?.("pre,code")?.length||0,
        nextSiblings:sibling(p)});
      if(p===main)break;
    }
    return result;
  };
  return {
    ok:true,version:1,readOnly:true,
    counts:{
      textNodes:nodes.length,markers:markers.length,requests:requests.length,
      pre:main.querySelectorAll?.("pre")?.length||0,
      code:main.querySelectorAll?.("code")?.length||0,
      writingLabels:writingLabels.length,
      contenteditableRoots:main.querySelectorAll?.('[contenteditable="true"]')?.length||0,
      hasMarkerInRenderedMain:visibleText.includes(marker),
      hasOriginalRequestInRenderedMain:visibleText.includes(
        "현재 개발 채팅의 길이 제한으로 다음 채팅에 이관해야 합니다."),
      classicTurns:document.querySelectorAll?.('[data-message-author-role]')?.length||0,
      articleTurns:document.querySelectorAll?.('article[data-turn]')?.length||0
    },
    requestOrigins:requests.slice(-3).map((n,i)=>({
      index:Math.max(0,requests.length-3)+i,ancestors:describe(n)
    })),
    markerOrigins:markers.slice(-3).map((n,i)=>({
      index:Math.max(0,markers.length-3)+i,
      afterLastRequest:!!requests.length&&follows(requests.at(-1),n),
      ancestors:describe(n)
    })),
    writingOrigins:writingLabels.slice(-2).map(n=>({
      afterLastMarker:!!markers.length&&follows(markers.at(-1),n),
      ancestors:describe(n)
    }))
  };
}
