const app=document.querySelector('#app');
const $=(tag,attrs={},value)=>{const e=document.createElement(tag);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,v);if(value!==undefined)e.textContent=value;return e;};
const api=async(path='',body)=>{const r=await fetch('/simulator/api'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const route=id=>'/rooms/'+id;
// Browser insertText creates DIV+BR empty lines. innerText counts those twice;
// use logical editor lines like an editor model, preserving every blank line.
function composerText(editor){
  const read=node=>node.nodeType===3?node.data:[...node.childNodes].map((child,i)=>{
    if(child.nodeType===1&&child.tagName==='BR')return node.childNodes.length===1?'':'\n';
    return (i>0&&child.nodeType===1&&['DIV','P'].includes(child.tagName)?'\n':'')+read(child);
  }).join('');
  return read(editor).trim();
}
let roomId=/\/c\/([^/]+)$/.exec(location.pathname)?.[1],revision=-1,view;
const error=e=>{document.querySelector('#sim-error')?.remove();app.append($('p',{id:'sim-error',role:'alert'},e.message));};
function button(label,fn,attrs={}){const b=$('button',{type:'button',...attrs},label);b.addEventListener('click',()=>Promise.resolve().then(fn).catch(error));return b;}
function rename(r){const dialog=$('dialog',{role:'dialog'}),form=$('form'),input=$('input',{type:'text',value:r.title});form.append(input,$('button',{type:'submit'},'저장'));form.addEventListener('submit',async e=>{e.preventDefault();await api(route(r.id)+'/title',{title:input.value});dialog.remove();revision=-1;await update();});dialog.append(form);app.append(dialog);dialog.showModal();}
function turnNode(t,r){
  const busy=t.state!=='complete',answer=r.scenario==='loading-error'&&t===r.turns.at(-1)?'이 응답을 불러오지 못했습니다':t.answer;
  if(r.renderer==='legacy'){
    const root=$('section');root.append($('article',{'data-message-author-role':'user','data-message-id':t.userId},t.user));
    const a=$('article',{'data-message-author-role':'assistant','data-message-id':t.assistantId,'aria-busy':String(busy)},answer);root.append(a);return root;
  }
  const root=$('div',{'data-content-search-turn-key':t.id}),state=$('div',{'data-talvt-turn-state':busy?'streaming':'complete'});
  const user=$('div',{'data-chatgpt-search-unit-key':t.id+':0:user','data-chatgpt-search-message-ids':t.userId},t.user);
  const unit=$('div',{'data-chatgpt-search-unit-key':t.id+':1:assistant','data-chatgpt-search-message-ids':t.assistantId+' '+t.assistantId});
  const selection=$('div',{'data-chatgpt-selection-message-id':t.assistantId}),markdown=$('div',{'data-markdown-text-style':'assistant-message'}),source=$('div',{'data-dil-source-message-id':t.assistantId}),body=$('div',{'data-dil-message-id':t.assistantId});
  if(r.scenario!=='writing')body.append($('p',r.scenario==='loading-error'&&t===r.turns.at(-1)?{role:'status'}:{},busy?answer.slice(0,Math.max(1,Math.floor(answer.length/2))):answer));
  if(r.scenario==='writing'){
    // Observed Oct 21: stable card test-id, editor wrapper and owned textbox.
    // Toolbar nesting/labels are observed; title and copy event are synthetic.
    const card=$('div',{'data-testid':'chatgpt-writing-block'}),toolbar=$('div');
    toolbar.append($('span',{},'글쓰기'),button('복사',()=>navigator.clipboard.writeText(answer),{'aria-label':'복사'}),button('편집기 열기',()=>{}, {'aria-label':'편집기 열기'}));
    const wrapper=$('div',{class:'writing-block-editor'}),editor=$('div',{contenteditable:'true',role:'textbox','aria-label':'작성을 시작하세요'});
    for(const line of answer.split('\n'))editor.append($('p',{},line));
    wrapper.append(editor);card.append(toolbar,wrapper);body.append(card);
  }
  source.append(body);markdown.append(source);selection.append(markdown);unit.append(selection);state.append(user,unit);root.append(state);return root;
}
function renderRoom(r){
  view=r;document.title=r.title;app.replaceChildren();
  const aside=$('aside'),item=$('li',{'data-testid':'history-item'}),link=$('a',{href:location.pathname},r.title);
  const more=button('더보기',()=>{const m=$('div',{role:'menu'});m.append(button('이름 변경',()=>{m.remove();rename(r);},{role:'menuitem'}));app.append(m);},{'aria-label':'더보기','aria-haspopup':'menu'});
  item.append(link,more);aside.append(item);if(r.project)aside.append($('a',{href:'/g/'+r.project+'/project'},'새 채팅'));app.append(aside);
  const main=$('main');app.append(main);
  if(r.scenario==='conversation-error'){main.append($('div',{},'이 ChatGPT 대화를 불러올 수 없습니다'),button('다시 시도',()=>location.reload()));return;}
  const turns=r.reverse?[...r.turns].reverse():r.turns;
  for(const t of turns){main.append(turnNode(t,r));if(r.duplicate)main.append(turnNode(t,r));}
  const form=$('form',{'data-chatgpt-composer':'','data-composer-placement':'thread'}),editor=$('div',{id:'prompt-textarea',contenteditable:'true',role:'textbox','aria-label':'ChatGPT에게 물어보세요'});
  editor.textContent=r.draft??'';if(!editor.textContent)editor.append($('p',{},''));
  const busy=r.turns.length>0&&r.turns.at(-1).state!=='complete';
  const send=button('Send',async()=>{
    const message=composerText(editor);if(!message)return;
    await api(route(r.id)+'/messages',{message,requestId:crypto.randomUUID()});revision=-1;await update();
  },{'data-testid':'send-button'});send.disabled=busy;
  editor.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send.click();}});
  form.addEventListener('submit',e=>{e.preventDefault();send.click();});form.append(editor,send);
  if(busy)form.append(button('Stop',async()=>{await api(route(r.id)+'/stop',{});revision=-1;await update();},{'data-testid':'stop-button','aria-label':'Stop generating'}));
  main.append(form);
  const banner={disconnect:'연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.',length:'이 대화의 최대 길이에 도달했습니다',quota:'Usage limit reached'}[r.scenario];
  if(banner)main.append($('div',{role:'alert'},banner));
  if(r.scenario==='ambiguous')main.append($('div',{contenteditable:'true',role:'textbox'},'Synthetic conflicting editor'));
}
async function update(){const r=await api(route(roomId));if(r.revision!==revision){revision=r.revision;renderRoom(r);}}
async function home(){
  const project=/^\/g\/(g-p-[^/]+)\/project$/.exec(location.pathname)?.[1];
  if(project){
    app.replaceChildren();const main=$('main'),form=$('form',{'data-chatgpt-composer':'','data-composer-placement':'thread'}),editor=$('div',{id:'prompt-textarea',contenteditable:'true',role:'textbox'});
    const send=button('Send',async()=>{
      const message=composerText(editor);if(!message)return;
      const r=await api('/rooms',{project,empty:true,renderer:(await api()).projectRenderers?.[project]??'current',title:'Simulator new chat'});
      await api(route(r.id)+'/messages',{message,requestId:crypto.randomUUID()});
      roomId=r.id;history.replaceState(null,'',r.url);revision=-1;await update();setInterval(()=>update().catch(error),200);
    },{'data-testid':'send-button'});
    editor.append($('br'));form.append(editor,send);form.addEventListener('submit',e=>{e.preventDefault();send.click();});main.append(form);app.append(main);return;
  }
  const state=await api();app.replaceChildren();const main=$('main');app.append(main);
  main.append($('h1',{},'Scenario control'),$('p',{},'All content is synthetic. Production Autopilot data is never imported.'));
  const form=$('form'),id=$('input',{name:'id',placeholder:'room-id',required:''}),scenario=$('select',{name:'scenario'});
  for(const name of state.scenarios)scenario.append($('option',{value:name},name));
  form.append(id,scenario,$('button',{type:'submit'},'Create room'));form.addEventListener('submit',async e=>{e.preventDefault();const r=await api('/rooms',{id:id.value,scenario:scenario.value,project:/\/g\/([^/]+)\/project/.exec(location.pathname)?.[1]??null});location.href=r.url;});main.append(form);
  for(const r of state.rooms){const row=$('section');row.append($('a',{href:r.project?'/g/'+r.project+'/c/'+r.id:'/c/'+r.id},r.title+' · '+r.id));
    const s=$('select');for(const name of state.scenarios){const o=$('option',{value:name},name);o.selected=name===r.scenario;s.append(o);}row.append(s,button('Apply',async()=>{await api(route(r.id)+'/scenario',{scenario:s.value});await home();}),$('span',{},' sends='+r.messages.length+' reloads='+r.reloads));main.append(row);}
}
if(roomId){await update();setInterval(()=>update().catch(error),200);}else await home();
