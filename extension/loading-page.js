export const LOADING_WORKER_BUILD="loading-reload-1";

// Negative page evidence only. This never certifies an assistant response and
// never reads an editable value. Serialized separately from the normal reader.
export async function inspectLoadingPage(request={}){
  if(request.permitted!==true||location.origin!=="https://chatgpt.com"||location.pathname!==request.expectedPath||
    !/^\/(?:c\/[^/]+|g\/g-p-[^/]+\/c\/[^/]+)\/?$/.test(location.pathname)||
    !/^[a-f0-9]{64}$/.test(request.bindingFingerprint||""))return null;
  try{
    const visible=e=>!!e?.getClientRects?.().length&&!e.closest('[hidden],[inert],[aria-hidden="true"]');
    const nodes=s=>[...document.querySelectorAll(s)].filter(visible);
    const editors=nodes('textarea,[contenteditable="true"]');
    if(editors.length!==1||nodes('[role="dialog"][aria-modal="true"],button[data-testid="stop-button"],button[aria-label="Stop"],button[aria-label="Stop generating"]').length)return null;
    const editor=editors[0];let visited=0;
    const textPresent=n=>++visited>200||(n.nodeType===3?n.length>0:[...(n.childNodes||[])].some(textPresent));
    if(editor.tagName==="TEXTAREA"?!editor.matches(':placeholder-shown'):textPresent(editor))return null;
    if(nodes('[role="alert"]').some(e=>!e.closest('[data-content-search-turn-key],[data-message-author-role],article,pre,code,blockquote,q')))return null;
    let user,reply,complete=false;
    const turns=nodes('[data-content-search-turn-key]').filter(e=>e.closest('main')&&!e.closest('pre,code,blockquote,q'));
    if(turns.length){
      const turn=turns.at(-1),key=turn.getAttribute('data-content-search-turn-key');
      const states=[...turn.querySelectorAll('[data-talvt-turn-state]')].filter(visible);
      const units=nodes('[data-chatgpt-search-unit-key]').filter(e=>e.closest('[data-content-search-turn-key]')===turn&&!e.closest('pre,code,blockquote,q'));
      reply=units.at(-1);user=units.at(-2);
      const owns=editor.closest('form[data-chatgpt-composer][data-composer-placement="thread"]');
      complete=!!owns&&states.length===1&&states[0].getAttribute('data-talvt-turn-state')==='complete'&&states[0].contains(reply)&&
        reply?.getAttribute('data-chatgpt-search-unit-key')?.startsWith(key+':')&&/:\d+:assistant$/.test(reply?.getAttribute('data-chatgpt-search-unit-key')||'')&&
        user?.getAttribute('data-chatgpt-search-unit-key')?.startsWith(key+':')&&/:\d+:user$/.test(user?.getAttribute('data-chatgpt-search-unit-key')||'');
    }else{
      const units=nodes('[data-message-author-role]');reply=units.at(-1);user=units.at(-2);
      complete=reply?.getAttribute('data-message-author-role')==='assistant'&&user?.getAttribute('data-message-author-role')==='user'&&
        reply.getAttribute('aria-busy')!=='true'&&reply.getAttribute('data-is-streaming')!=='true'&&
        nodes('button[data-testid="send-button"],button[data-testid="composer-send-button"]').some(e=>e.closest('form')?.contains(editor));
    }
    if(!complete||reply.closest('pre,code,blockquote,q')||reply.getAttribute('aria-busy')==='true'||reply.getAttribute('data-is-streaming')==='true')return null;
    const ids=[...new Set((user.getAttribute('data-chatgpt-search-message-ids')||user.getAttribute('data-message-id')||'').split(/\s+/).filter(Boolean))];
    if(ids.length!==1||!/^[a-zA-Z0-9-]{1,100}$/.test(ids[0]))return null;
    const statuses=[...reply.querySelectorAll('[role="status"]')].filter(e=>visible(e)&&!e.closest('pre,code,blockquote,q'));
    const texts=statuses.map(e=>e.innerText?.trim()).filter(Boolean);
    const failed=texts.some(t=>/^(?:이 응답을 불러오지 못했습니다|(?:unable|failed) to load (?:this|the) response)[.!]?$/.test(t));
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.bindingFingerprint+'\0loading-user\0'+ids[0]));
    return {bindingFingerprint:request.bindingFingerprint,userFingerprint:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join(''),safe:true,failed};
  }catch{return null;}
}
