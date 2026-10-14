import test from "node:test";
import assert from "node:assert/strict";

function emitter(){
  let handler=null;
  return {
    addListener(callback){handler=callback;},
    get callback(){return handler;}
  };
}
test("live service worker responds to version requests even when tab and storage discovery fail",async()=>{
  const before=globalThis.chrome;
  const onMessage=emitter();
  const event=()=>emitter();
  let tabsQueried=0;
  globalThis.chrome={
    runtime:{
      id:"abcdefghijklmnopabcdefghijklmnop",
      getManifest:()=>({version:"0.4.10"}),
      onInstalled:event(),onStartup:event(),onMessage
    },
    storage:{
      local:{get:async()=>{throw new Error("Storage broken");}},
      session:{get:async()=>{throw new Error("Session broken");}},
      onChanged:event()
    },
    alarms:{create:async()=>{},onAlarm:event()},
    tabs:{
      query:async()=>{tabsQueried++;throw Error("tab query failed");},
      onCreated:event(),onUpdated:event(),onRemoved:event(),
      onMoved:event(),onAttached:event(),onDetached:event()
    },
    tabGroups:{
      query:async()=>{tabsQueried++;throw Error("group query failed");},
      onCreated:event(),onUpdated:event(),onRemoved:event()
    }
  };
  try{
    await import("../extension/background.js?test-worker-handshake");
    const response=await new Promise(resolve=>{
      const keptOpen=onMessage.callback(
        {type:"AP_BRIDGE_STATUS"},
        {id:globalThis.chrome.runtime.id},resolve
      );
      assert.equal(keptOpen,true);
    });
    assert.equal(response.ok,true);
    assert.equal(response.data.extensionVersion,"0.4.10");
    assert.equal(response.data.composerBuild,"composer-2026-10-14-r11");
    assert.equal(response.data.paired,false);
    assert.equal(response.data.error,"LOCAL_EXTENSION_STORAGE_UNAVAILABLE");
    assert.equal(tabsQueried,0);
  }finally{
    globalThis.chrome=before;
  }
});
