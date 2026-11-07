import test from "node:test";
import assert from "node:assert/strict";
import {
  TOOLBAR_STATES,classifyToolbarState,drawToolbarIcon,updateToolbarIndicator
} from "../extension/toolbar-indicator.js";

const registered=(key="chat-a",url="https://chatgpt.com/c/a")=>({
  key,groupKey:"",tabId:key==="chat-a"?11:12,url,paused:false
});
const macro=(key="chat-a",values={})=>({
  sessionKey:key,enabled:true,status:"armed",reason:"WAIT_VERIFIED_CI",
  ...values
});
const snapshot=(values={})=>({
  connected:true,globalStopped:false,
  registry:{groups:[],sessions:[registered()]},
  tabs:[{id:11,url:"https://chatgpt.com/c/a"}],
  sessions:[macro()],
  ...values
});

test("toolbar colors reflect disconnection, stop, pending CI and actual processing",()=>{
  assert.equal(classifyToolbarState({connected:false}).state,"blocked");
  assert.equal(classifyToolbarState(snapshot({globalStopped:true})).state,"blocked");
  assert.equal(classifyToolbarState(snapshot()).state,"waiting");
  assert.equal(classifyToolbarState(snapshot({
    sessions:[macro("chat-a",{status:"waiting",reason:"WAIT_POST_SEND_REPLY"})]
  })).state,"running");
  assert.equal(classifyToolbarState(snapshot({
    sessions:[macro("chat-a",{status:"sending",reason:null})]
  })).state,"running");
  assert.equal(classifyToolbarState(snapshot({
    sessions:[macro("chat-a",{status:"migrating",reason:"HANDOFF_IN_PROGRESS"})]
  })).state,"waiting");
  assert.equal(classifyToolbarState(snapshot({
    sessions:[macro("chat-a",{enabled:false,status:"paused",
      reason:"USER_APPROVAL_OR_PROVIDER_BLOCKER"})]
  })).state,"blocked");
  assert.equal(classifyToolbarState(snapshot({
    sessions:[macro("chat-a",{enabled:true,status:"needs_attention"})]
  })).state,"blocked");
  assert.equal(classifyToolbarState(snapshot({
    sessions:[macro("chat-a",{ci:{ciState:"FAILURE"}})]
  })).state,"blocked");
});

test("one broken registered chat overrides other running chats",()=>{
  const info=classifyToolbarState(snapshot({
    registry:{groups:[],sessions:[registered(),registered("chat-b","https://chatgpt.com/c/b")]},
    tabs:[{id:11,url:"https://chatgpt.com/c/a"},
      {id:12,url:"https://chatgpt.com/c/b"}],
    sessions:[macro("chat-a",{status:"sending"}),
      macro("chat-b",{enabled:false,status:"paused",reason:"OPERATOR_STOPPED"})]
  }));
  assert.equal(info.state,"blocked");
  assert.deepEqual(info.counts,{running:1,waiting:0,blocked:1});
  assert.match(info.reason,/중지\/오류 1/);
});

test("stale URL, missing tab and paused group are red; unconfigured is waiting",()=>{
  const stale=classifyToolbarState(snapshot({
    tabs:[{id:11,url:"https://chatgpt.com/c/new"}]
  }));
  assert.equal(stale.state,"blocked");
  assert.equal(classifyToolbarState(snapshot({tabs:[]})).state,"blocked");
  const paused=classifyToolbarState(snapshot({
    registry:{groups:[{key:"group",paused:true}],
      sessions:[{...registered(),groupKey:"group"}]}
  }));
  assert.equal(paused.state,"blocked");
  assert.equal(classifyToolbarState(snapshot({sessions:[]})).state,"waiting");
  assert.equal(classifyToolbarState(snapshot({
    registry:{groups:[],sessions:[]},tabs:[],sessions:[]
  })).state,"waiting");
});

class FakeCanvas {
  constructor(width,height){this.width=width;this.height=height;}
  getContext(){
    return {
      clearRect(){},beginPath(){},roundRect(){},fill(){},
      fillText(){},set fillStyle(_value){},set font(_value){},
      set textAlign(_value){},set textBaseline(_value){},
      getImageData:()=>({width:this.width,height:this.height,
        data:new Uint8ClampedArray(this.width*this.height*4)})
    };
  }
}

test("actual toolbar D icon is rendered in each requested color",()=>{
  for(const kind of ["running","waiting","blocked"]){
    const img=drawToolbarIcon(kind,16,FakeCanvas);
    assert.equal(img.width,16);
    assert.equal(img.height,16);
    assert.match(TOOLBAR_STATES[kind].color,/^#[A-Fa-f0-9]{6}$/);
  }
});

test("paint sets icon and accessible tooltip without sending any commands",async()=>{
  const calls=[];
  const chromeApi={action:{
    setIcon:async options=>calls.push(["icon",options.imageData]),
    setBadgeText:async options=>calls.push(["badge",options.text]),
    setTitle:async options=>calls.push(["title",options.title])
  }};
  const result=await updateToolbarIndicator(chromeApi,snapshot({
    sessions:[macro("chat-a",{status:"sending"})]
  }),{CanvasCtor:FakeCanvas});
  assert.equal(result.state,"running");
  assert.equal(calls[0][0],"icon");
  assert.equal(calls[0][1][16].width,16);
  assert.equal(calls[0][1][32].width,32);
  assert.deepEqual(calls[1],["badge",""]);
  assert.match(calls[2][1],/실행 중/);
});

test("if canvas painting fails, a colored badge and tooltip still work",async()=>{
  const calls=[];
  const chromeApi={action:{
    setIcon:async()=>{throw Error("renderer unavailable");},
    setBadgeBackgroundColor:async o=>calls.push(["color",o.color]),
    setBadgeText:async o=>calls.push(["text",o.text]),
    setTitle:async o=>calls.push(["title",o.title])
  }};
  const result=await updateToolbarIndicator(chromeApi,snapshot({
    sessions:[macro("chat-a",{enabled:false,status:"paused"})]
  }),{CanvasCtor:FakeCanvas});
  assert.equal(result.state,"blocked");
  assert.deepEqual(calls[0],["color","#EF4444"]);
  assert.deepEqual(calls[1],["text","●"]);
  assert.match(calls[2][1],/중지/);
});
