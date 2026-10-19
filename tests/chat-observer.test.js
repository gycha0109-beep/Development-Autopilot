import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {webcrypto} from "node:crypto";
import {captureChatObservation} from "../extension/chat-observer.js";
import {observeRegisteredChat, classifyObservation} from "../local/chat-observation.js";

// Owned synthetic DOM. No external accounts, dependency install, or Chrome.
class Element {
  constructor(tag,attrs={},children=[]) {
    this.nodeType=1; this.tagName=tag.toUpperCase(); this.attrs=attrs;
    this.childNodes=children.map(child => typeof child === "string" ?
      {nodeType:3,data:child,length:child.length} : child);
    this.disabled=attrs.disabled === true;
    for (const child of this.childNodes) child.parent=this;
  }
  getAttribute(key) { return this.attrs[key] ?? null; }
  getClientRects() { return this.attrs.hidden ? [] : [{}]; }
  matches(selectors) {
    return selectors.split(",").some(selector => {
      if (selector === ":placeholder-shown") return this.attrs.placeholderShown === true;
      const tag=selector.match(/^[a-z]+/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const attributes=[...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
      return !!(tag || attributes.length) && attributes.every(([,key,value]) =>
        value === undefined ? Object.hasOwn(this.attrs,key) : this.attrs[key] === value);
    });
  }
  closest(selector) {
    for (let node=this; node; node=node.parent) if (node.nodeType===1 && node.matches(selector)) return node;
    return null;
  }
  contains(other) { for (let node=other;node;node=node.parent) if (node===this) return true; return false; }
  querySelectorAll(selector) {
    const all=[];
    const visit=node=>{ for (const child of node.childNodes || []) {
      if (child.nodeType===1) { if (child.matches(selector)) all.push(child); visit(child); }
    }};
    visit(this); return all;
  }
}
const el=(...args)=>new Element(...args);
const registration={workstreamId:"work-a",sessionKey:"session-a",tabId:11,windowId:2,groupId:3,
  url:"https://chatgpt.com/g/g-p-owned-project/c/owned-conversation"};
const live = r => ({id:r.tabId,windowId:r.windowId,groupId:r.groupId,url:r.url});
const policy={now:2000,stableForMs:500,maxAgeMs:5000};
function fixture(options={}) {
  const editor=el("div",{contenteditable:"true"},options.draft ? ["PRIVATE_DRAFT"] : []);
  // Even accidental value/text/HTML inspection must fail. Only length is safe.
  for (const name of ["value","textContent","innerText","innerHTML"]) {
    Object.defineProperty(editor,name,{get(){throw new Error("PRIVATE_DRAFT_READ");},set(){throw new Error("MUTATION");}});
  }
  if (options.draft) Object.defineProperty(editor.childNodes[0],"data",{get(){throw new Error("PRIVATE_DRAFT_READ");}});
  const button=el("button",{"data-testid":options.busy?"stop-button":"send-button"});
  const form=el("form",{},[editor,button]);
  const assistant=el("div",{"data-message-author-role":"assistant","data-message-id":"turn-a"},
    options.children || [options.text || "作業内容 PRIVATE_ASSISTANT_BODY"]);
  if (options.roleless) delete assistant.attrs["data-message-author-role"];
  const body=el("body",{},[assistant,form,...(options.extra || [])]);
  if (options.afterUser) { const user=el("div",{"data-message-author-role":"user"},["PRIVATE_USER_BODY"]); user.parent=body; body.childNodes.push(user); }
  const doc={visibilityState:"visible",querySelectorAll:selector=>body.querySelectorAll(selector)};
  // Guard side-effect surfaces at every node.
  for (const node of [body,...body.querySelectorAll("div,button,form,textarea")]) {
    for (const name of ["click","focus","dispatchEvent","append","remove","setAttribute"])
      node[name]=()=>{throw new Error("MUTATION:"+name);};
  }
  return {doc,body,editor,assistant,button};
}
async function capture(f,request) {
  // Reproduce Chrome function serialization: no imported lexical helpers.
  return await vm.runInNewContext(`(${captureChatObservation.toString()})(request)`,{
    request,document:f.doc,location:new URL(registration.url),crypto:webcrypto,TextEncoder
  });
}
async function observe(f,at=1000,extra={}) {
  return observeRegisteredChat({registration,getLiveTab:async()=>live(registration),
    readPage:(_tab,request)=>capture(f,request),permitted:true,now:()=>at,...extra});
}
async function classifyFixture(options={}) {
  const f=fixture(options);
  const first=await observe(f,1000), second=await observe(f,2000);
  return {first,second,result:classifyObservation(second,{...policy,previous:first})};
}

test("normal completed response requires two fresh unchanged observations; no raw bodies escape",async()=>{
  const {first,second,result}=await classifyFixture();
  assert.equal(classifyObservation(first,policy).reasonCode,"RESPONSE_STABILIZING");
  assert.equal(result.state,"RESPONSE_COMPLETE");
  assert.match(second.replyFingerprint,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify({first,second,result}),/PRIVATE_|https:|owned-conversation|turn-a/);
  assert.equal(Object.hasOwn(result,"nextAction"),false);
});

function currentRenderer(options={}){
  const f=fixture(options),id="reply-current";
  const body=el("div",{"data-dil-message-id":id},options.children||[options.text||"PRIVATE_CURRENT_RESPONSE"]);
  const source=el("div",{"data-dil-source-message-id":options.wrongId?"wrong":id},[body]);
  const style=el("div",{"data-markdown-text-style":"assistant-message"},[source]);
  const selection=el("div",{"data-chatgpt-selection-message-id":id},[style]);
  const unit=el("div",{"data-chatgpt-search-unit-key":"turn-current:2:assistant","data-chatgpt-search-message-ids":id+" "+id},[selection]);
  const state=el("div",{"data-talvt-turn-state":options.state||"complete"},[unit]);
  const turn=el("div",{"data-content-search-turn-key":"turn-current"},[state]);
  const form=f.editor.parent;
  form.attrs["data-chatgpt-composer"]="";form.attrs["data-composer-placement"]="thread";
  delete f.button.attrs["data-testid"];f.button.attrs["aria-label"]="음성 대화 시작";
  const main=el("main",{},[turn,form,...(options.extra||[])]);
  f.body.childNodes=[main];main.parent=f.body;
  if(options.afterUser){const user=el("div",{"data-chatgpt-search-unit-key":"turn-current:3:user"},["PRIVATE_USER_BODY"]);user.parent=state;state.childNodes.push(user);}
  if(options.noState)delete state.attrs["data-talvt-turn-state"];
  if(options.unowned)delete form.attrs["data-chatgpt-composer"];
  if(options.conflict){f.assistant.parent=main;main.childNodes.push(f.assistant);}
  return f;
}

test("current live renderer requires corroborated assistant identity, explicit complete state and stable repeated observations",async()=>{
  const f=currentRenderer(),first=await observe(f,1000),second=await observe(f,2000);
  assert.equal(second.assistantBusy,false);assert.equal(second.composerHasDraft,false);
  assert.equal(second.contentComplete,true);assert.equal(second.uiAmbiguous,false);
  assert.equal(classifyObservation(first,policy).state,"UNKNOWN");
  assert.equal(classifyObservation(second,{...policy,previous:first}).state,"RESPONSE_COMPLETE");
  assert.doesNotMatch(JSON.stringify({first,second}),/PRIVATE_|reply-current|turn-current/);
});

for(const [name,options] of [
  ["mismatched message IDs",{wrongId:true}],["missing completion state",{noState:true}],
  ["unanswered last user unit",{afterUser:true}],["unowned composer",{unowned:true}],
  ["mixed contradictory renderers",{conflict:true}],["streaming state",{state:"streaming"}],
  ["unknown provider state",{state:"unknown"}],["draft present",{draft:true}],
  ["second editable",{extra:[el("div",{contenteditable:"true"},["PRIVATE_OTHER"])]}]
])test("current renderer blocks automatic completion for "+name,async()=>{
  const f=currentRenderer(options),first=await observe(f,1000),second=await observe(f,2000);
  assert.notEqual(classifyObservation(second,{...policy,previous:first}).state,"RESPONSE_COMPLETE");
  assert.doesNotMatch(JSON.stringify(second),/PRIVATE_|reply-current|turn-current/);
});

test("current renderer retains CI/human gates and ignores quoted warnings",async()=>{
  for(const [options,expected] of [
    [{text:"CI가 장기 실행 중이므로 대기 중입니다"},"CI_WAIT_CUE"],
    [{text:"로컬 Windows 테스트가 필요합니다"},"WAIT_HUMAN"],
    [{children:[el("blockquote",{},[el("div",{role:"alert"},["연결이 해제되었습니다. 전체 답변을 기다리는 중입니다."])]),"PRIVATE_OK"]},"RESPONSE_COMPLETE"]
  ]){
    const f=currentRenderer(options),first=await observe(f,1000),second=await observe(f,2000);
    assert.equal(classifyObservation(second,{...policy,previous:first}).state,expected);
  }
});

for (const [name,options,state,reason] of [
  ["streaming response",{busy:true},"GENERATING","ASSISTANT_GENERATING"],
  ["visible user draft",{draft:true},"UNKNOWN","USER_DRAFT_PRESENT"],
  ["CI waiting cue is no CI proof",{text:"CI가 장기 실행 중이므로 대기 중입니다"},"CI_WAIT_CUE","EXACT_CI_LOOKUP_REQUIRED"],
  ["human approval request",{text:"변경하려면 승인이 필요합니다"},"WAIT_HUMAN","HUMAN_ACTION_CUE"],
  ["local Windows test request",{text:"로컬 Windows 테스트가 필요합니다"},"WAIT_HUMAN","HUMAN_ACTION_CUE"],
  ["additional cost request",{text:"다음 단계에서 추가 비용이 발생합니다"},"WAIT_HUMAN","HUMAN_ACTION_CUE"],
  ["role-less DOM",{roleless:true},"UNKNOWN","RESPONSE_COMPLETION_UNPROVEN"],
  ["newer unanswered user turn",{afterUser:true},"UNKNOWN","RESPONSE_COMPLETION_UNPROVEN"],
  ["multiple visible editables",{extra:[el("div",{contenteditable:"true"},["PRIVATE_OTHER_EDITOR"])]},"UNKNOWN","COMPOSER_DRAFT_UNKNOWN"],
  ["disconnect alert remains ahead of busy",{busy:true,extra:[el("div",{role:"alert"},["연결이 해제되었습니다. 전체 답변을 기다리는 중입니다."])]},"DISCONNECTED","CONNECTION_WARNING_OBSERVED"],
  ["length alert",{extra:[el("div",{role:"alert"},["이 대화의 최대 길이에 도달했습니다"])]},"LENGTH_LIMIT","LENGTH_WARNING_OBSERVED"],
  ["generic failure banner",{extra:[el("div",{role:"alert"},["Something went wrong"])]},"UNKNOWN","UI_AMBIGUOUS"],
  ["quota is no disconnect recovery",{busy:true,extra:[el("div",{role:"alert"},["Usage limit reached"])]},"WAIT_HUMAN","PROVIDER_RESTRICTION"],
  ["quota in a disconnect banner still blocks recovery",{busy:true,extra:[el("div",{role:"alert"},["연결이 해제되었습니다. 전체 답변을 기다리는 중입니다. Usage limit reached"])]},"WAIT_HUMAN","PROVIDER_RESTRICTION"],
  ["contradictory length and CI",{text:"CI running",extra:[el("div",{role:"alert"},["이 대화의 최대 길이에 도달했습니다"])]},"UNKNOWN","CONFLICTING_SIGNALS"],
  ["lookalike stop is no verified control",{extra:[el("button",{"aria-label":"Stop generating"})]},"UNKNOWN","UI_AMBIGUOUS"],
  ["editable Writing Block",{children:["summary",el("div",{contenteditable:"true"},["PRIVATE_WRITING_DRAFT"])]},"UNKNOWN","COMPOSER_DRAFT_UNKNOWN"],
  ["collapsed Writing Block",{children:["summary",el("div",{hidden:true},["PRIVATE_HIDDEN_BODY"])]},"UNKNOWN","RESPONSE_COMPLETION_UNPROVEN"]
]) test(name,async()=>{
  const {second,result}=await classifyFixture(options);
  assert.equal(result.state,state); assert.equal(result.reasonCode,reason);
  assert.doesNotMatch(JSON.stringify({second,result}),/PRIVATE_|https:|owned-conversation/);
  if(name==="additional cost request")assert.equal(second.humanActionCategory,"cost");
  if(name==="local Windows test request")assert.equal(second.humanActionCategory,"local_test");
});

test("quoted warning, CI and approval instructions cannot become external cues",async()=>{
  for (const tag of ["blockquote","pre","code","q"]) {
    const {second,result}=await classifyFixture({children:["Normal response",el(tag,{role:"alert"},[
      "연결이 해제되었습니다. 전체 답변을 기다리는 중입니다. CI running; approval required"])]});
    assert.equal(second.connectionWarning,false); assert.equal(second.ciWaitCue,false);
    assert.equal(second.humanActionCue,false); assert.equal(result.state,"RESPONSE_COMPLETE");
  }
  const {second}=await classifyFixture({text:"연결이 해제되었습니다. 전체 답변을 기다리는 중입니다."});
  assert.equal(second.connectionWarning,false);
});

test("hidden warnings and unrelated stop buttons provide no recovery authority",async()=>{
  const {second}=await classifyFixture({extra:[el("div",{role:"alert",hidden:true},[
    "연결이 해제되었습니다. 전체 답변을 기다리는 중입니다."]),el("button",{"data-testid":"stop-button"})]});
  assert.equal(second.connectionWarning,false); assert.equal(second.stopControlVerified,false);
  assert.equal(second.assistantBusy,null);
});

test("changing or absent response identity and virtualized content never stabilize",async()=>{
  const f=fixture(), first=await observe(f,1000);
  f.assistant.childNodes[0].data="Updated response";
  let second=await observe(f,2000);
  assert.equal(classifyObservation(second,{...policy,previous:first}).reasonCode,"RESPONSE_STABILIZING");
  delete f.assistant.attrs["data-message-id"];
  second=await observe(f,2000);
  assert.equal(classifyObservation(second,{...policy,previous:first}).state,"UNKNOWN");
});

test("stale, future, repeated, rapid and cross-session samples do not prove completion",async()=>{
  const {first,second}=await classifyFixture();
  for (const previous of [second,{...first,observedAt:1900},{...first,bindingFingerprint:"a".repeat(64)},
    {...first,assistantBusy:true},{...first,composerHasDraft:true},{...first,observedAt:0}]) {
    assert.equal(classifyObservation(second,{...policy,previous, maxAgeMs:1500}).state,"UNKNOWN");
  }
  for (const current of [{...second,observedAt:3000},{...second,observedAt:0}])
    assert.equal(classifyObservation(current,{...policy,previous:first,maxAgeMs:1500}).reasonCode,"OBSERVATION_STALE");
  assert.equal(classifyObservation(second).reasonCode,"INVALID_OBSERVATION_POLICY");
});

test("no permission or wrong tab/window/group/conversation prevents DOM read",async()=>{
  let reads=0;
  const f=fixture();
  const neverRead=()=>{reads++; throw new Error("must not read");};
  assert.equal((await observe(f,1000,{permitted:false,readPage:neverRead})).reasonCode,"OBSERVATION_NOT_PERMITTED");
  for (const override of [{id:22},{windowId:9},{groupId:9},{url:registration.url+"-other"}]) {
    const result=await observe(f,1000,{getLiveTab:async()=>({...live(registration),...override}),readPage:neverRead});
    assert.equal(result.reasonCode,"REGISTERED_TAB_MISMATCH");
  }
  assert.equal(reads,0);
});

test("navigation during observation discards the result and does not retry",async()=>{
  let reads=0,tabReads=0;
  const f=fixture();
  const result=await observe(f,1000,{getLiveTab:async()=>({...live(registration),
    url:++tabReads===1?registration.url:registration.url+"-new"}),
    readPage:async(_id,req)=>{reads++;return capture(f,req);}});
  assert.equal(result.reasonCode,"REGISTERED_TAB_CHANGED"); assert.equal(reads,1);
});

test("IPC strips arbitrary private fields; malformed and unavailable snapshots stay unknown",async()=>{
  const f=fixture();
  const result=await observe(f,1000,{readPage:async(_id,req)=>({...await capture(f,req),
    rawText:"PRIVATE_IPC_BODY",url:"https://private.invalid",extra:{token:"PRIVATE_TOKEN"}})});
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|https:/);
  for (const patch of [{assistantBusy:"false"},{humanActionCue:undefined},{bindingFingerprint:"a".repeat(64)},
    {schemaVersion:2},{sourceVersion:"unknown-source"},{verified:false,reasonCode:"PRIVATE_ERROR"}]) {
    const invalid=await observe(f,1000,{readPage:async(_id,req)=>({...await capture(f,req),...patch})});
    assert.equal(invalid.verified,false); assert.doesNotMatch(JSON.stringify(invalid),/PRIVATE_/);
  }
  assert.equal((await observe(f,1000,{readPage:()=>{throw new Error("PRIVATE_ERROR");}})).reasonCode,"OBSERVATION_UNAVAILABLE");
});

test("collector blocks wrong paths before DOM and survives unsupported DOM without exception leaks",async()=>{
  const f=fixture(),bindingFingerprint="a".repeat(64);
  f.doc.querySelectorAll=()=>{throw new Error("PRIVATE_DOM_ERROR");};
  assert.equal((await capture(f,{permitted:true,expectedPath:"/c/wrong",bindingFingerprint})).reasonCode,"CONVERSATION_MISMATCH");
  assert.equal((await capture(f,{permitted:false})).reasonCode,"OBSERVATION_NOT_PERMITTED");
  const failed=await capture(f,{permitted:true,expectedPath:new URL(registration.url).pathname,bindingFingerprint});
  assert.equal(failed.reasonCode,"DOM_OBSERVATION_FAILED");
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_/);
});

test("missing fields and oversized/unknown content fail closed",async()=>{
  const {first,second}=await classifyFixture();
  for (const key of ["assistantBusy","composerHasDraft","uiAmbiguous","otherWarning","humanActionCue",
    "contentComplete","stopControlVerified","ciWaitCue","scopeCompleteCue","connectionWarning",
    "lengthWarning","providerRestriction"]) {
    const malformed={...second}; delete malformed[key];
    assert.equal(classifyObservation(malformed,{...policy,previous:first}).state,"UNKNOWN",key);
  }
  const huge=await classifyFixture({text:"x".repeat(32001)});
  assert.equal(huge.result.state,"UNKNOWN"); assert.equal(huge.second.replyFingerprint,null);
  assert.equal(classifyObservation({...second,stopControlVerified:true},{...policy,previous:first}).reasonCode,"CONFLICTING_SIGNALS");
});
