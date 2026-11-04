import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../extension/popup-simple.js",import.meta.url),"utf8");
const html=readFileSync(new URL("../extension/popup-simple.html",import.meta.url),"utf8");

async function fixture({registeredUrl,liveUrl,enabled=true,reason="WAIT_VERIFIED_CI"}){
  const nodes=new Map(),calls=[];
  const node=id=>{
    if(!nodes.has(id)){
      const el={id,value:"",textContent:"",disabled:false,items:[],events:{},
        classList:{contains(){return false;},toggle(){},remove(){}},
        addEventListener(type,fn){this.events[type]=fn;},
        replaceChildren(){this.items=[];this.value="";},
        append(option){this.items.push(option);if(this.items.length===1)this.value=option.value;},
        get selectedOptions(){return this.items.filter(x=>x.value===this.value);}
      };
      nodes.set(id,el);
    }
    return nodes.get(id);
  };
  const api={
    AP_POPUP_DISCOVER:{tabs:[{id:47,url:liveUrl,active:true,title:"사주 엔진 1"}]},
    AP_GET:{registry:{sessions:[{key:"saju",tabId:47,url:registeredUrl}]}},
    AP_BRIDGE_STATUS:{paired:true},
    AP_POPUP_MACRO:{sessions:[{
      sessionKey:"saju",enabled,status:"waiting",reason,
      repository:"owner/repo",intervalMinutes:5,preferredMacroKey:"general"
    }],globalStopped:false}
  };
  const chrome={runtime:{
    async sendMessage(msg){
      calls.push(msg);
      return {ok:true,data:msg.action&&msg.action!=="state"?{}:api[msg.type]};
    },
    async openOptionsPage(){}
  }};
  const context={chrome,document:{
    getElementById:node,createElement:()=>({value:"",textContent:""})
  },confirm:()=>true,window:{close(){}},console};
  vm.runInNewContext(source,context);
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  return {node,calls};
}
test("real minimal popup keeps required actions and management while hiding advanced fields",()=>{
  for(const id of ["chat","macro","start","stop","once","manage","status"]){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.doesNotMatch(html,/id="macro-repository"/);
  assert.match(readFileSync(new URL("../extension/options.html",import.meta.url),"utf8"),/popup-advanced\.html/);
});
test("changed URL disables start and manual once but can stop the registered session",async()=>{
  const f=await fixture({registeredUrl:"https://chatgpt.com/c/first",liveUrl:"https://chatgpt.com/c/second"});
  assert.equal(f.node("start").disabled,true);
  assert.equal(f.node("once").disabled,true);
  assert.equal(f.node("stop").disabled,false);
  assert.match(f.node("status").textContent,/주소/);
  await f.node("start").events.click();
  await f.node("once").events.click();
  assert.equal(f.calls.filter(x=>x.type==="AP_POPUP_ENROLL").length,0);
  assert.equal(f.calls.filter(x=>x.action==="send").length,0);
  await f.node("stop").events.click();
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.find(x=>x.action==="stop")?.payload.sessionKey,"saju");
});
test("selected macro remains selected through the start action and is persisted",async()=>{
  const url="https://chatgpt.com/c/verified";
  const f=await fixture({registeredUrl:url,liveUrl:url});
  assert.equal(f.node("start").disabled,false);
  f.node("macro").value="roadmap";
  await f.node("start").events.click();
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  const saved=f.calls.find(x=>x.action==="configure");
  assert.equal(saved?.payload.sessionKey,"saju");
  assert.equal(saved?.payload.preferredMacroKey,"roadmap");
  assert.equal(f.calls.filter(x=>x.type==="AP_POPUP_ENROLL").length,0);
});
