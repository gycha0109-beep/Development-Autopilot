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
  assert.equal(manifest.version,"0.4.34");
  assert.equal(CHAT_COMPOSER_BUILD,"composer-2026-10-15-r16");
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

test("composer diagnostics do not confuse two visible editors with one explicitly identified prompt",()=>{
  const prev={location:globalThis.location,document:globalThis.document};
  const editor=()=>({tagName:"DIV",isContentEditable:true,textContent:"CONFIDENTIAL",
    getClientRects:()=>[{}],closest:()=>null,contains:()=>false});
  const prompt=editor(),auxiliary=editor();
  globalThis.location={origin:"https://chatgpt.com",pathname:"/g/g-p-project/c/original"};
  globalThis.document={querySelectorAll(selector){
    if(selector==="form" || selector.includes("send-button"))return [];
    if(selector==='#prompt-textarea,[data-testid="prompt-textarea"],textarea[data-testid*="prompt"]')
      return [prompt];
    if(selector.includes("#prompt-textarea"))return [prompt,auxiliary];
    return [];
  }};
  try{
    const result=diagnoseExistingChatGPTComposer();
    assert.equal(result.editableCandidates,2);
    assert.equal(result.explicitPromptEditors,1);
    assert.equal(result.diagnosis,"COMPOSER_FOUND");
    assert.equal(result.selectedComposerProof,"EXACT_PROMPT_EDITOR");
    assert.equal(JSON.stringify(result).includes("CONFIDENTIAL"),false);
  }finally{
    globalThis.location=prev.location;globalThis.document=prev.document;
  }
});

test("read-only editor inventory distinguishes current composer and other visible Writing Block without exposing content",()=>{
  const before={location:globalThis.location,document:globalThis.document,window:globalThis.window};
  let clicks=0;
  const make=(kind,top)=>{
    const attributes=kind==="prompt"?{"id":"prompt-textarea","role":"textbox"}:
      {"data-testid":"writing-block-editor","role":"document"};
    return {
      tagName:"DIV",isContentEditable:true,
      textContent:"PRIVATE_".repeat(10)+kind,
      getClientRects:()=>[{}],
      getBoundingClientRect:()=>({top,bottom:top+50}),
      getAttribute:k=>attributes[k]||null,
      classList:{contains:x=>kind==="writing"&&x==="ProseMirror"},
      contains:()=>false,
      parentElement:null,
      closest:selector=>selector==="form"&&kind==="prompt"?form:
        selector.includes("article")&&kind==="writing"?{}:
        selector.includes("artifact")&&kind==="writing"?{}:null
    };
  };
  let form;
  const prompt=make("prompt",820),writing=make("writing",350);
  form={
    getClientRects:()=>[{}],getAttribute:()=>null,
    querySelectorAll:selector=>selector.includes("textarea")?[prompt]:[],
    contains:x=>x===prompt
  };
  const send={disabled:false,getClientRects:()=>[{}],
    closest:selector=>selector==="form"?form:null,
    click:()=>{clicks++}};
  const main={contains:el=>el===writing};
  globalThis.window={innerHeight:1000};
  globalThis.location={origin:"https://chatgpt.com",
    pathname:"/g/g-p-project/c/test-chat"};
  globalThis.document={
    querySelector:selector=>selector==="main"?main:null,
    querySelectorAll:selector=>{
      if(selector==="form")return [form];
      if(selector==='textarea,[contenteditable="true"]')return [prompt,writing];
      if(selector.includes("send-button"))return [send];
      if(selector==='#prompt-textarea,[data-testid="prompt-textarea"],textarea[data-testid*="prompt"]')
        return [prompt];
      if(selector.includes("#prompt-textarea"))return [prompt,writing];
      return [];
    }
  };
  try{
    const result=diagnoseExistingChatGPTComposer();
    assert.equal(result.eligible,true);
    assert.equal(result.visibleEditableCount,2);
    assert.equal(result.editableInventory.length,2);
    const [first,second]=result.editableInventory;
    assert.equal(first.inExplicitPrompt,true);
    assert.equal(first.promptId,true);
    assert.equal(first.inSendOwnedForm,true);
    assert.equal(first.verticalZone,"bottom");
    assert.equal(first.inMain,false);
    assert.equal(second.inExplicitPrompt,false);
    assert.equal(second.proseMirror,true);
    assert.equal(second.inMessageTurn,true);
    assert.equal(second.insideArtifact,true);
    assert.equal(second.verticalZone,"middle");
    assert.equal(second.inMain,true);
    assert.equal(result.selectedComposerProof,"SEND_FORM_UNIQUE_EDITOR");
    assert.equal(clicks,0);
    const serialized=JSON.stringify(result);
    assert.equal(serialized.includes("PRIVATE_"),false);
    assert.equal(serialized.includes("writing-block-editor"),false);
    assert.equal(serialized.includes("https://chatgpt.com"),false);
  }finally{
    globalThis.location=before.location;
    globalThis.document=before.document;
    globalThis.window=before.window;
  }
});

test("diagnostic preserves both nested visible editable roots rather than hiding an ancestor",()=>{
  const prior={location:globalThis.location,document:globalThis.document};
  const root={
    tagName:"DIV",isContentEditable:true,
    getClientRects:()=>[{}],getAttribute:()=>null,
    contains:child=>child===inner,
    parentElement:null,
    closest:selector=>selector==='[contenteditable="true"]'?root:null,
    querySelectorAll:()=>[inner]
  };
  const inner={
    tagName:"DIV",isContentEditable:true,
    getClientRects:()=>[{}],getAttribute:()=>null,
    contains:()=>false,parentElement:root,
    closest:selector=>selector==='[contenteditable="true"]'?root:null
  };
  globalThis.location={origin:"https://chatgpt.com",pathname:"/c/nested-test"};
  globalThis.document={
    querySelector:()=>null,
    querySelectorAll:selector=>{
      if(selector==="textarea,[contenteditable=\"true\"]")return [root,inner];
      if(selector.includes("#prompt-textarea"))return [root,inner];
      return [];
    }
  };
  try{
    const result=diagnoseExistingChatGPTComposer();
    assert.equal(result.visibleEditableCount,2);
    assert.equal(result.canonicalEditableCount,1);
    assert.equal(result.editableInventory.length,2);
    assert.equal(result.editableInventory[1].nestedEditable,true);
  }finally{
    globalThis.location=prior.location;
    globalThis.document=prior.document;
  }
});
