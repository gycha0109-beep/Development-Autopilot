// Reused legacy and modern synthetic DOM contracts; not live ChatGPT captures.
export function fixtureHtml(pathname,unavailable=false) {
  const slug = pathname.split("/").at(-1);
  if(slug==="e2e-created"&&unavailable==="recovery")return `<!doctype html><html><body><main>
    <div id="turns"><article data-message-author-role="user" data-message-id="recovery-user-initial">Owned recovery case</article>
    <article data-message-author-role="assistant" data-message-id="recovery-initial">초기 테스트 응답입니다.</article></div>
    <form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>
    <button type="button" data-testid="send-button">Send</button></form>
    <script>
      window.__recovery={stops:0,messages:[]};
      window.__disconnect=()=>{
        const alert=document.createElement('div');alert.setAttribute('role','alert');alert.id='disconnect-alert';
        alert.textContent='연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.';document.querySelector('main').append(alert);
        const stop=document.createElement('button');stop.type='button';stop.dataset.testid='stop-button';stop.textContent='Stop';
        document.querySelector('form').append(stop);
        document.querySelector('#turns article:last-child').setAttribute('aria-busy','true');
        stop.addEventListener('click',()=>{window.__recovery.stops++;stop.remove();alert.remove();
          document.querySelector('#turns article:last-child').setAttribute('aria-busy','false');});
      };
      document.querySelector('[data-testid="send-button"]').addEventListener('click',()=>{
        const editor=document.querySelector('#prompt-textarea'),message=editor.innerText.trim();
        const n=window.__recovery.messages.push(message);
        const user=document.createElement('article');user.dataset.messageAuthorRole='user';user.dataset.messageId='recovery-user-'+n;
        user.textContent=message;document.querySelector('#turns').append(user);
        const reply=document.createElement('article');reply.dataset.messageAuthorRole='assistant';reply.dataset.messageId='recovery-reply-'+n;
        reply.textContent=n===1?'지금까지 진행한 작업과 남은 작업을 보고합니다.':'복구 후 진행 응답 완료.';
        document.querySelector('#turns').append(reply);editor.innerHTML='';
      });
    </script></main></body></html>`;
  if(slug==="e2e-created"&&unavailable==="conversation")return `<!doctype html><html><body>
    <aside>PRIVATE_SIDEBAR</aside><main><header aria-hidden="true"><button>PRIVATE_HIDDEN_HEADER</button></header>
    <div><div>이 ChatGPT 대화를 불러올 수 없습니다</div></div><button type="button">다시 시도</button>
    </main></body></html>`;
  if(slug==="e2e-created")return `<!doctype html><html><head><title>E2E current renderer</title></head><body><main>
    <div data-content-search-turn-key="turn-current"><div data-talvt-turn-state="complete">
      <div data-chatgpt-search-unit-key="turn-current:0:user" data-chatgpt-search-message-ids="${unavailable==='loading-failure'?'loading-failure-user':'user-current'}">Owned fixture request</div>
      <div data-chatgpt-search-unit-key="turn-current:2:assistant" data-chatgpt-search-message-ids="reply-current reply-current">
        <div data-chatgpt-selection-message-id="reply-current"><div data-markdown-text-style="assistant-message">
          <div data-dil-source-message-id="reply-current"><div data-dil-message-id="reply-current"><p>${unavailable==="human"?"로컬 Windows 테스트가 필요합니다.":unavailable&&unavailable!=='loading-normal'?'<span role="status">이 응답을 불러오지 못했습니다</span>':"PRIVATE_CURRENT_FIXTURE_RESPONSE"}</p></div></div>
        </div></div>
      </div>
    </div></div>
    <form data-chatgpt-composer data-composer-placement="thread"><div contenteditable="true" role="textbox" aria-label="ChatGPT에게 물어보세요"><p><br></p></div><button type="button" data-testid="send-button">Send</button></form>
    <script>
      window.__loadingMessages=[];
      document.querySelector('[data-testid="send-button"]').addEventListener('click',()=>{
        const editor=document.querySelector('[contenteditable]'),message=editor.innerText.trim();
        window.__loadingMessages.push(message);editor.innerHTML='';
        const turn=document.createElement('div');turn.setAttribute('data-content-search-turn-key','loading-next');
        turn.innerHTML='<div data-talvt-turn-state="streaming"><div data-chatgpt-search-unit-key="loading-next:0:user" data-chatgpt-search-message-ids="loading-next-user"></div><div data-chatgpt-search-unit-key="loading-next:1:assistant" data-chatgpt-search-message-ids="loading-next-reply loading-next-reply"><div data-chatgpt-selection-message-id="loading-next-reply"><div data-markdown-text-style="assistant-message"><div data-dil-source-message-id="loading-next-reply"><div data-dil-message-id="loading-next-reply">복구 후 다음 응답 완료.</div></div></div></div></div></div>';
        turn.querySelector('[data-chatgpt-search-message-ids="loading-next-user"]').textContent=message;
        document.querySelector('main').insertBefore(turn,document.querySelector('form'));
        const stop=document.createElement('button');stop.dataset.testid='stop-button';document.querySelector('form').append(stop);
        setTimeout(()=>{stop.remove();turn.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state','complete');},1500);
      });
    </script>
  </main></body></html>`;
  const scenario = slug.startsWith("e2e-") ? slug.slice(4) : "normal";
  const label = slug === "e2e-send" ? "sender" : scenario;
  const alert = scenario === "disconnect"
    ? "<div role=\"alert\">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div>"
    : scenario === "length"
      ? "<div role=\"alert\">이 대화의 최대 길이에 도달했으나,새 채팅을 시작해 계속 이야기할 수 있습니다.</div>"
      : scenario === "quota"
        ? "<div role=\"alert\">Usage limit reached</div>" : "";
  const assistant = scenario === "ci" ? "CI가 장기 실행중이므로 대기중입니다."
    : scenario === "approval" ? "로컬 Windows 테스트가 필요합니다."
      : `안전한 E2E 응답 ${label}`;
  const draft = scenario === "draft" ? "PRIVATE_E2E_DRAFT" : "";
  const stop = scenario === "generating" ? "<button data-testid=\"stop-button\">Stop</button>" : "";
  const sender = slug === "e2e-send" ? `
    <script>
      window.__sendCount = 0;
      document.querySelector("#send").addEventListener("click", event => {
        event.preventDefault(); window.__sendCount++;
        const stop = document.createElement("button"); stop.dataset.testid = "stop-button";
        stop.textContent = "Stop"; document.querySelector("form").append(stop);
        document.querySelector("[data-message-author-role=assistant]").setAttribute("aria-busy", "true");
      });
    </script>` : "";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>E2E ${label}</title></head>
    <body><main><article data-message-author-role="assistant" data-message-id="reply-${label}">${assistant}</article>
    <form><div id="prompt-textarea" contenteditable="true" role="textbox" data-placeholder="메시지">${draft}</div>
    <button id="send" data-testid="send-button" type="button">Send</button>${stop}</form>${alert}</main>${sender}</body></html>`;
}

