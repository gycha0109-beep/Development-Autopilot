import test from "node:test";
import assert from "node:assert/strict";
import {clickVerifiedDisconnectStop} from "../extension/disconnect-page.js";
const session="https://chatgpt.com",path="/c/current-conversation";
const op="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function makePage({error="연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.",
    draft=false,missingStop=false,wrongPage=false}={}){
  const previous={document:globalThis.document,location:globalThis.location};
  let clicks=0;
  const basic=(tag,children=[])=>({
    nodeType:1,tagName:tag,childNodes:children,
    getClientRects:()=>[{}],closest:()=>null
  });
  const input=basic("DIV",draft?[{nodeType:3,length:4}]:[]);
  const form={dataset:{},contains:x=>x===input};
  const stop={...basic("BUTTON"),disabled:false,
    getAttribute:()=>null,closest:sel=>sel==="form"?form:null,
    click:()=>{clicks++}};
  const banner={...basic("DIV"),innerText:error.trim(),querySelector:()=>null};
  const sel={
    'textarea,[contenteditable="true"]':[input],
    'button[data-testid="stop-button"]':missingStop?[]:[stop],
    'button[aria-label="Stop generating"],button[aria-label="Stop"]':[],
    '[role="dialog"][aria-modal="true"]':[],
    '[role="alert"]':[banner]
  };
  globalThis.document={querySelectorAll:key=>sel[key]||[]};
  globalThis.location={origin:session,pathname:wrongPage?"/c/wrong":path};
  return {count:()=>clicks,restore:()=>{
    if(previous.document===undefined)delete globalThis.document;
    else globalThis.document=previous.document;
    if(previous.location===undefined)delete globalThis.location;
    else globalThis.location=previous.location;
  }};
}
test("exact disconnected warning authorizes only one Stop click",()=>{
  const f=makePage();
  try{
    const first=clickVerifiedDisconnectStop({permitted:true,operationId:op,
      expectedPath:path});
    assert.equal(first.clicked,true);
    assert.equal(f.count(),1);
    const again=clickVerifiedDisconnectStop({permitted:true,operationId:op,
      expectedPath:path});
    assert.equal(again.clicked,false);
    assert.equal(f.count(),1);
  }finally{f.restore()}
});
test("timeout screen never authorizes Stop",()=>{
  const f=makePage({error:"메시지 전송 시간이 초과되었습니다. 다시 시도하세요."});
  try{
    const result=clickVerifiedDisconnectStop({
      permitted:true,operationId:op,expectedPath:path});
    assert.equal(result.clicked,false);
    assert.equal(result.reason,"STOP_WARNING_UNVERIFIED");
    assert.equal(f.count(),0);
  }finally{f.restore()}
});
test("draft, wrong conversation or absent Stop cannot be bypassed",()=>{
  for(const variant of [{draft:true},{wrongPage:true},{missingStop:true}]){
    const f=makePage(variant);
    try{
      assert.equal(clickVerifiedDisconnectStop({
        permitted:true,operationId:op,expectedPath:path}).clicked,false);
      assert.equal(f.count(),0);
    }finally{f.restore()}
  }
});
