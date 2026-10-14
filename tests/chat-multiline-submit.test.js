import test from "node:test";
import assert from "node:assert/strict";
import {submitToExistingChatGPT} from "../extension/chat-page.js";

async function withChatComposer({message,buttons=1,formContainsSend=false},run){
  const before={location:globalThis.location,document:globalThis.document};
  const url=new URL("https://chatgpt.com/g/g-p-test/project");
  globalThis.location={origin:url.origin,pathname:url.pathname};
  let inserted=false,clicks=0;
  const editor={
    tagName:"DIV",isContentEditable:true,innerText:"",textContent:"",
    focus(){},contains:()=>false,getClientRects:()=>[{}],
    closest(selector){return selector==="form"?form:null;}
  };
  const form={
    querySelectorAll(selector){
      if(selector.includes("button"))return [];
      if(selector.includes("textarea")||selector.includes("contenteditable"))return [editor];
      return [];
    },
    contains(el){return el===editor||(formContainsSend&&send.includes(el));},
    getAttribute:()=>null
  };
  const send=Array.from({length:buttons},()=>({
    disabled:false,getClientRects:()=>[{}],closest:()=>null,
    getAttribute:()=>null,
    click(){clicks++}
  }));
  globalThis.document={
    visibilityState:"visible",
    execCommand(command,_,value){
      assert.equal(command,"insertText");
      inserted=true;
      // Simulate a multiline ProseMirror visual representation, which may
      // use extra linebreaks after an auto-inserted paragraph.
      editor.innerText=value.replace(/\n/g,"\n\n");
      editor.textContent=value;
      return true;
    },
    querySelector:()=>null,
    querySelectorAll(selector){
      if(selector.includes("stop-button")||selector.includes('Stop generating'))return [];
      if(selector.includes("#prompt-textarea"))return [editor];
      if(selector==="form")return [form];
      if(selector.includes("send-button")||selector.includes('Send message'))
        return inserted?send:[];
      return [];
    }
  };
  try{
    const response=await run();
    return {response,clicks,inserted};
  }finally{
    globalThis.location=before.location;
    globalThis.document=before.document;
  }
}
test("long multiline migration paste finds the yellow send control outside its editor form and clicks exactly once",async()=>{
  const message="아래 로드맵을 따라 계속 진행하십시오.\n\n## 완료\n1. PR 확인\n2. CI 점검\n\n## 다음 작업\n구현을 계속합니다.";
  const result=await withChatComposer({message},
    ()=>submitToExistingChatGPT(message,"handoff"));
  assert.equal(result.response.clicked,true);
  assert.equal(result.response.reason,"SEND_BUTTON_CLICKED_UNVERIFIED");
  assert.equal(result.clicks,1);
});
test("ambiguous send buttons do not send a lengthy migrated prompt twice",async()=>{
  const message="로드맵을 기반으로 다음 작업을 진행하십시오.\n\n"+ "검증할 사항\n".repeat(9);
  const result=await withChatComposer({message,buttons:2},
    ()=>submitToExistingChatGPT(message,"handoff"));
  assert.equal(result.response.clicked,false);
  assert.equal(result.response.reason,"SEND_BUTTON_MULTIPLE_VISIBLE");
  assert.equal(result.clicks,0);
});
