// This function runs in the registered ChatGPT tab's isolated world via
// chrome.scripting.executeScript. No conversation output or DOM transcript is read.
export async function submitToExistingChatGPT(message) {
  const refuse = reason => ({ clicked:false, reason });
  if (location.origin !== "https://chatgpt.com" ||
      !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname)) {
    return refuse("NOT_EXISTING_CHATGPT_CONVERSATION");
  }
  if (typeof message !== "string" || message.length<1 || message.length>800)
    return refuse("INVALID_MESSAGE");
  if (document.visibilityState === "prerender")return refuse("PAGE_NOT_READY");
  const stop = document.querySelector(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  );
  if (stop && !stop.disabled && stop.getClientRects().length)
    return refuse("CHATGPT_STILL_GENERATING");

  const nodes = [
    ...document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"]')
  ].filter((el,i,arr)=>arr.indexOf(el)===i &&
    el.getClientRects().length && (el.isContentEditable||el.tagName==="TEXTAREA"));
  if (nodes.length!==1)return refuse("COMPOSER_NOT_UNAMBIGUOUS");
  const editor=nodes[0];
  const existing=editor.tagName==="TEXTAREA" ? editor.value : editor.textContent;
  if ((existing||"").trim())return refuse("COMPOSER_HAS_UNSENT_TEXT");
  if (document.querySelector('[role="dialog"][aria-modal="true"]'))
    return refuse("CHATGPT_DIALOG_OPEN");

  editor.focus();
  let inserted=false;
  if(editor.isContentEditable) {
    try { inserted=document.execCommand("insertText",false,message)===true; }
    catch { /* Input will be rejected rather than forcefully replacing the editor. */ }
  } else if(editor.tagName==="TEXTAREA"){
    const setter=Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,"value")?.set;
    if(!setter)return refuse("COMPOSER_UNSUPPORTED");
    setter.call(editor,message);
    editor.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:message}));
    inserted=true;
  }
  const text=editor.tagName==="TEXTAREA"?editor.value:editor.textContent;
  if(!inserted || text!==message)return refuse("COMPOSER_INSERTION_UNVERIFIED");

  // Wait for React to reconcile enabled send button after input event.
  await new Promise(resolve=>setTimeout(resolve,250));
  if(location.origin!=="https://chatgpt.com" ||
     !/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(location.pathname))
    return refuse("CHAT_NAVIGATED_DURING_INSERT");
  if(document.querySelector(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]'
  ))return refuse("CHATGPT_GENERATING_AFTER_INPUT");

  const buttons=[...document.querySelectorAll(
    'button[data-testid="send-button"],button[aria-label="Send message"],button[aria-label="메시지 보내기"]'
  )].filter((el,i,arr)=>arr.indexOf(el)===i && el.getClientRects().length);
  if(buttons.length!==1||buttons[0].disabled)return refuse("SEND_BUTTON_UNAVAILABLE");
  buttons[0].click();
  // A click is not a guarantee that the provider accepted or answered.
  // Do not scrape ChatGPT messages or retry if there is uncertainty.
  return {clicked:true,reason:"SEND_BUTTON_CLICKED_UNVERIFIED"};
}
