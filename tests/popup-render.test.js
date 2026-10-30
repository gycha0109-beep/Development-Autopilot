import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

class FakeNode {
  constructor(tag="div"){
    this.tag=tag;this.children=[];this.options=[];this.value="";
    this.textContent="";this.disabled=false;this.listeners={};
    this.classList={toggle:()=>{}};
  }
  addEventListener(name,callback){this.listeners[name]=callback;}
  click(){this.listeners.click?.();}
  replaceChildren(...children){
    this.children=[];this.options=[];this.value="";
    this.append(...children);
  }
  append(...children){
    for(const item of children){
      this.children.push(item);
      if(this.tag==="select"&&item.tag==="option"){
        this.options.push(item);
        if(this.options.length===1)this.value=item.value;
      }
    }
  }
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function harness(offline=false,{initiallyPaired=false,confirmAnswer=true}={}){
  const nodes=new Map(),calls=[],messages=[];
  let paired=initiallyPaired;
  const get=id=>{
    if(!nodes.has(id))nodes.set(id,new FakeNode(
      ["quick-tab","quick-group","quick-workstream","quick-mode"].includes(id)?"select":"div"));
    return nodes.get(id);
  };
  const document={getElementById:get,createElement:tag=>new FakeNode(tag)};
  const sendMessage=async msg=>{
    calls.push(msg.type+(msg.action?":"+msg.action:""));
    messages.push(msg);
    if(msg.type==="AP_BRIDGE_STATUS")
      return {ok:true,data:{paired,error:""}};
    if(msg.type==="AP_POPUP_DISCOVER")
      return {ok:true,data:{
        tabs:[
          {id:10,groupId:-1,windowId:1,title:"PIE test chat",
            url:"https://chatgpt.com/c/one",active:true},
          {id:20,groupId:3,windowId:2,title:"BuildMap chat",
            url:"https://chatgpt.com/c/two",active:false}
        ],
        groups:[
          {id:31,windowId:1,title:"PIE",color:"blue"},
          {id:32,windowId:1,title:"Review",color:"green"},
          {id:3,windowId:2,title:"BuildMap",color:"red"}
        ]
      }};
    if(msg.type==="AP_GET")
      return {ok:true,data:{
        overview:{discoveredGroups:2,registeredTabs:1,activeTabs:1,attention:0},
        registry:{sessions:[]},snapshot:{tabs:[]}
      }};
    if(msg.type==="AP_POPUP_CONTROL"&&msg.action==="state"){
      if(offline)return {ok:false,error:"LOCAL_SERVER_OFFLINE"};
      return {ok:true,data:{
        workstreams:[{id:"pie",name:"PIE"},{id:"buildmap",name:"BuildMap"}],
        configs:[],links:[],stopped:false
      }};
    }
    if(msg.type==="AP_AUTO_MIGRATION_STATE")return {ok:true,data:{tracks:[]}};
    if(msg.type==="AP_POPUP_CREATE_GROUP")return {ok:true,data:{tabId:msg.tabId}};
    if(msg.type==="AP_POPUP_PAIR"){
      paired=true;
      return {ok:true,data:{connected:true,syncPending:false}};
    }
    if(msg.type==="AP_POPUP_ATTACH_GROUP")
      return {ok:true,data:{groupName:"PIE",preservedSession:false,syncPending:false}};
    return {ok:false,error:"unexpected command"};
  };
  const chrome={runtime:{sendMessage,openOptionsPage:async()=>{}}};
  const window={close:()=>{}};
  const code=readFileSync(new URL("../extension/popup.js",import.meta.url),"utf8");
  vm.runInNewContext(code,{document,chrome,window,console,confirm:()=>confirmAnswer});
  return {nodes:get,calls,messages};
}

test("popup renders available chats, existing Chrome groups and server workstreams",async()=>{
  const app=harness();await sleep(70);
  assert.deepEqual(app.nodes("quick-tab").options.map(o=>o.textContent),
    ["PIE test chat","BuildMap chat"]);
  assert.deepEqual(app.nodes("quick-group").options.map(o=>o.textContent),
    ["PIE","Review"]);
  assert.deepEqual(app.nodes("quick-workstream").options.map(o=>o.textContent),
    ["PIE","BuildMap"]);
  assert.ok(app.calls.includes("AP_POPUP_DISCOVER"));
  assert.equal(app.nodes("quick-bridge-health").textContent,"연결 필요");
});
test("changing selected chat filters existing groups to that Chrome window",async()=>{
  const app=harness();await sleep(70);
  app.nodes("quick-tab").value="20";
  app.nodes("quick-tab").listeners.change();
  assert.deepEqual(app.nodes("quick-group").options.map(o=>o.textContent),
    ["BuildMap (현재 그룹)"]);
});
test("existing-group action sends only selected tab and group IDs",async()=>{
  const app=harness();await sleep(70);
  app.nodes("quick-attach-group").click();
  await sleep(80);
  const item=app.messages.find(x=>x.type==="AP_POPUP_ATTACH_GROUP");
  assert.equal(item.tabId,10);
  assert.equal(item.groupId,31);
  assert.match(app.nodes("quick-state").textContent,/그룹 등록 완료/);
});
test("popup pairing accepts a 20-digit code then clears the input",async()=>{
  const app=harness();await sleep(70);
  const code="0123456789ABCDEF0123";
  app.nodes("quick-bridge-code").value=code;
  app.nodes("quick-pair").click();
  await sleep(80);
  const paired=app.messages.find(x=>x.type==="AP_POPUP_PAIR");
  assert.equal(paired.code,code);
  assert.equal(app.nodes("quick-bridge-code").value,"");
  assert.equal(app.nodes("quick-bridge-health").textContent,"연결됨");
});
test("malformed pairing code does not call server or expose it in UI",async()=>{
  const app=harness();await sleep(70);
  app.nodes("quick-bridge-code").value="not-a-code";
  app.nodes("quick-pair").click();
  await sleep(40);
  assert.equal(app.messages.some(x=>x.type==="AP_POPUP_PAIR"),false);
  assert.match(app.nodes("quick-state").textContent,/20자리 연결 코드/);
  assert.doesNotMatch(app.nodes("quick-state").textContent,/not-a-code/);
});
test("previous pairing cannot be replaced without confirmation",async()=>{
  const app=harness(false,{initiallyPaired:true,confirmAnswer:false});await sleep(70);
  app.nodes("quick-bridge-code").value="0123456789ABCDEF0123";
  app.nodes("quick-pair").click();
  await sleep(50);
  assert.equal(app.messages.some(x=>x.type==="AP_POPUP_PAIR"),false);
});
test("offline server still displays Chrome groups and pairing instructions",async()=>{
  const app=harness(true);await sleep(70);
  assert.equal(app.nodes("quick-tab").options.length,2);
  assert.equal(app.nodes("quick-group").options.length,2);
  assert.equal(app.nodes("quick-workstream").options.length,0);
  assert.match(app.nodes("quick-state").textContent,/LOCAL_SERVER_OFFLINE/);
  assert.equal(app.nodes("quick-bridge-health").textContent,"연결 필요");
});

test("new group action targets the selected chat rather than the active tab",async()=>{
  const app=harness();await sleep(70);
  app.nodes("quick-tab").value="20";
  app.nodes("quick-tab").listeners.change();
  app.nodes("quick-create-group").click();
  await sleep(80);
  const item=app.messages.find(x=>x.type==="AP_POPUP_CREATE_GROUP");
  assert.equal(item.tabId,20);
});
test("paired token with offline server is not presented as healthy connection",async()=>{
  const app=harness(true,{initiallyPaired:true});await sleep(70);
  assert.match(app.nodes("quick-bridge-health").textContent,/서버 확인 필요/);
  assert.match(app.nodes("quick-state").textContent,/LOCAL_SERVER_OFFLINE/);
});
