import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../extension/popup-simple.js",import.meta.url),"utf8");

async function render({registeredUrl,currentUrl,reason="MIGRATION_IN_PROGRESS",enabled=true,extraTabs=[],noConfiguration=false}){
  const elements=new Map(),calls=[];
  function element(id){
    if(!elements.has(id)){
      const listeners={};
      const node={
        id,value:"",textContent:"",disabled:false,options:[],listeners,
        classList:{contains:()=>false,add(){},remove(){},toggle(){}},
        addEventListener(name,callback){listeners[name]=callback;},
        replaceChildren(){this.options=[];this.value="";},
        append(item){this.options.push(item);if(this.options.length===1)this.value=item.value;},
        querySelectorAll(selector){
          const collect=items=>items.flatMap(item=>[item,...collect(item.children||[])]);
          return collect(this.options).filter(item=>
            selector==='input[type="checkbox"]'?item.type==="checkbox":
            selector==='input[type="checkbox"]:checked'?item.type==="checkbox"&&item.checked:false);
        },
        get selectedOptions(){return this.options.filter(o=>o.value===this.value);}
      };
      elements.set(id,node);
    }
    return elements.get(id);
  }
  const dom={
    getElementById:element,
    createElement:()=>({
      value:"",textContent:"",type:"",checked:false,disabled:false,children:[],
      listeners:{},
      addEventListener(name,callback){this.listeners[name]=callback;},
      append(...items){this.children.push(...items);},
      replaceChildren(){this.children=[];}
    }),
    activeElement:null
  };
  const sessionKey="payment-session";
  const currentTab={id:17,url:currentUrl,active:true,title:"결제 1"};
  const backend={
    AP_POPUP_SNAPSHOT:{tabs:[currentTab,...extraTabs],
      repositories:["owner/repo","owner/Saju"],
      repositoryDirectory:{repositories:[{name:"owner/repo"},{name:"owner/Saju"}]},
      registry:{sessions:[{key:sessionKey,tabId:17,url:registeredUrl}]},
      connected:true,error:"",sessions:noConfiguration?[]:[{
        sessionKey,enabled,status:reason==="MIGRATION_IN_PROGRESS"?"migrating":enabled?"waiting":"paused",
        reason,mode:"auto",preferredMacroKey:"general",repository:"owner/repo",
        intervalMinutes:5,ci:{status:"observed",ciState:"FAILURE"}
      }],globalStopped:false},
    AP_GET:{registry:{sessions:[{key:sessionKey,tabId:17,url:registeredUrl}]}},
    AP_POPUP_MACRO:{sessions:[],globalStopped:false}
  };
  const chrome={
    runtime:{
      async sendMessage({type,action,payload,tabId}){
        calls.push({type,action,payload,tabId});
        if(type==="AP_POPUP_MACRO"&&action!=="state")
          return {ok:true,data:{accepted:true}};
        return {ok:true,data:backend[type]};
      },
      async openOptionsPage(){}
    }
  };
  const ctx={document:dom,chrome,console,window:{close(){}},confirm:()=>true,
    setTimeout,clearTimeout};
  vm.runInNewContext(source,ctx,{filename:"popup-simple.js"});
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  return {el:element,calls};
}

test("changed ChatGPT URL blocks duplicate start and one-shot, preserves safe stop",async()=>{
  const ui=await render({
    registeredUrl:"https://chatgpt.com/g/g-p-demo/c/original",
    currentUrl:"https://chatgpt.com/g/g-p-demo/c/changed"
  });
  assert.equal(ui.el("start").disabled,true);
  assert.equal(ui.el("once").disabled,true);
  assert.equal(ui.el("stop").disabled,false);
  assert.match(ui.el("status").textContent,/\uC8FC\uC18C/);
  await ui.el("start").listeners.click();
  await ui.el("once").listeners.click();
  assert.equal(ui.calls.filter(x=>x.type==="AP_POPUP_ENROLL").length,0);
  assert.equal(ui.calls.filter(x=>x.type==="AP_POPUP_MACRO"&&x.action==="send").length,0);
  await ui.el("stop").listeners.click();
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  const stopped=ui.calls.find(x=>x.type==="AP_POPUP_MACRO"&&x.action==="stop");
  assert.equal(stopped.payload.sessionKey,"payment-session");
});

