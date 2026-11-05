import test from "node:test";
import assert from "node:assert/strict";
import {captureLateLimitAssistant} from "../extension/migration-page.js";

const sourcePath="/g/g-p-payment/c/payment-1";
const message="Confirmed payment implementation status, tested changes, outstanding tasks. ".repeat(4);

function verify(options={}){
  const prior={location:globalThis.location,document:globalThis.document};
  const {missingSelection=false,missingSource=false,wrongSelection=false,
    wrongSource=false,duplicateBody=false,streaming=false,missingState=false,
    missingCanonical=false,hasNewerUser=false,hasTrailingDecoration=false,
    busy=false,hideBody=false,wrongPath=false,multipleIds=false}=options;
  const element=(attrs={},extra={})=>({
    nodeType:1,tagName:"DIV",attrs,childNodes:[],
    getClientRects(){return this.hidden?[]:[{}];},
    getAttribute(key){return this.attrs[key]??null;},
    closest(selector){
      if(selector==="main")return this.inMain?{}:null;
      if(selector==='[data-content-search-turn-key]')return this.parentTurn||null;
      if(selector==='[data-markdown-text-style="assistant-message"]')
        return this.canonical?{}:null;
      return null;
    },
    contains(node){return this.descendants?.includes(node)||false;},
    querySelectorAll(selector){return this.queries?.[selector]||[];},
    matches(){return false;},
    ...extra
  });
  const turn=element({"data-content-search-turn-key":"turn-last"},{inMain:true});
  const assistant=element({"data-chatgpt-search-unit-key":"turn-last:0:assistant",
    "data-chatgpt-search-message-ids":multipleIds?"assistant-123 assistant-456":"assistant-123"},
    {parentTurn:turn});
  const body=element({"data-dil-message-id":"assistant-123"},{canonical:!missingCanonical,
    hidden:hideBody,childNodes:[{nodeType:3,data:message}]});
  const selection=element({"data-chatgpt-selection-message-id":
    wrongSelection?"wrong-777":"assistant-123"},{descendants:[body]});
  const source=element({"data-dil-source-message-id":
    wrongSource?"wrong-777":"assistant-123"},{descendants:[body]});
  assistant.queries={
    "[data-dil-message-id]":duplicateBody?[body,element({"data-dil-message-id":"assistant-123"})]:[body],
    "[data-chatgpt-selection-message-id]":missingSelection?[]:[selection],
    "[data-dil-source-message-id]":missingSource?[]:[source]
  };
  const state=element({"data-talvt-turn-state":streaming?"streaming":"complete"},
    {descendants:[assistant]});
  const units=[assistant];
  if(hasTrailingDecoration)units.push(element({"data-chatgpt-search-unit-key":"turn-last:1:toolbar"},
    {parentTurn:turn}));
  if(hasNewerUser)units.push(element({"data-chatgpt-search-unit-key":"turn-last:2:user"},
    {parentTurn:turn}));
  turn.queries={
    "[data-chatgpt-search-unit-key]":units,
    "[data-talvt-turn-state]":missingState?[]:[state]
  };
  globalThis.location={origin:"https://chatgpt.com",
    pathname:wrongPath?"/g/g-p-other/project":sourcePath};
  globalThis.document={
    querySelectorAll(selector){
      if(selector==="[data-content-search-turn-key]")return [turn];
      if(selector.includes("stop-button"))return busy?
        [element({}, {disabled:false})]:[];
      return [];
    }
  };
  try{return captureLateLimitAssistant(18000);}
  finally{
    if(prior.location===undefined)delete globalThis.location;
    else globalThis.location=prior.location;
    if(prior.document===undefined)delete globalThis.document;
    else globalThis.document=prior.document;
  }
}

test("late hard-cap recovery accepts a completed exact assistant without optional wrappers",()=>{
  const full=verify();
  assert.equal(full.ok,true);
  assert.equal(full.messageId,"assistant-123");
  assert.equal(full.body,message.trim());
  for(const opts of [
    {missingSelection:true},{missingSource:true},
    {missingSelection:true,missingSource:true},
    {hasTrailingDecoration:true},
    {missingSelection:true,hasTrailingDecoration:true}
  ]){
    const result=verify(opts);
    assert.equal(result.ok,true,JSON.stringify(opts));
    assert.equal(result.body,message.trim());
  }
});
test("hard-cap proof rejects ambiguity, wrong identity, incomplete reply or wrong conversation",()=>{
  for(const opts of [
    {wrongSelection:true},{wrongSource:true},{duplicateBody:true},
    {streaming:true},{missingState:true},{missingCanonical:true},
    {hasNewerUser:true},{busy:true},{hideBody:true},{wrongPath:true},
    {multipleIds:true}
  ]){
    const result=verify(opts);
    assert.equal(result.ok,false,JSON.stringify(opts));
    assert.equal(Object.hasOwn(result,"body"),false,JSON.stringify(opts));
  }
});
