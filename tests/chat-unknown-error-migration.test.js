import test from "node:test";
import assert from "node:assert/strict";
import {inspectUnknownChatError} from "../extension/unknown-error-page.js";
import {
  inspectGenericTransferredChat,inspectGenericFirstReply
} from "../extension/generic-migration-page.js";

function page({project=false,error=true,button=true,quoted=false,
  duplicates=false,path=null,buttonText="새 대화 시작"}={}){
  const previous={document:globalThis.document,location:globalThis.location};
  const shell={innerText:"Unknown error 새 대화 시작",
    getClientRects:()=>[{}],closest:()=>null,
    querySelector:()=>null,contains:()=>true};
  const alert={innerText:"Unknown error",textContent:"Unknown error",
    parentElement:shell,getClientRects:()=>[{}],
    closest:()=>quoted?{}:null,querySelector:()=>null};
  const btn={innerText:buttonText,textContent:buttonText,
    parentElement:shell,disabled:false,getClientRects:()=>[{}],
    closest:()=>null,querySelector:()=>null};
  const buttons=button?(duplicates?[btn,{...btn}]:[btn]):[];
  globalThis.document={
    querySelectorAll:selector=>{
      if(selector.includes("data-testid")&&selector.includes("alert"))
        return error?[alert]:[];
      if(selector==='button,[role="button"]')return buttons;
      return [];
    }
  };
  globalThis.location={origin:"https://chatgpt.com",
    pathname:path||(project?"/g/g-p-abcd123/c/old":"/c/old")};
  return ()=>{if(previous.document===undefined)delete globalThis.document;
    else globalThis.document=previous.document;
    if(previous.location===undefined)delete globalThis.location;
    else globalThis.location=previous.location;};
}
test("Unknown error must have exact visible banner and related new chat action",()=>{
  const restore=page();
  try{
    const result=inspectUnknownChatError();
    assert.equal(result.fatal,true);
    assert.equal(result.eligible,true);
    assert.equal(result.projectId,null);
    assert.equal(result.sourcePath,"/c/old");
  }finally{restore();}
});
test("Unknown error in a project preserves exact project identity",()=>{
  const restore=page({project:true});
  try{
    assert.equal(inspectUnknownChatError().projectId,"g-p-abcd123");
  }finally{restore();}
});
test("quoted error, missing action and duplicate actions never trigger",()=>{
  for(const options of [{quoted:true},{button:false},{error:false},{duplicates:true},
    {path:"/"}]){
    const restore=page(options);
    try{assert.equal(inspectUnknownChatError().fatal,false);}
    finally{restore();}
  }
});
test("handoff verifier rejects a new chat outside the original project",()=>{
  let restore=page({path:"/c/outside"});
  try{
    assert.equal(inspectGenericTransferredChat("AUTOPILOT_GENERIC_CHAT_HANDOFF",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","g-p-abcd123").ok,false);
    assert.equal(inspectGenericFirstReply("AUTOPILOT_GENERIC_CHAT_HANDOFF",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","g-p-abcd123").ok,false);
  }finally{restore();}
  restore=page({path:"/g/g-p-another/c/foreign"});
  try{
    assert.equal(inspectGenericTransferredChat("AUTOPILOT_GENERIC_CHAT_HANDOFF",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","g-p-abcd123").ok,false);
  }finally{restore();}
});

test("current DIL project chat proves the transferred handoff and completed first reply",()=>{
  const marker="AUTOPILOT_GENERIC_CHAT_HANDOFF";
  const nonce="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const original={location:globalThis.location,document:globalThis.document};
  let complete=true,foreign=false,otherUser=false,wrongId=false,busy=false;
  const handoff=marker+" "+nonce+" Original decisions, next work and evidence. ".repeat(12);
  const reply="The verified next operation is to inspect the existing roadmap. ".repeat(5);
  const state={
    getClientRects:()=>[{}],
    getAttribute:key=>key==="data-talvt-turn-state"?(complete?"complete":"streaming"):null,
    contains:el=>el===assistant
  };
  const body={
    innerText:reply,textContent:reply,getClientRects:()=>[{}],
    getAttribute:key=>key==="data-dil-message-id"?(wrongId?"other-777":"message-123"):null,
    closest:selector=>selector==='[data-markdown-text-style="assistant-message"]'?{}:null
  };
  const user={
    innerText:handoff,textContent:handoff,getClientRects:()=>[{}],
    getAttribute:key=>key==="data-chatgpt-search-unit-key"?"turn-a:0:user":null,
    closest:selector=>selector==="[data-content-search-turn-key]"?turn:null
  };
  const assistant={
    getAttribute:key=>key==="data-chatgpt-search-unit-key"?"turn-a:1:assistant":
      key==="data-chatgpt-search-message-ids"?"message-123":null,
    querySelectorAll:selector=>selector==="[data-dil-message-id]"?[body]:[],
    closest:selector=>selector==="[data-content-search-turn-key]"?turn:null
  };
  const turn={
    getAttribute:key=>key==="data-content-search-turn-key"?"turn-a":null,
    querySelectorAll:selector=>selector==="[data-chatgpt-search-unit-key]"?
      [user,assistant,...(otherUser?[user]:[])]:
      selector==="[data-talvt-turn-state]"?[state]:[]
  };
  const main={contains:el=>el===turn};
  globalThis.location={origin:"https://chatgpt.com",
    pathname:"/g/g-p-abcd123/c/new-chat"};
  globalThis.document={
    querySelector:selector=>selector==="main"?main:null,
    querySelectorAll:selector=>selector==="[data-content-search-turn-key]"?
      [turn]:selector.includes("stop-button")&&busy?
      [{disabled:false,getClientRects:()=>[{}]}]:[]
  };
  try{
    assert.deepEqual(inspectGenericTransferredChat(marker,nonce,"g-p-abcd123"),
      {ok:true,source:"EXACT_TRANSFER_USER_TURN"});
    const accepted=inspectGenericFirstReply(marker,nonce,"g-p-abcd123");
    assert.equal(accepted.ok,true);
    assert.match(accepted.replyFingerprint,/^\d+:[a-f0-9]+$/);
    assert.equal(JSON.stringify(accepted).includes(reply),false);
    complete=false;
    assert.equal(inspectGenericFirstReply(marker,nonce,"g-p-abcd123").ok,false);
    complete=true;wrongId=true;
    assert.equal(inspectGenericFirstReply(marker,nonce,"g-p-abcd123").ok,false);
    wrongId=false;otherUser=true;
    assert.equal(inspectGenericFirstReply(marker,nonce,"g-p-abcd123").ok,false);
    otherUser=false;busy=true;
    assert.equal(inspectGenericFirstReply(marker,nonce,"g-p-abcd123").ok,false);
    busy=false;foreign=true;
    globalThis.location.pathname="/g/g-p-other/c/new-chat";
    assert.equal(inspectGenericFirstReply(marker,nonce,"g-p-abcd123").ok,false);
  }finally{
    if(original.document===undefined)delete globalThis.document;
    else globalThis.document=original.document;
    if(original.location===undefined)delete globalThis.location;
    else globalThis.location=original.location;
  }
});

test("real Korean and English Unknown error action labels are detected",()=>{
  for(const buttonText of ["새 대화 시작","새 채팅 시작",
    "Start new chat","New chat","Start a new chat"]){
    const restore=page({buttonText});
    try{
      const result=inspectUnknownChatError();
      assert.equal(result.eligible,true,buttonText);
      assert.equal(result.reason,"UNKNOWN_ERROR_NEW_CHAT_REQUIRED");
    }finally{restore();}
  }
});
test("an unrelated visible new-chat button does not satisfy the error action",()=>{
  const restore=page({buttonText:"채팅 삭제"});
  try{assert.equal(inspectUnknownChatError().eligible,false);}
  finally{restore();}
});
