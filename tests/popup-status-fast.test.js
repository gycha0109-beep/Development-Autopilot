import test from "node:test";
import assert from "node:assert/strict";
import {readPopupStatus} from "../extension/popup-status.js";

const url="https://chatgpt.com/g/g-p-demo/c/conversation-123";
const STORAGE_KEY="autopilot.registry.v1";
const CONFIG_KEY="autopilot.bridge.v1";
function fixtures({paired=true}={}){
  const calls={tabs:0,storage:0,fetch:0};
  const chromeApi={
    tabs:{query:async()=>{calls.tabs++;return [
      {id:21,url,title:"결제 3",active:true},
      {id:22,url:"chrome://extensions",title:"Extensions",active:false}
    ];}},
    storage:{local:{get:async()=>{calls.storage++;return {
      [STORAGE_KEY]:{version:1,groups:[],sessions:[{
        key:"payment-3",groupKey:"",tabId:21,windowId:1,
        sessionToken:"session",url,title:"결제 3",paused:false
      }]},
      [CONFIG_KEY]:paired?{token:"private-token"}:null
    };}}}
  };
  return {chromeApi,calls};
}

test("popup snapshot reads registered tabs independently and observes macro status",async()=>{
  const {chromeApi,calls}=fixtures();
  const fetchImpl=async(request,options)=>{
    calls.fetch++;
    assert.match(request,/\/api\/v1\/bridge\/macro-state$/);
    assert.equal(options.method,"POST");
    assert.equal(options.headers.Authorization,"Bearer private-token");
    return {ok:true,json:async()=>({sessions:[{
      sessionKey:"payment-3",enabled:true,status:"waiting",
      reason:"WAIT_POST_SEND_REPLY",repository:"owner/repo"
    }],globalStopped:false})};
  };
  const response=await readPopupStatus({chromeApi,fetchImpl,timeoutMs:40});
  assert.equal(response.connected,true);
  assert.equal(response.tabs.length,1);
  assert.equal(response.tabs[0].title,"결제 3");
  assert.equal(response.registry.sessions[0].key,"payment-3");
  assert.equal(response.sessions[0].reason,"WAIT_POST_SEND_REPLY");
  assert.deepEqual(calls,{tabs:1,storage:1,fetch:1});
  assert.equal(JSON.stringify(response).includes("private-token"),false);
});

test("if local server never responds, show real chat list plus bounded error",async()=>{
  const {chromeApi}=fixtures();
  const never=new Promise(()=>{});
  const started=Date.now();
  const response=await readPopupStatus({
    chromeApi,fetchImpl:async()=>never,timeoutMs:25
  });
  assert.equal(response.connected,false);
  assert.equal(response.tabs.length,1);
  assert.equal(response.registry.sessions[0].key,"payment-3");
  assert.match(response.error,/POPUP_LOCAL_SERVER_TIMEOUT/);
  assert.ok(Date.now()-started<3000);
});

test("unpaired extension still lists chats without touching local server",async()=>{
  const {chromeApi,calls}=fixtures({paired:false});
  const response=await readPopupStatus({
    chromeApi,fetchImpl:async()=>{calls.fetch++;throw Error("should never fetch");}
  });
  assert.equal(response.connected,false);
  assert.equal(response.tabs.length,1);
  assert.equal(calls.fetch,0);
  assert.match(response.error,/연결되지 않았습니다/);
});

test("invalid macro server response cannot arm popup actions",async()=>{
  const {chromeApi}=fixtures();
  const response=await readPopupStatus({
    chromeApi,fetchImpl:async()=>({ok:true,json:async()=>({unexpected:true})})
  });
  assert.equal(response.connected,false);
  assert.match(response.error,/POPUP_LOCAL_SERVER_INVALID_STATE/);
});
