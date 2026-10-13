import test from "node:test";
import assert from "node:assert/strict";
import { STORAGE_KEY, SESSION_KEY } from "../extension/core.js";
import { BRIDGE_CONFIG_KEY } from "../extension/bridge-core.js";

const listener=()=>({addListener(fn){this.callback=fn}});
test("real extension worker accepts approved new/project tab and blocks unrelated page before injection",async()=>{
  const oldChrome=globalThis.chrome,oldFetch=globalThis.fetch;
  const onMessage=listener();
  const group={id:5,windowId:3,title:"project",color:"blue",collapsed:false};
  const tab={id:7,windowId:3,groupId:5,title:"New chat",url:"https://chatgpt.com/"};
  const token="epoch-123";
  const registry={version:1,
    groups:[{key:"group",groupId:5,windowId:3,sessionToken:token,label:"project",paused:false}],
    sessions:[{key:"session",groupKey:"group",tabId:7,sessionToken:token,
      url:tab.url,title:"New chat",paused:false}]
  };
  const storage={
    [STORAGE_KEY]:registry,
    [BRIDGE_CONFIG_KEY]:{token:"paired-local-token"}
  };
  const acks=[];
  const injected=[];
  globalThis.chrome={
    runtime:{id:"abcdefghijklmnopabcdefghijklmnop",
      getManifest:()=>({version:"0.4.6"}),onMessage,
      onInstalled:listener(),onStartup:listener(),sendMessage:async()=>{}},
    storage:{
      local:{get:async key=>({[key]:storage[key]}),
        set:async next=>Object.assign(storage,next),remove:async key=>delete storage[key]},
      session:{get:async key=>({[key]:token}),set:async()=>{}},
      onChanged:listener()
    },
    tabs:{query:async()=>[tab],onCreated:listener(),onUpdated:listener(),
      onRemoved:listener(),onMoved:listener(),onAttached:listener(),onDetached:listener()},
    tabGroups:{query:async()=>[group],onCreated:listener(),
      onUpdated:listener(),onRemoved:listener()},
    alarms:{create:async()=>{},onAlarm:listener()},
    scripting:{executeScript:async args=>{
      injected.push(args.func.name);
      if(args.func.name==="diagnoseExistingChatGPTComposer")
        return [{result:{eligible:true,build:"composer-2026-10-13-r7"}}];
      return [{result:{clicked:true,reason:"SEND_BUTTON_CLICKED_UNVERIFIED"}}];
    }}
  };
  globalThis.fetch=async(url,options)=>{
    const path=new URL(url).pathname;
    const body=JSON.parse(options.body);
    let response;
    if(path.endsWith("/sync"))response={accepted:true};
    else if(path.endsWith("/commands"))
      response={command:{id:"command-1",sessionKey:"session",message:"first approved message"}};
    else if(path.endsWith("/ack")){
      acks.push(body);response={ok:true};
    }else throw Error("unexpected request "+path);
    return {ok:true,json:async()=>response};
  };
  try{
    await import("../extension/background.js?new-chat-worker");
    const send=message=>new Promise(resolve=>{
      assert.equal(onMessage.callback(message,{id:globalThis.chrome.runtime.id},resolve),true);
    });
    for(const [url,expected] of [
      ["https://chatgpt.com/","sent"],
      ["https://chatgpt.com/g/g-p-12345-project/project","sent"],
      ["https://chatgpt.com/g/g-p-12345-project","sent"],
      ["https://chatgpt.com/settings","blocked"],
      ["https://chatgpt.com/g/g-p-12345-project/files","blocked"]
    ]){
      tab.url=url;registry.sessions[0].url=url;
      const before=injected.length;
      const res=await send({type:"AP_BRIDGE_SYNC"});
      assert.equal(res.ok,true,url);
      assert.equal(acks.at(-1).status,expected,url);
      assert.equal(injected.length-before,expected==="sent"?1:0,url);
      if(expected==="blocked")
        assert.equal(acks.at(-1).reason,"UNSUPPORTED_CHATGPT_PAGE");
    }
    tab.url="https://chatgpt.com/g/g-p-12345-project/project";
    registry.sessions[0].url=tab.url;
    const diagnosis=await send({type:"AP_CHAT_DIAGNOSE"});
    assert.equal(diagnosis.ok,true);
    assert.equal(diagnosis.data.eligible,true);
    assert.equal(injected.at(-1),"diagnoseExistingChatGPTComposer");
    const before=injected.length;
    const wrong=await send({type:"AP_CHAT_DIAGNOSE",sessionKey:"not-registered"});
    assert.equal(wrong.ok,true);
    assert.equal(wrong.data.reason,"NO_REGISTERED_CONNECTED_CHAT");
    assert.equal(injected.length,before);
    const selected=await send({type:"AP_CHAT_DIAGNOSE",sessionKey:"session"});
    assert.equal(selected.data.eligible,true);
  }finally{
    globalThis.chrome=oldChrome;
    globalThis.fetch=oldFetch;
  }
});
