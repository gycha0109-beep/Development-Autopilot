import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {diagnoseExistingChatGPTComposer, CHAT_COMPOSER_BUILD} from "../extension/chat-page.js";

function withDocument(url,config,fn){
  const oldLocation=globalThis.location,oldDocument=globalThis.document;
  const page=new URL(url);
  globalThis.location={origin:page.origin,pathname:page.pathname};
  const visible={getClientRects:()=>[{}],closest:()=>null};
  const editor={
    ...visible,tagName:"DIV",isContentEditable:true,
    // Deliberately simulate a draft; the diagnostic must never read it.
    textContent:"PRIVATE_USER_DRAFT_NEVER_RETURN",
    contains:()=>false
  };
  const wrapper={
    ...visible,isContentEditable:false,tagName:"DIV",
    querySelectorAll:()=>[editor]
  };
  const form={...visible,querySelectorAll:()=>[editor]};
  const send={...visible,disabled:true};
  globalThis.document={
    querySelectorAll:selector=>{
      if(selector.includes("send-button"))return config.send?[send]:[];
      if(selector.includes("#prompt-textarea"))return config.wrapper?[wrapper]:
        config.editor?[editor]:[];
      if(selector==="form")return config.form?[form]:[];
      return [];
    }
  };
  try{return fn()}finally{
    globalThis.location=oldLocation;
    globalThis.document=oldDocument;
  }
}
test("runtime signature appears in manifest and the actual diagnostic worker module",()=>{
  const manifest=JSON.parse(readFileSync(new URL("../extension/manifest.json",import.meta.url),"utf8"));
  assert.equal(manifest.version,"0.4.25");
  assert.equal(CHAT_COMPOSER_BUILD,"composer-2026-10-14-r14");
  const worker=readFileSync(new URL("../extension/background.js",import.meta.url),"utf8");
  assert.match(worker,/AP_CHAT_DIAGNOSE/);
  assert.match(worker,/CHAT_COMPOSER_BUILD/);
  assert.match(worker,/diagnoseExistingChatGPTComposer/);
  const html=readFileSync(new URL("../extension/options.html",import.meta.url),"utf8");
  assert.match(html,/id="chat-diagnose"/);
  assert.match(html,/id="extension-runtime"/);
});
test("diagnostic never submits anything or returns draft text",()=>{
  for(const config of [
    {editor:true,send:true},
    {wrapper:true,send:false},
    {form:true,send:false},
    {}
  ]){
    withDocument("https://chatgpt.com/c/existing",{...config},()=>{
      const result=diagnoseExistingChatGPTComposer();
      assert.equal(result.build,CHAT_COMPOSER_BUILD);
      assert.equal(result.eligible,true);
      assert.ok(result.diagnosis);
      assert.equal(JSON.stringify(result).includes("PRIVATE_USER_DRAFT_NEVER_RETURN"),false);
      assert.equal(Object.hasOwn(result,"url"),false);
    });
  }
});
test("diagnostic identifies new-chat, project landing and existing chat without reading drafts",()=>{
  for(const [url,pageType] of [
    ["https://chatgpt.com/","new"],
    ["https://chatgpt.com/g/g-p-12345-myeongha/project","project-new"],
    ["https://chatgpt.com/g/g-p-12345-myeongha","project-new"],
    ["https://chatgpt.com/c/existing","existing"]
  ]){
    withDocument(url,{editor:true,send:false},()=>{
      const result=diagnoseExistingChatGPTComposer();
      assert.equal(result.eligible,true,url);
      assert.equal(result.pageType,pageType);
      assert.equal(result.editableCandidates,1);
      assert.equal(JSON.stringify(result).includes("PRIVATE_USER_DRAFT_NEVER_RETURN"),false);
    });
  }
});
test("diagnostic blocks non-chat routes before DOM access",()=>{
  for(const url of [
    "https://chatgpt.com/settings",
    "https://chatgpt.com/g/g-p-12345-myeongha/settings",
    "https://chatgpt.com/g/g-other",
    "https://example.com/"
  ]){
    withDocument(url,{},()=>{
      const result=diagnoseExistingChatGPTComposer();
      assert.equal(result.eligible,false,url);
      assert.equal(result.reason,"UNSUPPORTED_CHATGPT_PAGE");
    });
  }
});
