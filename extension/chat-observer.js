// Read-only page capture used by the explicitly opted-in observation worker.
// Self-contained for chrome.scripting serialization. Never return page text.
export async function captureChatObservation(request = {}) {
  const base = {schemaVersion:1, sourceVersion:"chat-observer-1", source:"chatgpt-dom"};
  const unknown = reasonCode => ({...base, verified:false, reasonCode});
  if (request.permitted !== true) return unknown("OBSERVATION_NOT_PERMITTED");
  const matchesPage = () => location.origin === "https://chatgpt.com" &&
    location.pathname === request.expectedPath &&
    /^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(location.pathname);
  if (!matchesPage()) return unknown("CONVERSATION_MISMATCH");
  if (!/^[a-f0-9]{64}$/.test(request.bindingFingerprint || ""))
    return unknown("INVALID_OBSERVATION_BINDING");
  try {
    if (document.visibilityState === "prerender") return unknown("PAGE_NOT_READY");
    const visible = el => !!el?.getClientRects?.().length &&
      !el.closest('[aria-hidden="true"],[hidden],[inert]');
    const nodes = selector => [...new Set(document.querySelectorAll(selector))].filter(visible);
    // Detect ONLY a live ChatGPT tool-permission control cluster. Assistant
    // prose mentioning "approval" or buttons inside a tool preview is not proof.
    // Do not return command arguments, message text, DOM, or approval choices.
    const detectToolPermission = () => {
      const outsideReply = el => !el.closest?.(
        'pre,code,blockquote,q,form[data-chatgpt-composer],[contenteditable="true"]');
      const controls=nodes("button").filter(outsideReply);
      const label=el=>(el?.innerText||el?.textContent||"").replace(/\s+/g," ").trim();
      const once=controls.filter(el=>/^(?:한 번만 허용(?:하기)?|allow once|allow this time)$/i.test(label(el)));
      const always=controls.filter(el=>/^(?:항상 허용(?:하기)?|always allow)$/i.test(label(el)));
      const deny=controls.filter(el=>/^(?:거부|허용 안 함|deny|don't allow)$/i.test(label(el)));
      if(once.length!==1||always.length!==1||deny.length!==1)
        return {observed:true,pending:false};
      let card=null;
      const prompt=/(?:사용하도록 허용할까요|사용하도록 허용|allow ChatGPT to use|ChatGPT.*permission to use)/i;
      for(let el=once[0].parentElement,depth=0;el&&depth<10;el=el.parentElement,depth++){
        const raw=label(el);
        if(el.contains(always[0])&&el.contains(deny[0])&&
           raw.length>=35&&raw.length<=2200&&prompt.test(raw)){
          card=el;break;
        }
      }
      if(!card||!visible(card)||card.matches?.("main,body,html")||
         card.closest?.('pre,code,blockquote,q,form[data-chatgpt-composer],[contenteditable="true"]'))
        return {observed:true,pending:false};
      const raw=label(card);
      const match=raw.match(/ChatGPT(?:가|에게|이)?\s+(.{2,90}?)\s*(?:을\(를\)|을|를)?\s*사용하도록\s*허용/i)||
        raw.match(/(?:allow ChatGPT to use|ChatGPT.*permission to use)\s+(.{2,90}?)(?:[?\n]|$)/i);
      const tool=(match?.[1]||"확인 필요").replace(/[\r\n<>\u0000-\u001f]/g," ").replace(/\s+/g," ").trim().slice(0,90);
      return {observed:true,pending:true,kind:"tool_permission",tool};
    };
    const toolApproval=detectToolPermission();
    // Only the single thread composer is authoritative. File/spreadsheet previews
    // may contain many editable cells and toolbars; never consider them drafts
    // or send controls belonging to the ChatGPT conversation.
    const threadForms=nodes('form[data-chatgpt-composer][data-composer-placement="thread"]');
    const threadForm=threadForms.length===1?threadForms[0]:null;
    const editors=threadForm?nodes('textarea,[contenteditable="true"]').filter(el=>
      threadForm.contains(el) && !el.closest('[aria-hidden="true"],[hidden],[inert]')):[];
    // Presence/length metadata only: never read editable value/text/HTML.
    const draft = el => {
      if (el.tagName === "TEXTAREA") return el.matches(":placeholder-shown") ? false : null;
      let count = 0;
      const containsText = node => {
        if (++count > 200) return true;
        if (node.nodeType === 3) return node.length > 0;
        return [...(node.childNodes || [])].some(containsText);
      };
      return containsText(el);
    };
    const composerHasDraft = editors.length === 1 ? draft(editors[0]) : null;
    const turns = nodes('[data-message-author-role]');
    const lastTurn = turns.at(-1);
    let assistant = lastTurn?.getAttribute("data-message-author-role") === "assistant" ? lastTurn : null;
    let messageId=assistant?.getAttribute("data-message-id"),currentBusy=null,currentAmbiguous=false;
    // Current ChatGPT renderer: bind the last visible assistant unit to one
    // conversation turn and corroborate its message ID across independent DOM
    // boundaries. A CSS class, plain heading, or voice button is insufficient.
    const excluded='pre,code,blockquote,q,[contenteditable="true"]';
    const currentTurns=nodes('[data-content-search-turn-key]').filter(el=>el.closest("main")&&!el.closest(excluded));
    const currentTurn=currentTurns.at(-1);
    if(currentTurn){
      const units=nodes('[data-chatgpt-search-unit-key]').filter(el=>
        el.closest('[data-content-search-turn-key]')===currentTurn&&!el.closest(excluded));
      // Some completed turns include trailing non-message UI units. A user
      // message after an assistant is never an eligible completed reply.
      const keyOf=el=>el.getAttribute("data-chatgpt-search-unit-key")||"";
      const assistantUnits=units.filter(el=>/:\d+:assistant$/.test(keyOf(el)));
      const unit=assistantUnits.at(-1),assistantIndex=units.indexOf(unit);
      const trailingUser=assistantIndex<0||units.slice(assistantIndex+1).some(el=>/:\d+:user$/.test(keyOf(el)));
      const turnKey=currentTurn.getAttribute("data-content-search-turn-key");
      const key=unit?keyOf(unit):"";
      const ids=[...new Set((unit?.getAttribute("data-chatgpt-search-message-ids")||"").split(/\s+/).filter(Boolean))];
      const bodies=unit?[...unit.querySelectorAll('[data-dil-message-id]')].filter(visible):[];
      const selections=unit?[...unit.querySelectorAll('[data-chatgpt-selection-message-id]')].filter(visible):[];
      const sources=unit?[...unit.querySelectorAll('[data-dil-source-message-id]')].filter(visible):[];
      const states=[...currentTurn.querySelectorAll('[data-talvt-turn-state]')].filter(el=>!el.closest('[aria-hidden="true"],[hidden],[inert]'));
      const state=states.length===1?states[0].getAttribute("data-talvt-turn-state"):null;
      const ownsComposer=!!threadForm&&editors.length===1&&threadForm.contains(editors[0]);
      // The unit ID and DIL body ID are independent boundaries. Selection/
      // source wrappers may be absent after a renderer update, but if present
      // they MUST be unique, have the same ID and contain the assistant body.
      const body=bodies.length===1?bodies[0]:null;
      const sameId=ids.length===1&&/^[a-zA-Z0-9-]{1,100}$/.test(ids[0])&&
        body?.getAttribute("data-dil-message-id")===ids[0];
      const wrapperMatches=(items,attribute)=>items.length===0||
        (items.length===1&&items[0].getAttribute(attribute)===ids[0]&&items[0].contains(body));
      const hasCanonicalBody=!!body?.closest('[data-markdown-text-style="assistant-message"]');
      const stateOwnsAssistant=states.length===1&&states[0].contains(unit);
      const proof=turns.length===0&&!!turnKey&&key.startsWith(turnKey+":")&&
        /:\d+:assistant$/.test(key)&&!trailingUser&&sameId&&hasCanonicalBody&&
        wrapperMatches(selections,"data-chatgpt-selection-message-id")&&
        wrapperMatches(sources,"data-dil-source-message-id")&&stateOwnsAssistant;
      if(proof){assistant=body;messageId=ids[0];}
      currentAmbiguous=!proof||!ownsComposer;
      currentBusy=proof&&ownsComposer&&state==="complete"?false:
        state!==null&&state!=="complete"?true:null;
    }
    const stopButtons = threadForm ? nodes('button[data-testid="stop-button"]').filter(el=>threadForm.contains(el)) : [];
    const stops = stopButtons.filter(el => !el.disabled);
    const lookalikeStops = nodes('button[aria-label="Stop generating"],button[aria-label="Stop"]')
      .filter(el => threadForm?.contains(el) && !stopButtons.includes(el));
    const sendButtons = nodes('button[data-testid="send-button"],button[data-testid="composer-send-button"]')
      .filter(el => threadForm?.contains(el));
    const stopControlVerified = stops.length === 1 && stopButtons.length === 1 && lookalikeStops.length === 0;
    const assistantBusy = stopControlVerified || currentBusy===true || assistant?.getAttribute("aria-busy") === "true" ||
      assistant?.getAttribute("data-is-streaming") === "true" ? true :
      stopButtons.length === 0 && lookalikeStops.length === 0 && (currentBusy===false||sendButtons.length === 1) ? false : null;
    let incomplete = false;
    const traversal={hiddenSkipped:0,unsafeEmbedded:0,nodeBudgetExceeded:false,textBudgetExceeded:false};
    // Bounded traversal includes visible assistant text, skipping nonrendered decorations.
    // Quote/code text can contribute to a digest, never to semantic cues.
    const read = (root, cues = false) => {
      let visited = 0, text = "";
      const visit = node => {
        if (++visited > 20000) { incomplete = true; traversal.nodeBudgetExceeded=true; return; }
        if (text.length > 128000) { incomplete = true; traversal.textBudgetExceeded=true; return; }
        if (node.nodeType === 3) {
          if (node.length > 128000-text.length) { incomplete = true; traversal.textBudgetExceeded=true; return; }
          text += node.data + " "; return;
        }
        if (node.nodeType !== 1) return;
        // Hidden branches exist in normal ChatGPT answers (tooltips, offscreen labels,
        // rich DIL component scaffolding). They are not part of the visible reply.
        if (!visible(node)) { traversal.hiddenSkipped++; return; }
        if (node.matches('script,style')) return;
        if (node.matches('textarea,input,[contenteditable="true"]')) {
          incomplete = true; traversal.unsafeEmbedded++; return;
        }
        if (cues && node.matches("pre,code,blockquote,q")) return;
        for (const child of node.childNodes) visit(child);
      };
      visit(root);
      return text.replace(/\s+/g," ").trim();
    };
    // A failed conversation fetch replaces the entire thread, including its
    // composer. Recognize only the standalone provider panel, never transcript,
    // sidebar, draft or quoted text. Negative evidence cannot authorize retry.
    if(editors.length===0&&turns.length===0&&currentTurns.length===0&&
       stopButtons.length===0&&lookalikeStops.length===0&&
       nodes('article,pre,code,blockquote,q').length===0){
      const mains=nodes('main');
      if(mains.length===1){
        const buttons=[...mains[0].querySelectorAll('button')].filter(visible);
        const retry=buttons.filter(el=>!el.disabled&&/^(?:다시 시도|retry|try again)$/i.test(read(el,true)));
        if(retry.length===1&&/^(?:이 ChatGPT 대화를 불러올 수 없습니다|unable to load (?:this|the) ChatGPT conversation)[.!]?\s+(?:다시 시도|retry|try again)$/i.test(read(mains[0],true)))
          return unknown('CONVERSATION_UNAVAILABLE');
      }
    }
    let connectionWarning = false, lengthWarning = false, providerRestriction = false, otherWarning = false;
    for (const banner of nodes('[role="alert"]')) {
      if (banner.closest('[data-message-author-role],[data-content-search-turn-key],article,blockquote,pre,code,[contenteditable="true"]')) continue;
      const text = read(banner);
      const disconnect = /연결이 해제되었습니다\.? 전체 답변을 기다리는 중입니다\.?/i.test(text);
      const length = /이 대화의 최대 길이에 도달|maximum length (?:for |of )?this conversation/i.test(text);
      const restriction = /usage limit|rate limit|quota|sign in|log in|사용량.*한도|로그인|이용.*제한/i.test(text);
      connectionWarning ||= disconnect;
      lengthWarning ||= length;
      providerRestriction ||= restriction;
      otherWarning ||= !disconnect && !length && !restriction;
    }
    const reply = assistant ? read(assistant) : "";
    const cues = assistant ? read(assistant, true) : "";
    // The current renderer can mark this provider error as a complete assistant
    // turn with every normal message-ID boundary and no role=alert banner.
    // It is not an answer and must never establish a stable response fingerprint.
    if(/^(?:이 응답을 불러오지 못했습니다|(?:unable|failed) to load (?:this|the) response|could(?:n['’]t| not) load (?:this|the) response)[.!]?$/i.test(cues))
      return unknown("ASSISTANT_RESPONSE_UNAVAILABLE");
    const id = messageId;
    const humanActionCategory=/추가\s*비용|결제.{0,20}(?:필요|요청)|payment required|cost approval/i.test(cues)?"cost":
      /로컬.{0,20}(?:테스트|검증).{0,20}(?:필요|요청)|local Windows (?:test|verification) required/i.test(cues)?"local_test":
      /로그인.{0,15}필요|login required/i.test(cues)?"login":
      /승인이 필요|승인해\s*주|approval required|please approve|manual (?:test|action) required/i.test(cues)?"approval":null;
    const digest = async text => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(request.bindingFingerprint + "\0" + text)))].map(x=>x.toString(16).padStart(2,"0")).join("");
    const replyFingerprint = id && reply && !incomplete ? await digest(id + "\0" + reply) : null;
    // Optional, read-only provenance for an explicitly scoped recovery report.
    // Only message-ID digests and an exact fixed-prompt match leave this page.
    let recoveryUserFingerprint=null,recoveryReportProof=null;
    if(/^[a-f0-9-]{36}$/.test(request.recoveryOperationId||"")){
      let user=null,userId=null;
      if(currentTurn){
        const units=nodes('[data-chatgpt-search-unit-key]').filter(el=>el.closest('[data-content-search-turn-key]')===currentTurn&&!el.closest(excluded));
        const last=units.at(-1),candidate=/:\d+:assistant$/.test(last?.getAttribute('data-chatgpt-search-unit-key')||"")?units.at(-2):last;
        const ids=[...new Set((candidate?.getAttribute('data-chatgpt-search-message-ids')||"").split(/\s+/).filter(Boolean))];
        if(/:\d+:user$/.test(candidate?.getAttribute('data-chatgpt-search-unit-key')||"")&&ids.length===1){user=candidate;userId=ids[0];}
      }else{
        const candidate=lastTurn?.getAttribute('data-message-author-role')==="assistant"?turns.at(-2):lastTurn;
        if(candidate?.getAttribute('data-message-author-role')==="user"){user=candidate;userId=candidate.getAttribute('data-message-id');}
      }
      if(user&&/^[a-zA-Z0-9-]{1,100}$/.test(userId||"")){
        recoveryUserFingerprint=await digest("recovery-user\0"+userId);
        if(read(user,true)==="현재까지 진행한 작업과 남은 작업을 보고해줘."&&!incomplete)
          recoveryReportProof={operationId:request.recoveryOperationId,userFingerprint:recoveryUserFingerprint};
      }
    }
    if (!matchesPage()) return unknown("CONVERSATION_CHANGED_DURING_READ");
    return {...base, verified:true, reasonCode:"UI_OBSERVED", bindingFingerprint:request.bindingFingerprint,
      assistantBusy, composerHasDraft, stopControlVerified,
      toolApproval,connectionWarning, lengthWarning, providerRestriction, otherWarning,
      uiAmbiguous:currentAmbiguous || editors.length !== 1 || stopButtons.length > 1 || lookalikeStops.length > 0,
      contentComplete:!!replyFingerprint && !incomplete,
      diagnostic:{hasMessageId:!!messageId,hasReply:!!reply,traversalIncomplete:incomplete,
        currentRenderer:!!currentTurn,currentProof:!!assistant,currentBusy,
        threadForms:threadForms.length,threadEditors:editors.length,
        ignoredOutsideEditors:Math.max(0,nodes('textarea,[contenteditable="true"]').length-editors.length),
        ...traversal},
      replyFingerprint,
      ...(request.recoveryOperationId?{recoveryUserFingerprint,recoveryReportProof}:{}),
      humanActionCategory:toolApproval.pending?"tool_permission":humanActionCategory,
      ciWaitCue:/\bCI\b.{0,45}(?:pending|running|queued|waiting|대기|확인\s*중|실행\s*중)|병합.{0,15}확인\s*중/i.test(cues),
      humanActionCue:toolApproval.pending||humanActionCategory!==null,
      scopeCompleteCue:/승인된.{0,15}(?:목표|범위).{0,15}완료|approved (?:scope|goal).{0,15}complete/i.test(cues)};
  } catch {
    // DOM/provider failures must not leak text, URL, or exception messages.
    return unknown("DOM_OBSERVATION_FAILED");
  }
}
