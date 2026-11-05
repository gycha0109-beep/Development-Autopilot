import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../extension/popup-simple.js",import.meta.url),"utf8");

async function render({registeredUrl,currentUrl,reason="MIGRATION_IN_PROGRESS",enabled=true}){
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
      append(item){this.children.push(item);}
    }),
    activeElement:null
  };
  const sessionKey="payment-session";
  const currentTab={id:17,url:currentUrl,active:true,title:"결제 1"};
  const backend={
    AP_POPUP_SNAPSHOT:{tabs:[currentTab],
      repositories:["owner/repo","owner/Saju"],
      repositoryDirectory:{repositories:[{name:"owner/repo"},{name:"owner/Saju"}]},
      registry:{sessions:[{key:sessionKey,tabId:17,url:registeredUrl}]},
      connected:true,error:"",sessions:[{
        sessionKey,enabled,status:reason==="MIGRATION_IN_PROGRESS"?"migrating":"waiting",
        reason,mode:"auto",preferredMacroKey:"general",repository:"owner/repo",
        intervalMinutes:5
      }],globalStopped:false},
    AP_GET:{registry:{sessions:[{key:sessionKey,tabId:17,url:registeredUrl}]}},
    AP_POPUP_MACRO:{sessions:[],globalStopped:false}
  };
  const chrome={
    runtime:{
      async sendMessage({type,action,payload}){
        calls.push({type,action,payload});
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
  assert.match(ui.el("status").textContent,/주소가 변경/);
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