test("verified matching chat uses its registered identity and does not re-enroll",async()=>{
  const url="https://chatgpt.com/g/g-p-demo/c/original";
  const ui=await render({registeredUrl:url,currentUrl:url,reason:"WAIT_VERIFIED_CI"});
  assert.equal(ui.el("start").disabled,false);
  assert.equal(ui.el("once").disabled,false);
  assert.equal(ui.el("stop").disabled,false);
  ui.el("macro").value="roadmap";
  await ui.el("start").listeners.click();
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.calls.filter(x=>x.type==="AP_POPUP_ENROLL").length,0);
  const configure=ui.calls.find(x=>x.type==="AP_POPUP_MACRO"&&x.action==="configure");
  assert.equal(configure.payload.sessionKey,"payment-session");
  assert.equal(configure.payload.preferredMacroKey,"roadmap");
});

test("popup saves primary repository, main branch and additional CI observers",async()=>{
  const url="https://chatgpt.com/g/g-p-demo/c/original";
  const ui=await render({registeredUrl:url,currentUrl:url,reason:"WAIT_VERIFIED_CI"});
  assert.equal(ui.el("repository").value,"owner/repo");
  assert.equal(ui.el("ci-branch").value,"main");
  const additional=ui.el("additional-repositories")
    .querySelectorAll('input[type="checkbox"]');
  const saju=additional.find(input=>input.value==="owner/Saju");
  assert.equal(saju.disabled,false);
  saju.checked=true;
  await ui.el("start").listeners.click();
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  const saved=ui.calls.find(x=>x.type==="AP_POPUP_MACRO"&&x.action==="configure");
  assert.equal(saved.payload.repository,"owner/repo");
  assert.equal(saved.payload.ciBranch,"main");
  assert.equal(saved.payload.ciObservers.length,1);
  assert.equal(saved.payload.ciObservers[0].repository,"owner/Saju");
  assert.equal(saved.payload.ciObservers[0].branch,"main");
});
test("changing primary repository disables duplicate additional selection",async()=>{
  const url="https://chatgpt.com/g/g-p-demo/c/original";
  const ui=await render({registeredUrl:url,currentUrl:url,reason:"WAIT_VERIFIED_CI"});
  ui.el("repository").value="owner/Saju";
  ui.el("repository").listeners.change();
  const inputs=ui.el("additional-repositories")
    .querySelectorAll('input[type="checkbox"]');
  assert.equal(inputs.find(x=>x.value==="owner/Saju").disabled,true);
  assert.equal(inputs.find(x=>x.value==="owner/repo").disabled,false);
});

test("task-unit is a separate selectable macro in the popup and is saved without a roadmap mode",async()=>{
  const url="https://chatgpt.com/g/g-p-demo/c/original";
  const html=(await import("node:fs")).readFileSync(
    new URL("../extension/popup-simple.html",import.meta.url),"utf8");
  assert.match(html,/option value="task_unit"/);
  const ui=await render({registeredUrl:url,currentUrl:url,reason:"WAIT_VERIFIED_CI"});
  ui.el("macro").value="task_unit";
  await ui.el("start").listeners.click();
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  const saved=ui.calls.find(x=>x.type==="AP_POPUP_MACRO"&&x.action==="configure");
  assert.equal(saved.payload.preferredMacroKey,"task_unit");
  assert.equal(saved.payload.mode,"auto");
});

