import test from "node:test";
import assert from "node:assert/strict";
import { submitToExistingChatGPT } from "../extension/chat-page.js";

async function withFakePage({
  url="https://chatgpt.com/c/existing-123",alreadyTyped="",busy=false,
  sendDisabled=false,composerCount=1,insertFails=false,sendAppearsAfterInput=false,
  editorType="legacy",navigateOnType=false,dialog=false,noSendButton=false
}={},fn){
  const oldLocation=globalThis.location,oldDocument=globalThis.document;
  let clicked=0,submitted=0;
  const u=new URL(url);
  let editor;
  editor={
    isContentEditable:true,tagName:"DIV",textContent:alreadyTyped,
    getClientRects:()=>[{}],focus(){},closest:selector=>selector==="form"?form:null,contains:()=>false
  };
  const editor2={...editor};
  const wrapper={
    isContentEditable:false,tagName:"DIV",textContent:"",
    getClientRects:()=>[{}],closest:()=>null,
    querySelectorAll:()=>[editor]
  };
  const container={
    isContentEditable:true,tagName:"DIV",textContent:"",
    getClientRects:()=>[{}],closest:()=>null,
    contains:target=>target===editor
  };
  let form=null;
  if(editorType==="form") {
    form={
      querySelectorAll(selector){
        if(selector.includes("send-button"))return noSendButton || (sendAppearsAfterInput && !editor.textContent)?[]:[send];
        return selector.includes("textarea")?[editor]:[];
      },
      contains:el=>el===editor,
      getAttribute:()=>null,
      requestSubmit(){submitted++;}
    };
  }
  const send={disabled:sendDisabled,getClientRects:()=>[{}],
    click(){clicked++;},closest:selector=>selector==="form"?form:null};
  globalThis.location={origin:u.origin,pathname:u.pathname};
  globalThis.document={
    visibilityState:"visible",
    querySelector(selector){
      if(selector.includes('[role="dialog"]'))return dialog?{visible:true}:null;
      return null;
    },
    querySelectorAll(selector){
      if(selector.includes("stop-button"))
        return busy?[{disabled:false,getClientRects:()=>[{}]}]:[];
      if(selector.includes("send-button"))return noSendButton || (sendAppearsAfterInput && !editor.textContent)?[]:[send];
      if(selector==="form")return form?[form]:[];
      if(form && selector.includes("#prompt-textarea"))return [editor];
      if(selector.includes("#prompt-textarea")){
        if(composerCount===0)return [];
        if(composerCount===2)return [editor,editor2];
        if(editorType==="wrapper")return [wrapper];
        if(editorType==="nested")return [container,editor];
        return [editor];
      }
      return [];
    },
    execCommand(_command,_show,value){
      if(insertFails)return false;
      editor.textContent=value;
      if(navigateOnType)globalThis.location.pathname="/c/different-conversation";
      return true;
    }
  };
  try{return await fn({clicked:()=>clicked,submitted:()=>submitted,editor,send});}
  finally{globalThis.location=oldLocation;globalThis.document=oldDocument;}
}
test("existing conversation: only the unique composer send button is clicked",async()=>{
  await withFakePage({},async x=>{
    const result=await submitToExistingChatGPT("확인하고 계속 진행");
    assert.equal(result.clicked,true);
    assert.equal(result.reason,"SEND_BUTTON_CLICKED_UNVERIFIED");
    assert.equal(x.clicked(),1);
    assert.equal(x.editor.textContent,"확인하고 계속 진행");
  });
});
test("supports the ProseMirror editable, a non-editable prompt wrapper, and form-scoped editable",async()=>{
  for(const editorType of ["legacy","wrapper","form","nested"]){
    await withFakePage({editorType},async x=>{
      const result=await submitToExistingChatGPT("한 번만 전송");
      assert.equal(result.clicked,true,editorType+" "+result.reason);
      assert.equal(x.clicked(),1);
    });
  }
});
test("voice-first ChatGPT layout: send control appears only after text insertion",async()=>{
  await withFakePage({sendAppearsAfterInput:true},async x=>{
    const result=await submitToExistingChatGPT("먼저 입력하고 그다음 전송");
    assert.equal(result.clicked,true);
    assert.equal(x.clicked(),1);
  });
});
test("single verified ChatGPT form can submit after text when send button is not exposed",async()=>{
  await withFakePage({editorType:"form",noSendButton:true},async x=>{
    const result=await submitToExistingChatGPT("안전한 폼 전송");
    assert.equal(result.reason,"CHAT_FORM_SUBMIT_REQUESTED_UNVERIFIED");
    assert.equal(result.clicked,true);
    assert.equal(x.clicked(),0);
    assert.equal(x.submitted(),1);
  });
});
test("missing send control without uniquely verified form refuses submission",async()=>{
  await withFakePage({noSendButton:true},async x=>{
    const result=await submitToExistingChatGPT("폼 없는 입력창");
    assert.equal(result.reason,"SEND_BUTTON_NOT_FOUND");
    assert.equal(result.clicked,false);
    assert.equal(x.clicked(),0);
    assert.equal(x.submitted(),0);
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
test("existing custom-GPT conversation stays an eligible original session",async()=>{
  await withFakePage({url:"https://chatgpt.com/g/g-example-id/c/abc-chat"},async x=>{
    assert.equal((await submitToExistingChatGPT("확인")).clicked,true);
    assert.equal(x.clicked(),1);
  });
});
test("refuses generating, draft, multiple or missing editors, disabled send and failed insert",async()=>{
  for(const [input,reason] of [
    [{alreadyTyped:"사용자가 직접 작성 중"},"COMPOSER_HAS_UNSENT_TEXT"],
    [{busy:true},"CHATGPT_STILL_GENERATING"],
    [{composerCount:2},"COMPOSER_MULTIPLE_VISIBLE"],
    [{composerCount:0},"COMPOSER_NOT_FOUND"],
    [{sendDisabled:true},"SEND_BUTTON_DISABLED"],
    [{insertFails:true},"COMPOSER_INSERTION_UNVERIFIED"],
    [{dialog:true},"CHATGPT_DIALOG_OPEN"],
    [{navigateOnType:true},"CHAT_NAVIGATED_DURING_INSERT"]
  ]){
    await withFakePage(input,async x=>{
      const result=await submitToExistingChatGPT("확인하고 계속 진행");
      assert.equal(result.clicked,false);
      assert.equal(result.reason,reason);
      assert.equal(x.clicked(),0);
    });
  }
});
