// Executed only inside an explicitly registered ChatGPT tab.
// Composer and send controls are inspected; no ChatGPT messages are scraped.
export async function submitToExistingChatGPT(message, mode="continuation") {
  const refuse = reason => ({ clicked:false, reason });
  // Self-contained: chrome.scripting serializes this function into the page.
  // Do not use an imported helper here. Only registered, exact ChatGPT routes
  // are eligible; root and project landing create ONE new conversation.
  const initialPath = location.pathname;
  const pageType =
    /^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(initialPath) ? "existing" :
    initialPath === "/" ? "new" :
    /^\/g\/g-p-[^/]+(?:\/project)?\/?$/.test(initialPath) ? "project-new" : null;
  if (location.origin !== "https://chatgpt.com" || !pageType)
    return refuse("UNSUPPORTED_CHATGPT_PAGE");
  const max=mode==="handoff" && pageType==="project-new" ? 30000 : 800;
  if (typeof message !== "string" || message.length<1 || message.length>max)
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
    'button[data-testid="composer-submit-button"]',
    'button[data-testid="send-message-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send"]',
    'button[aria-label="보내기"]',
    'button[aria-label="메시지 보내기"]',
    'button[title="Send message"]',
    'button[title="Send"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="전송"]',
    'button[title="전송"]',
    'button[data-testid*="send-button"]',
    'button[data-testid*="submit-button"]'
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
  const innermost=nodes=>unique(nodes).filter(el=>!nodes.some(
    other=>other!==el && el.contains?.(other)));
  let editors=innermost(candidates);
  // The current ChatGPT renderer may mount an additional visible editable
  // (inline document, search, or non-composer widget). Do not treat that as a
  // second ChatGPT composer when the real composer is independently proven.
  // Proof priority: unique editor owned by the send button's form, then a
  // unique exact prompt editor, then one unique eligible composer form.
  const activeEditor=el=>el.tagName==="TEXTAREA"||el.isContentEditable;
  const ownedBy=(form,el)=>!!form?.contains?.(el);
  const exactSelector=[
    '#prompt-textarea','[data-testid="prompt-textarea"]',
    'textarea[data-testid*="prompt"]'
  ].join(",");
  const exactRoots=unique(document.querySelectorAll(exactSelector));
  const exactChildren=exactRoots.flatMap(el=>activeEditor(el)?[el]:
    unique(el.querySelectorAll?.('textarea,[contenteditable="true"]')||[])
      .filter(activeEditor));
  const exactEditors=innermost(exactChildren);
  const composerForms=unique(document.querySelectorAll("form")).filter(form=>{
    if(form.getAttribute?.("action"))return false;
    return innermost(form.querySelectorAll?.(
      'textarea,[contenteditable="true"]')||[]).filter(activeEditor).length===1;
  });
  const formEditors=form=>innermost(form?.querySelectorAll?.(
    'textarea,[contenteditable="true"]')||[]).filter(activeEditor);
  let editor=null;
  if(initialForm){
    const owned=formEditors(initialForm);
    if(owned.length===1)editor=owned[0];
  }
  if(!editor && exactEditors.length===1){
    const strong=exactEditors[0];
    // A globally identified prompt is authoritative unless a different
    // uniquely send-owned form contradicts it. Fail closed on that conflict.
    if(initialForm && !ownedBy(initialForm,strong))
      return refuse("COMPOSER_PROMPT_FORM_CONFLICT");
    editor=strong;
  }
  if(!editor && composerForms.length===1){
    const formEditor=formEditors(composerForms[0]);
    if(formEditor.length===1 &&
       (exactEditors.length===0 ||
         exactEditors.some(el=>el===formEditor[0])))
      editor=formEditor[0];
  }
  if(!editor && editors.length===1)editor=editors[0];
  if(!editor && editors.length===0)return refuse("COMPOSER_NOT_FOUND");
  if(!editor)return refuse("COMPOSER_MULTIPLE_VISIBLE");
  if(!activeEditor(editor) || !visible(editor))
    return refuse("COMPOSER_NOT_FOUND");

  const read=()=>editor.tagName==="TEXTAREA"?editor.value:
    (typeof editor.innerText==="string"?editor.innerText:editor.textContent);
  // Multiline contenteditable/ProseMirror normalizes line boundaries into
  // paragraphs or hard breaks. Compare logical text rather than DOM markup.
  // Never remove words, punctuation or reorder content while comparing.
  const normalized=value=>String(value||"")
    .replace(/[\u200B-\u200D\uFEFF]/g,"")
    .replace(/\r\n?/g,"\n").replace(/\u00a0/g," ")
    .replace(/\s+/g," ").trim();
  const matches=()=>normalized(read())===normalized(message) ||
    (editor.tagName!=="TEXTAREA" &&
     normalized(editor.textContent)===normalized(message));
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
  if(!inserted || !matches())return refuse("COMPOSER_INSERTION_UNVERIFIED");

  // ChatGPT may re-render its submit controls after React accepts the edit.
  // Resolve after insertion, never require the pre-input button to remain.
  const ownerForm=editor.closest?.("form") || initialForm;
  // Some ChatGPT builds render the yellow Send control in a portal or in a
  // sibling of the editor form. Search the whole page for *named send controls*
  // but accept only a unique button. Generic submit buttons remain scoped to
  // the verified editor-owned form.
  const findButtons=()=>{
    const named=unique(document.querySelectorAll(sendSelector));
    const formSubmits=ownerForm?unique(ownerForm.querySelectorAll('button[type="submit"]')):[];
    const merged=unique([...named,...formSubmits]);
    if(!ownerForm)return merged;
    const inside=merged.filter(button=>ownerForm.contains?.(button));
    return inside.length?inside:merged;
  };
  let unavailable="SEND_BUTTON_NOT_FOUND";
  for(let check=0;check<20;check++){
    await new Promise(resolve=>setTimeout(resolve,200));
    if(location.origin!=="https://chatgpt.com" || location.pathname!==initialPath)
      return refuse("CHAT_NAVIGATED_DURING_INSERT");
    if(generating())return refuse("CHATGPT_GENERATING_AFTER_INPUT");
    if(!visible(editor)||!matches())return refuse("COMPOSER_CHANGED_DURING_INSERT");
    if(document.querySelector('[role="dialog"][aria-modal="true"]'))
      return refuse("CHATGPT_DIALOG_OPEN");
    const currentButtons=findButtons();
    if(currentButtons.length>1)return refuse("SEND_BUTTON_MULTIPLE_VISIBLE");
    if(currentButtons.length===1){
      if(currentButtons[0].disabled ||
         currentButtons[0].getAttribute?.("aria-disabled")==="true"){
        unavailable="SEND_BUTTON_DISABLED";
        continue;
      }
      // A single enabled named Send control belongs to this one verified
      // editor; click exactly once. Never retry after an uncertain click.
      currentButtons[0].click();
      return {clicked:true,reason:"SEND_BUTTON_CLICKED_UNVERIFIED"};
    }
  }

  // A single verified ChatGPT composer form can implement React onSubmit even
  // when the page has no recognizable send button. Native requestSubmit()
  // dispatches its standard submit event; it does not synthesize Enter text.
  // Do not submit generic, ambiguous, action-targeting or foreign forms.
  if(ownerForm && typeof ownerForm.requestSubmit==="function" &&
     ownerForm.contains?.(editor) &&
     (ownerForm.getAttribute?.("action")==null || ownerForm.getAttribute?.("action")==="") &&
     unique(ownerForm.querySelectorAll('textarea,[contenteditable="true"]'))
       .filter(el=>el.tagName==="TEXTAREA"||el.isContentEditable).length===1 &&
     matches() && !generating() &&
     location.origin==="https://chatgpt.com" && location.pathname===initialPath){
    ownerForm.requestSubmit();
    return {clicked:true,reason:"CHAT_FORM_SUBMIT_REQUESTED_UNVERIFIED"};
  }
  return refuse(unavailable);
}

