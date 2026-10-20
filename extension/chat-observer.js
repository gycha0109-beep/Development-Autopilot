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
    const editors = nodes('textarea,[contenteditable="true"]');
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
      const unit=units.at(-1),turnKey=currentTurn.getAttribute("data-content-search-turn-key");
      const key=unit?.getAttribute("data-chatgpt-search-unit-key")||"";
      const ids=[...new Set((unit?.getAttribute("data-chatgpt-search-message-ids")||"").split(/\s+/).filter(Boolean))];
      const bodies=unit?[...unit.querySelectorAll('[data-dil-message-id]')].filter(visible):[];
      const selections=unit?[...unit.querySelectorAll('[data-chatgpt-selection-message-id]')].filter(visible):[];
      const sources=unit?[...unit.querySelectorAll('[data-dil-source-message-id]')].filter(visible):[];
      const states=[...currentTurn.querySelectorAll('[data-talvt-turn-state]')].filter(el=>!el.closest('[aria-hidden="true"],[hidden],[inert]'));
      const state=states.length===1?states[0].getAttribute("data-talvt-turn-state"):null;
      const composerForms=nodes('form[data-chatgpt-composer][data-composer-placement="thread"]');
      const ownsComposer=composerForms.length===1&&editors.length===1&&composerForms[0].contains(editors[0]);
      const proof=turns.length===0&&!!turnKey&&key.startsWith(turnKey+":")&&/:\d+:assistant$/.test(key)&&
        ids.length===1&&/^[a-zA-Z0-9-]{1,100}$/.test(ids[0])&&bodies.length===1&&selections.length===1&&sources.length===1&&
        bodies[0].getAttribute("data-dil-message-id")===ids[0]&&
        selections[0].getAttribute("data-chatgpt-selection-message-id")===ids[0]&&
        sources[0].getAttribute("data-dil-source-message-id")===ids[0]&&
        !!bodies[0].closest('[data-markdown-text-style="assistant-message"]')&&
        selections[0].contains(bodies[0])&&sources[0].contains(bodies[0])&&
        states.length===1&&states[0].contains(unit);
      if(proof){assistant=bodies[0];messageId=ids[0];}
      currentAmbiguous=!proof||!ownsComposer;
      currentBusy=proof&&ownsComposer&&state==="complete"?false:
        state!==null&&state!=="complete"?true:null;
    }
    const stopButtons = nodes('button[data-testid="stop-button"]');
    const stops = stopButtons.filter(el => !el.disabled &&
      editors.length === 1 && el.closest("form")?.contains(editors[0]));
    const lookalikeStops = nodes('button[aria-label="Stop generating"],button[aria-label="Stop"]')
      .filter(el => !stopButtons.includes(el));
    const sendButtons = nodes('button[data-testid="send-button"],button[data-testid="composer-send-button"]')
      .filter(el => editors.length === 1 && el.closest("form")?.contains(editors[0]));
    const stopControlVerified = stops.length === 1 && stopButtons.length === 1 && lookalikeStops.length === 0;
    const assistantBusy = stopControlVerified || currentBusy===true || assistant?.getAttribute("aria-busy") === "true" ||
      assistant?.getAttribute("data-is-streaming") === "true" ? true :
      stopButtons.length === 0 && lookalikeStops.length === 0 && (currentBusy===false||sendButtons.length === 1) ? false : null;
    let incomplete = false;
    // Bounded traversal rejects hidden/editable subtrees before touching text.
    // Quote/code text can contribute to a digest, never to semantic cues.
    const read = (root, cues = false) => {
      let visited = 0, text = "";
      const visit = node => {
        if (++visited > 2000 || text.length > 32000) { incomplete = true; return; }
        if (node.nodeType === 3) {
          if (node.length > 32000-text.length) { incomplete = true; return; }
          text += node.data + " "; return;
        }
        if (node.nodeType !== 1) return;
        if (!visible(node)) { incomplete = true; return; }
        if (node.matches('textarea,input,[contenteditable="true"],script,style')) {
          incomplete = true; return;
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
    if (!matchesPage()) return unknown("CONVERSATION_CHANGED_DURING_READ");
    return {...base, verified:true, reasonCode:"UI_OBSERVED", bindingFingerprint:request.bindingFingerprint,
      assistantBusy, composerHasDraft, stopControlVerified,
      connectionWarning, lengthWarning, providerRestriction, otherWarning,
      uiAmbiguous:currentAmbiguous || editors.length !== 1 || stopButtons.length > 1 || lookalikeStops.length > 0,
      contentComplete:!!replyFingerprint && !incomplete,
      replyFingerprint,
      humanActionCategory,
      ciWaitCue:/\bCI\b.{0,45}(?:pending|running|queued|waiting|대기|확인\s*중|실행\s*중)|병합.{0,15}확인\s*중/i.test(cues),
      humanActionCue:humanActionCategory!==null,
      scopeCompleteCue:/승인된.{0,15}(?:목표|범위).{0,15}완료|approved (?:scope|goal).{0,15}complete/i.test(cues)};
  } catch {
    // DOM/provider failures must not leak text, URL, or exception messages.
    return unknown("DOM_OBSERVATION_FAILED");
  }
}
