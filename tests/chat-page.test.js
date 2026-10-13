import test from "node:test";
import assert from "node:assert/strict";
import { submitToExistingChatGPT } from "../extension/chat-page.js";

async function withFakePage({url="https://chatgpt.com/c/existing-123",
  alreadyTyped="",busy=false,sendDisabled=false,composerCount=1,insertFails=false}={},fn){
  const oldLocation=globalThis.location,oldDocument=globalThis.document;
  let clicked=0;
  const u=new URL(url);
  let editor;
  editor={
    isContentEditable:true,tagName:"DIV",textContent:alreadyTyped,
    getClientRects:()=>[{}],focus(){}
  };
  const send={disabled:sendDisabled,getClientRects:()=>[{}],
    click(){clicked++;}};
  globalThis.location={origin:u.origin,pathname:u.pathname};
  globalThis.document={
    visibilityState:"visible",
    querySelector(selector){
      if(selector.startsWith('[data-testid="stop-button"]'))return busy
        ? {disabled:false,getClientRects:()=>[{}]}:null;
      return null;
    },
    querySelectorAll(selector){
      if(selector.includes("#prompt-textarea"))return composerCount===1?[editor]:
        composerCount===2?[editor,{...editor}]:[];
      if(selector.includes("send-button"))return [send];
      return [];
    },
    execCommand(_command,_show,value){
      if(insertFails)return false;
      editor.textContent=value;return true;
    }
  };
  try{return await fn({clicked:()=>clicked,editor});}
  finally{globalThis.location=oldLocation;globalThis.document=oldDocument;}
}
test("send helper only clicks the registered existing ChatGPT conversation composer",async()=>{
  await withFakePage({},async x=>{
    const result=await submitToExistingChatGPT("확인하고 계속 진행");
    assert.equal(result.clicked,true);
    assert.equal(result.reason,"SEND_BUTTON_CLICKED_UNVERIFIED");
    assert.equal(x.clicked(),1);
    assert.equal(x.editor.textContent,"확인하고 계속 진행");
  });
});
test("refuses other origins, new-chat routes and unrelated pages",async()=>{
  for(const url of [
    "https://example.com/c/chat","https://chatgpt.com/",
    "https://chatgpt.com/?model=fast","https://chatgpt.com/settings",
    "https://chatgpt.com/g/g-test"
  ]){
    await withFakePage({url},async x=>{
      const r=await submitToExistingChatGPT("계속 진행");
      assert.equal(r.clicked,false);
      assert.equal(r.reason,"NOT_EXISTING_CHATGPT_CONVERSATION");
      assert.equal(x.clicked(),0);
    });
  }
});
test("refuses generating, user draft, multiple editors, disabled send and failed input",async()=>{
  for(const [input,reason] of [
    [{alreadyTyped:"사용자가 직접 작성 중"},"COMPOSER_HAS_UNSENT_TEXT"],
    [{busy:true},"CHATGPT_STILL_GENERATING"],
    [{composerCount:2},"COMPOSER_NOT_UNAMBIGUOUS"],
    [{sendDisabled:true},"SEND_BUTTON_UNAVAILABLE"],
    [{insertFails:true},"COMPOSER_INSERTION_UNVERIFIED"]
  ]){
    await withFakePage(input,async x=>{
      const result=await submitToExistingChatGPT("확인하고 계속 진행");
      assert.equal(result.clicked,false);
      assert.equal(result.reason,reason);
      assert.equal(x.clicked(),0);
    });
  }
});