// The constant is displayed by the extension's *running* background worker.
// It is not based on the local Git checkout or the cached localhost UI.
export const CHAT_COMPOSER_BUILD = "composer-2026-10-15-r16";

// Read-only on-page diagnosis: never touch or return conversation content,
// user drafts, messages, credentials, the chat URL or the send button.
export function diagnoseExistingChatGPTComposer() {
  const build = "composer-2026-10-15-r16";
  const path=location.pathname;
  const pageType=
    /^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(path) ? "existing" :
    path==="/" ? "new" :
    /^\/g\/g-p-[^/]+(?:\/project)?\/?$/.test(path) ? "project-new" : null;
  if(location.origin!=="https://chatgpt.com" || !pageType) {
    return {build,eligible:false,reason:"UNSUPPORTED_CHATGPT_PAGE"};
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
  const formSubmits = forms.length===1
    ? unique(forms[0].querySelectorAll('button[type="submit"]')):[];
  const direct = exact.filter(x=>x.isContentEditable||x.tagName==="TEXTAREA");
  const wrappers = exact.filter(x=>!x.isContentEditable&&x.tagName!=="TEXTAREA");
  const wrappedChildren = unique(wrappers.flatMap(el=>[
    ...(el.querySelectorAll?.('textarea,[contenteditable="true"]')||[])
  ]));
  const canonicalize=nodes=>unique(nodes).filter(el=>!nodes.some(other=>
    other!==el && el.contains?.(other)
  ));
  const canonical = canonicalize([...direct,...wrappedChildren]);
  const ownedEditor=form=>canonicalize(form?.querySelectorAll?.(
    'textarea,[contenteditable="true"]')||[]).filter(x=>
      x.isContentEditable||x.tagName==="TEXTAREA");
  const promptRoots=unique(document.querySelectorAll([
    '#prompt-textarea','[data-testid="prompt-textarea"]',
    'textarea[data-testid*="prompt"]'
  ].join(",")));
  const promptEditors=canonicalize(promptRoots.flatMap(el=>
    el.isContentEditable||el.tagName==="TEXTAREA"?[el]:
    [...(el.querySelectorAll?.('textarea,[contenteditable="true"]')||[])]
  ));
  const sendOwned=sendControls.length===1?sendControls[0].closest?.("form"):null;
  const sendOwnedEditors=ownedEditor(sendOwned);
  const singleFormEditor=forms.length===1?ownedEditor(forms[0]):[];
  // Structure only: enumerate every *visible* editable, not just those the
  // composer selectors happened to match. This distinguishes a document
  // editor from the actual message box without ever reading either's value.
  const rawVisibleEditables=unique(document.querySelectorAll(
    'textarea,[contenteditable="true"]'
  ));
  // Inventory must include even nested visible contenteditables; dropping
  // ancestors here would hide precisely the duplicate root we are measuring.
  const allVisibleEditables=rawVisibleEditables;
  const canonicalEditables=canonicalize(rawVisibleEditables);
  const main=document.querySelector?.("main");
  const safeAttr=(node,name)=>node?.getAttribute?.(name)||"";
  const exactPromptRoot=el=>promptRoots.some(root=>
    root===el||root.contains?.(el));
  const verticalZone=el=>{
    const rect=el.getBoundingClientRect?.();
    if(!rect||typeof window==="undefined"||!window.innerHeight)
      return "unknown";
    const mid=(rect.top+rect.bottom)/2/window.innerHeight;
    return mid<0.33?"top":mid<0.67?"middle":"bottom";
  };
  const editorRoles=allVisibleEditables.slice(0,12).map((el,i)=>{
    const form=el.closest?.("form");
    const msg=el.closest?.('[data-message-author-role],article[data-turn]');
    return {
      index:i+1,
      tag:el.tagName==="TEXTAREA"?"textarea":
        el.tagName==="DIV"?"div":"other",
      promptId:safeAttr(el,"id")==="prompt-textarea",
      promptTestId:safeAttr(el,"data-testid")==="prompt-textarea",
      inExplicitPrompt:!!exactPromptRoot(el),
      roleTextbox:safeAttr(el,"role")==="textbox",
      proseMirror:!!el.classList?.contains?.("ProseMirror"),
      lexicalEditor:!!el.hasAttribute?.("data-lexical-editor"),
      formPresent:!!form,
      formContainsSend:!!(form&&sendControls.some(btn=>
        form.contains?.(btn))),
      inSendOwnedForm:!!(sendOwned&&sendOwned.contains?.(el)),
      inMain:!!main?.contains?.(el),
      inMessageTurn:!!msg,
      insideDialog:!!el.closest?.('[role="dialog"],[aria-modal="true"]'),
      insideArtifact:!!el.closest?.(
        '[data-testid*="artifact"],[data-testid*="writing"]'),
      verticalZone:verticalZone(el),
      nestedEditable:!!el.parentElement?.closest?.('[contenteditable="true"]')
    };
  });
  let selectionProof=null;
  if(sendOwnedEditors.length===1)
    selectionProof="SEND_FORM_UNIQUE_EDITOR";
  else if(promptEditors.length===1 &&
    (!sendOwned || sendOwned.contains?.(promptEditors[0])))
    selectionProof="EXACT_PROMPT_EDITOR";
  else if(singleFormEditor.length===1 &&
    (promptEditors.length===0 || promptEditors.includes(singleFormEditor[0])))
    selectionProof="UNIQUE_COMPOSER_FORM";
  else if(canonical.length===1)
    selectionProof="SINGLE_VISIBLE_EDITOR";
  return {
    build,eligible:true,pageType,
    exactMatches:exact.length,
    editableCandidates:canonical.length,
    explicitPromptEditors:promptEditors.length,
    sendOwnedEditors:sendOwnedEditors.length,
    singleFormEditors:singleFormEditor.length,
    selectedComposerProof:selectionProof,
    visibleEditableCount:allVisibleEditables.length,
    canonicalEditableCount:canonicalEditables.length,
    editableInventoryTruncated:allVisibleEditables.length>12,
    editableInventory:editorRoles,
    inputWrappers:wrappers.length,
    formWithEditors:forms.length,
    formSubmitControls:formSubmits.length,
    formSubmitSupported:forms.length===1 &&
      typeof forms[0].requestSubmit==="function",
    sendControls:sendControls.length,
    sendDisabled:sendControls.filter(b=>b.disabled).length,
    // Only structure and counts, not drafts or message body.
    diagnosis:selectionProof?"COMPOSER_FOUND":
      canonical.length>1?"COMPOSER_MULTIPLE_VISIBLE":"COMPOSER_NOT_FOUND"
  };
}
