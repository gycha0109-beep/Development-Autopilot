import test from "node:test";
import assert from "node:assert/strict";
import {inspectUnknownChatError} from "../extension/unknown-error-page.js";
import {
  inspectGenericTransferredChat,inspectGenericFirstReply
} from "../extension/generic-migration-page.js";

function page({project=false,error=true,button=true,quoted=false,
  duplicates=false,path=null}={}){
  const previous={document:globalThis.document,location:globalThis.location};
  const shell={innerText:"Unknown error 새 대화 시작",
    getClientRects:()=>[{}],closest:()=>null,
    querySelector:()=>null,contains:()=>true};
  const alert={innerText:"Unknown error",textContent:"Unknown error",
    parentElement:shell,getClientRects:()=>[{}],
    closest:()=>quoted?{}:null,querySelector:()=>null};
  const btn={innerText:"새 대화 시작",textContent:"새 대화 시작",
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