test("dashboard lists a registered CI-failed chat and a new chat requiring registration",async()=>{
 const url="https://chatgpt.com/g/g-p-demo/c/known";
 const ui=await render({registeredUrl:url,currentUrl:url,reason:"WAIT_VERIFIED_CI",
   extraTabs:[{id:18,title:"New chatbot",url:"https://chatgpt.com/g/g-p-demo/c/new",groupTitle:"MyeongHa",active:false}]});
 const rows=ui.el("overview-list").options;
 assert.equal(rows.length,2);
 assert.match(rows[0].children[1].textContent,/CI/);
 assert.match(rows[1].children[0].children[0].textContent,/New chatbot/);
 assert.equal(rows[1].children[2].children.some(x=>x.textContent==="탭 등록"),true);
 const register=rows[1].children[2].children.find(x=>x.textContent==="탭 등록");
 await register.listeners.click();
 for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.calls.some(x=>x.type==="AP_POPUP_ENROLL"&&x.tabId===18),true);
});
test("dashboard safely retries a paused observation without configuring or sending",async()=>{
 const url="https://chatgpt.com/g/g-p-demo/c/known";
 const ui=await render({registeredUrl:url,currentUrl:url,reason:"OBSERVATION_UNVERIFIED",enabled:false});
 const actions=ui.el("overview-list").options[0].children[2].children;
 const retry=actions.find(x=>x.textContent==="다시 검증");
 assert.ok(retry);
 await retry.listeners.click();
 for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.calls.some(x=>x.type==="AP_POPUP_MACRO"&&x.action==="resumeObservation"&&
    x.payload.sessionKey==="payment-session"),true);
 assert.equal(ui.calls.some(x=>x.type==="AP_POPUP_MACRO"&&x.action==="send"),false);
});
test("dashboard approval requires a separate explicit confirmation flow",async()=>{
 const url="https://chatgpt.com/g/g-p-demo/c/known";
 const ui=await render({registeredUrl:url,currentUrl:url,
   reason:"USER_APPROVAL_OR_PROVIDER_BLOCKER",enabled:false});
 const buttons=ui.el("overview-list").options[0].children[2].children;
 const approve=buttons.find(x=>x.textContent==="승인 완료 반영");
 assert.ok(approve);
 await approve.listeners.click();
 for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ui.calls.some(x=>x.type==="AP_POPUP_MACRO"&&x.action==="resumeApproved"&&
  x.payload.confirmed===true),true);
 assert.equal(ui.calls.some(x=>x.type==="AP_POPUP_MACRO"&&x.action==="send"),false);
});
test("CI scope can be saved separately without enabling or sending",async()=>{
 const url="https://chatgpt.com/g/g-p-demo/c/known";
 const ui=await render({registeredUrl:url,currentUrl:url,
   reason:"USER_APPROVAL_OR_PROVIDER_BLOCKER",enabled:false});
 assert.equal(ui.el("save-ci").disabled,false);
 ui.el("ci-branch").value="fix/payment-red";
 await ui.el("save-ci").listeners.click();
 for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
 const action=ui.calls.find(x=>x.type==="AP_POPUP_MACRO"&&x.action==="saveCi");
 assert.equal(action.payload.repository,"owner/repo");
 assert.equal(action.payload.ciBranch,"fix/payment-red");
 assert.equal(ui.calls.some(x=>x.type==="AP_POPUP_MACRO"&&x.action==="configure"),false);
});

test("newly registered chat with no macro config starts at default 5 minute interval",async()=>{
  const url="https://chatgpt.com/g/g-p-demo/c/fresh-chat";
  const ui=await render({registeredUrl:url,currentUrl:url,noConfiguration:true});
  assert.equal(ui.el("interval-minutes").value,"5");
  ui.el("repository").value="owner/repo";
  await ui.el("start").listeners.click();
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  const configured=ui.calls.find(x=>x.type==="AP_POPUP_MACRO"&&x.action==="configure");
  assert.ok(configured,ui.el("status").textContent);
  assert.equal(configured.payload.sessionKey,"payment-session");
  assert.equal(configured.payload.repository,"owner/repo");
  assert.equal(configured.payload.intervalMinutes,5);
});
test("operator can change auto interval while selecting macro",async()=>{
  const url="https://chatgpt.com/g/g-p-demo/c/fresh-chat";
  const ui=await render({registeredUrl:url,currentUrl:url,noConfiguration:true});
  ui.el("repository").value="owner/repo";
  ui.el("interval-minutes").value="13";
  ui.el("macro").value="task_unit";
  await ui.el("start").listeners.click();
  for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  const configured=ui.calls.find(x=>x.type==="AP_POPUP_MACRO"&&x.action==="configure");
  assert.ok(configured,ui.el("status").textContent);
  assert.equal(configured.payload.intervalMinutes,13);
  assert.equal(configured.payload.preferredMacroKey,"task_unit");
});
test("bad execution interval never submits a configure or send command",async()=>{
  const url="https://chatgpt.com/g/g-p-demo/c/fresh-chat";
  for(const value of ["0","1441","1.5","abc",""]){
    const ui=await render({registeredUrl:url,currentUrl:url,noConfiguration:true});
    ui.el("repository").value="owner/repo";
    ui.el("interval-minutes").value=value;
    await ui.el("start").listeners.click();
    for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(ui.calls.some(x=>x.type==="AP_POPUP_MACRO"&&x.action==="configure"),false,value);
    assert.equal(ui.calls.some(x=>x.type==="AP_POPUP_MACRO"&&x.action==="send"),false,value);
  }
});
