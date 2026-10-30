import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
class FakeNode{
  constructor(tag="div"){this.tag=tag;this.children=[];this.options=[];
    this.value="";this.textContent="";this.disabled=false;this.listeners={};
    this.classList={toggle:()=>{}};}
  addEventListener(name,callback){this.listeners[name]=callback;}
  replaceChildren(...children){this.children=[];this.options=[];this.value="";this.append(...children);}
  append(...children){for(const item of children){this.children.push(item);
    if(this.tag==="select"&&item.tag==="option"){this.options.push(item);
      if(this.options.length===1)this.value=item.value;}}}
}
function harness(offline=false){
 const nodes=new Map(),calls=[];
 const get=id=>{if(!nodes.has(id))nodes.set(id,new FakeNode(id.includes("quick-")&&["quick-tab","quick-workstream","quick-mode"].includes(id)?"select":"div"));return nodes.get(id);};
 for(const id of ["quick-tab","quick-workstream"])get(id);
 const document={getElementById:get,createElement:tag=>new FakeNode(tag)};
 const sendMessage=async msg=>{
  calls.push(msg.type+(msg.action?":"+msg.action:""));
  if(msg.type==="AP_POPUP_DISCOVER")return {ok:true,data:{tabs:[
   {id:10,groupId:-1,title:"PIE test chat",url:"https://chatgpt.com/c/one",active:true},
   {id:20,groupId:3,title:"BuildMap chat",url:"https://chatgpt.com/c/two",active:false}]}};
  if(msg.type==="AP_GET")return {ok:true,data:{overview:{
   discoveredGroups:1,registeredTabs:1,activeTabs:1,attention:0
  },registry:{sessions:[]},snapshot:{tabs:[]}}};
  if(msg.type==="AP_POPUP_CONTROL"&&msg.action==="state"){
   if(offline)return {ok:false,error:"LOCAL_SERVER_OFFLINE"};
   return {ok:true,data:{workstreams:[
    {id:"pie",name:"PIE"},{id:"buildmap",name:"BuildMap"}
   ],configs:[],links:[],stopped:false}};
  }
  if(msg.type==="AP_AUTO_MIGRATION_STATE")return {ok:true,data:{tracks:[]}};
  return {ok:false,error:"unexpected command"};
 };
 const chrome={runtime:{sendMessage,openOptionsPage:async()=>{}}};
 const window={close:()=>{}};
 const code=readFileSync(new URL("../extension/popup.js",import.meta.url),"utf8");
 vm.runInNewContext(code,{document,chrome,window,console,confirm:()=>false});
 return {nodes:get,calls};
}
test("popup renders real local tabs and all server workstreams",async()=>{
 const app=harness();await new Promise(r=>setTimeout(r,60));
 assert.deepEqual(app.nodes("quick-tab").options.map(o=>o.textContent),["PIE test chat","BuildMap chat"]);
 assert.deepEqual(app.nodes("quick-workstream").options.map(o=>o.textContent),["PIE","BuildMap"]);
 assert.ok(app.nodes("quick-state").textContent.length>3);
 assert.ok(app.calls.includes("AP_POPUP_DISCOVER"));
});
test("offline server preserves independent tab list and shows its failure",async()=>{
 const app=harness(true);await new Promise(r=>setTimeout(r,60));
 assert.equal(app.nodes("quick-tab").options.length,2);
 assert.equal(app.nodes("quick-workstream").options.length,0);
 assert.match(app.nodes("quick-state").textContent,/LOCAL_SERVER_OFFLINE/);
});
