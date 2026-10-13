// Executed only inside an explicitly registered ChatGPT tab.
// Composer and send controls are inspected; no ChatGPT messages are scraped.
export async function submitToExistingChatGPT(message) {
  const refuse = reason => ({ clicked:false, reason });
  const chatPath = /^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/;
  const initialPath = location.pathname;
  if (location.origin !== "https://chatgpt.com" || !chatPath.test(initialPath))
    return refuse("NOT_EXISTING_CHATGPT_CONVERSATION");
  if (typeof message !== "string" || message.length<1 || message.length>800)
    return refuse("INVALID_MESSAGE");
  if (document.visibilityState === "prerender")return refuse("PAGE_NOT_READY");

  const visible = element => Boolean(element?.getClientRects?.().length) &&
    !element.closest?.('[aria-hidden="true"],[inert]');
  const unique = elements => [...new Set(elements)].filter(visible);
  const generating = () => unique(document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  )).some(button => !button.disabled);
  if (generating())return refuse("CHATGPT_STILL_GENERATING");
  if (document.querySelector('[role="dialog"][aria-modal="true"]'))
    return refuse("CHATGPT_DIALOG_OPEN");

  const sendSelector = [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="메시지 보내기"]'
  ].join(",");
  // ChatGPT can display a voice button in place of the send button until
  // there is typed input. A missing pre-input send button is not an error.
  const initialButtons=unique(document.querySelectorAll(sendSelector));
  const initialForm=initialButtons.length===1 ? initialButtons[0].closest?.("form") : null;
  const scope = initialForm || document;

  // ChatGPT's composer may be a textarea, a ProseMirror contenteditable,
  // or a data-testid wrapper containing the editable child.
  const editorSelector = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'textarea[data-testid*="prompt"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"].ProseMirror',
    '[contenteditable="true"][data-lexical-editor]',
    '[contenteditable="true"][data-placeholder]'
  ].join(",");
  const raw = [...scope.querySelectorAll(editorSelector)];
  // Prefer an exact prompt editor. When ChatGPT has no stable prompt ID,
  // a single visible editor in a single visible form is the only fallback.
  if(initialForm) {
    raw.push(...initialForm.querySelectorAll('textarea,[contenteditable="true"]'));
  }else if(raw.length===0){
    const possibleForms=unique(document.querySelectorAll("form")).filter(form=>
      unique(form.querySelectorAll('textarea,[contenteditable="true"]')).length>0
    );
    if(possibleForms.length===1)
      raw.push(...possibleForms[0].querySelectorAll('textarea,[contenteditable="true"]'));
  }
  const candidates=[];
  for(const candidate of unique(raw)){
    if(candidate.tagName==="TEXTAREA" || candidate.isContentEditable){
      candidates.push(candidate);
    }else{
      // Some versions put the stable prompt ID on a non-editable wrapper.
      candidates.push(...unique(candidate.querySelectorAll?.(
        'textarea,[contenteditable="true"]'
      ) || []).filter(el=>el.tagName==="TEXTAREA"||el.isContentEditable));
    }
  }
  let editors=unique(candidates);
  // If both wrapper and inner contenteditable match, the innermost editor is
  // canonical. Two unrelated visible editors are still ambiguous and refused.
  editors=editors.filter(el=>!editors.some(other=>other!==el && el.contains?.(other)));
  if(editors.length===0)return refuse("COMPOSER_NOT_FOUND");
  if(editors.length!==1)return refuse("COMPOSER_MULTIPLE_VISIBLE");
  const editor=editors[0];

  const read=()=>editor.tagName==="TEXTAREA"?editor.value:editor.textContent;
  if ((read()||"").trim())return refuse("COMPOSER_HAS_UNSENT_TEXT");
  editor.focus();
  let inserted=false;
  if(editor.isContentEditable) {
    try { inserted=document.execCommand("insertText",false,message)===true; }
    catch { /* Never overwrite a draft with a forced DOM mutation. */ }
  } else if(editor.tagName==="TEXTAREA"){
    const setter=Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,"value")?.set;
    if(!setter)return refuse("COMPOSER_UNSUPPORTED");
    setter.call(editor,message);
    editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:message}));
    inserted=true;
  }
  if(!inserted || read()!==message)return refuse("COMPOSER_INSERTION_UNVERIFIED");

  // Do not click a send control if ChatGPT changed the conversation while
  // React reconciled the typed text.
  await new Promise(resolve=>setTimeout(resolve,250));
  if(location.origin!=="https://chatgpt.com" || location.pathname!==initialPath)
    return refuse("CHAT_NAVIGATED_DURING_INSERT");
  if(generating())return refuse("CHATGPT_GENERATING_AFTER_INPUT");
  if(!visible(editor) || read()!==message)
    return refuse("COMPOSER_CHANGED_DURING_INSERT");
  if(document.querySelector('[role="dialog"][aria-modal="true"]'))
    return refuse("CHATGPT_DIALOG_OPEN");
  // Resolve Send AFTER input. With an empty composer some ChatGPT layouts
  // display a microphone in place of the Send button.
  const ownerForm=editor.closest?.("form") || initialForm;
  const currentButtons=unique((ownerForm||document).querySelectorAll(sendSelector));
  if(currentButtons.length!==1 || currentButtons[0].disabled ||
     (initialButtons.length===1 && initialButtons[0]!==currentButtons[0]))
    return refuse("SEND_BUTTON_UNAVAILABLE");
  currentButtons[0].click();
  // A click does not prove acceptance/response. Never auto-retry uncertainty.
  return {clicked:true,reason:"SEND_BUTTON_CLICKED_UNVERIFIED"};
}

