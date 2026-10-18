// WP-01 only. Not wired to alarms, continuation, migration, or production UI.
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
    const assistant = lastTurn?.getAttribute("data-message-author-role") === "assistant" ? lastTurn : null;
    const stopButtons = nodes('button[data-testid="stop-button"]');
    const stops = stopButtons.filter(el => !el.disabled &&
      editors.length === 1 && el.closest("form")?.contains(editors[0]));
    const lookalikeStops = nodes('button[aria-label="Stop generating"],button[aria-label="Stop"]')
      .filter(el => !stopButtons.includes(el));
    const sendButtons = nodes('button[data-testid="send-button"],button[data-testid="composer-send-button"]')
      .filter(el => editors.length === 1 && el.closest("form")?.contains(editors[0]));
    const stopControlVerified = stops.length === 1 && stopButtons.length === 1 && lookalikeStops.length === 0;
    const assistantBusy = stopControlVerified || assistant?.getAttribute("aria-busy") === "true" ||
      assistant?.getAttribute("data-is-streaming") === "true" ? true :
      stopButtons.length === 0 && lookalikeStops.length === 0 && sendButtons.length === 1 ? false : null;
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
    let connectionWarning = false, lengthWarning = false, providerRestriction = false, otherWarning = false;
    for (const banner of nodes('[role="alert"]')) {
      if (banner.closest('[data-message-author-role],article,blockquote,pre,code,[contenteditable="true"]')) continue;
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
    const id = assistant?.getAttribute("data-message-id");
    const digest = async text => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(request.bindingFingerprint + "\0" + text)))].map(x=>x.toString(16).padStart(2,"0")).join("");
    const replyFingerprint = id && reply && !incomplete ? await digest(id + "\0" + reply) : null;
    if (!matchesPage()) return unknown("CONVERSATION_CHANGED_DURING_READ");
    return {...base, verified:true, reasonCode:"UI_OBSERVED", bindingFingerprint:request.bindingFingerprint,
      assistantBusy, composerHasDraft, stopControlVerified,
      connectionWarning, lengthWarning, providerRestriction, otherWarning,
      uiAmbiguous:editors.length !== 1 || stopButtons.length > 1 || lookalikeStops.length > 0,
      contentComplete:!!replyFingerprint && !incomplete,
      replyFingerprint,
      ciWaitCue:/\bCI\b.{0,45}(?:pending|running|queued|waiting|대기|확인\s*중|실행\s*중)|병합.{0,15}확인\s*중/i.test(cues),
      humanActionCue:/승인이 필요|승인해\s*주|추가\s*비용|결제.{0,20}(?:필요|요청)|로그인.{0,15}필요|로컬.{0,20}(?:테스트|검증).{0,20}(?:필요|요청)|(?:approval|payment|login|manual (?:test|action)|local Windows (?:test|verification)) required|cost approval|please approve/i.test(cues),
      scopeCompleteCue:/승인된.{0,15}(?:목표|범위).{0,15}완료|approved (?:scope|goal).{0,15}complete/i.test(cues)};
  } catch {
    // DOM/provider failures must not leak text, URL, or exception messages.
    return unknown("DOM_OBSERVATION_FAILED");
  }
}
