import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {clickVerifiedDisconnectStop} from "../extension/disconnect-page.js";
const operationId="12345678-1234-4234-8234-123456789abc",path="/c/owned-recovery";
function fixture(patch={}){
  let clicks=0;const form={dataset:{},contains:el=>el===editor};
  const base={getClientRects:()=>[{}],closest:selector=>selector==="form"?form:null,getAttribute:()=>null};
  const editor={...base,tagName:"DIV",childNodes:patch.draft?[{nodeType:3,length:1}]:[]};
  const stop={...base,disabled:!!patch.disabled,click:()=>{clicks++;if(patch.throwAfterClick)throw Error("uncertain click");}};
  const banner={...base,innerText:patch.text||"연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.",
    querySelector:()=>patch.quote?{}:null,closest:()=>patch.transcript?{}:null};
  const document={querySelectorAll:selector=>selector==='textarea,[contenteditable="true"]'?[editor]:
    selector==='button[data-testid="stop-button"]'?(patch.multipleStops?[stop,stop]:[stop]):
    selector==='[role="alert"]'?(patch.multipleAlerts?[banner,banner]:[banner]):
    selector==='[role="dialog"][aria-modal="true"]'?(patch.modal?[base]:[]):
    selector.startsWith('button[aria-label=')?(patch.lookalike?[base]:[]):[]};
  const context={document,location:{origin:"https://chatgpt.com",pathname:path,...patch.location}};
  const call=(extra={})=>vm.runInNewContext("("+clickVerifiedDisconnectStop.toString()+")",context)
    ({permitted:true,operationId,expectedPath:path,...extra});
  return {call,clicks:()=>clicks};
}
test("serialized Stop writer clicks only a verified error UI once, with intent marker before the effect",()=>{
  const f=fixture();assert.equal(f.call().clicked,true);assert.equal(f.clicks(),1);
  assert.equal(f.call().reason,"STOP_ALREADY_ATTEMPTED");assert.equal(f.clicks(),1);
});
for(const patch of [{draft:true},{disabled:true},{multipleStops:true},{lookalike:true},{modal:true},{quote:true},
  {transcript:true},{multipleAlerts:true},{text:"Usage limit reached"},{text:"Normal generation"},
  {location:{pathname:"/c/other"}},{location:{origin:"https://unrelated.invalid"}}])
test("Stop writer refuses ambiguous, unrelated or restricted UI: "+JSON.stringify(patch),()=>{
  const f=fixture(patch);assert.equal(f.call().clicked,false);assert.equal(f.clicks(),0);
});
test("Stop writer refuses absent explicit permission and never retries a throwing click",()=>{
  const denied=fixture();assert.equal(denied.call({permitted:false}).clicked,false);assert.equal(denied.clicks(),0);
  const f=fixture({throwAfterClick:true});assert.throws(()=>f.call(),/uncertain click/);
  assert.equal(f.call().reason,"STOP_ALREADY_ATTEMPTED");assert.equal(f.clicks(),1);
});