// The constant is displayed by the extension's *running* background worker.
// It is not based on the local Git checkout or the cached localhost UI.
export const CHAT_COMPOSER_BUILD = "composer-2026-10-13-r4";

// Read-only on-page diagnosis: never touch or return conversation content,
// user drafts, messages, credentials, the chat URL or the send button.
export function diagnoseExistingChatGPTComposer() {
  const build = "composer-2026-10-13-r4";
  const chatPath = /^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/;
  if(location.origin!=="https://chatgpt.com" || !chatPath.test(location.pathname)) {
    return {build,eligible:false,reason:"NOT_EXISTING_CHATGPT_CONVERSATION"};
  }
  const visible = element => Boolean(element?.getClientRects?.().length) &&
    !element.closest?.('[aria-hidden="true"],[inert]');
  const unique = nodes => [...new Set(nodes)].filter(visible);
  const sendSelector = [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="메시지 보내기"]'
  ].join(",");
  const exactSelector = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'textarea[data-testid*="prompt"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"].ProseMirror',
    '[contenteditable="true"][data-lexical-editor]',
    '[contenteditable="true"][data-placeholder]'
  ].join(",");
  const sendControls = unique(document.querySelectorAll(sendSelector));
  const exact = unique(document.querySelectorAll(exactSelector));
  const forms = unique(document.querySelectorAll("form"))
    .filter(form=>unique(form.querySelectorAll('textarea,[contenteditable="true"]')).length>0);
  const direct = exact.filter(x=>x.isContentEditable||x.tagName==="TEXTAREA");
  const wrappers = exact.filter(x=>!x.isContentEditable&&x.tagName!=="TEXTAREA");
  const wrappedChildren = unique(wrappers.flatMap(el=>[
    ...(el.querySelectorAll?.('textarea,[contenteditable="true"]')||[])
  ]));
  const candidates = unique([...direct,...wrappedChildren]);
  const canonical = candidates.filter(el=>!candidates.some(other=>
    other!==el && el.contains?.(other)
  ));
  return {
    build,eligible:true,
    exactMatches:exact.length,
    editableCandidates:canonical.length,
    inputWrappers:wrappers.length,
    formWithEditors:forms.length,
    sendControls:sendControls.length,
    // A zero send button is valid in microphone-first UI before typing.
    diagnosis:canonical.length===1?"COMPOSER_FOUND":
      canonical.length>1?"COMPOSER_MULTIPLE_VISIBLE":
      forms.length===1?"FORM_SCOPED_FALLBACK":
      "COMPOSER_NOT_FOUND"
  };
}
