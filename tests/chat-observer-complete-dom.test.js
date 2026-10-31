import test from "node:test";
import assert from "node:assert/strict";
import {captureChatObservation} from "../extension/chat-observer.js";

const BINDING="b".repeat(64);
const PAGE="/g/g-p-fixture-pie/c/fixture-conversation";

function visibleElement(tag="DIV",attrs={}){
  return {
    nodeType:1,tagName:tag,attrs,childNodes:[],hiddenForTest:false,
    getClientRects(){return this.hiddenForTest?[]:[{}]},
    getAttribute(name){return this.attrs[name]??null},
    matches(selector){
      const tag=this.tagName.toLowerCase();
      return selector.split(",").some(s=>s.trim()===tag)||
        (selector.includes('[contenteditable="true"]')&&this.attrs.contenteditable==="true");
    },
    closest(selector){
      if(selector==="main")return this.withinMain?{}:null;
      if(selector==='[data-content-search-turn-key]')return this.parentTurn||null;
      if(selector==='[data-markdown-text-style="assistant-message"]')return this.messageContainer?{}:null;
      if(selector==="form")return this.parentForm||null;
      return null;
    },
    contains(target){return this.descendants?.includes(target)||false},
    querySelectorAll(selector){return this.queries?.[selector]||[]}
  };
}
function text(value){return {nodeType:3,data:value,length:value.length};}
function fixture({chunks=2300,hidden=true,unsafe=false,message="검증 완료",
  preview=false,streaming=false,duplicateComposer=false,threadDraft=false,
  permission=false,quotedPermission=false,missingSelection=false,missingSource=false,
  trailingDecoration=false,trailingUser=false,duplicateBody=false,mismatchedSource=false,
  noCanonicalBody=false}={}){
  const editor=visibleElement("DIV",{contenteditable:"true"}),form=visibleElement("FORM");
  form.descendants=[editor];
  if(threadDraft)editor.childNodes=[text("사용자가 입력한 초안")];
  const previewEditor=visibleElement("DIV",{contenteditable:"true"});
  previewEditor.childNodes=[text("미리보기 스프레드시트에 있는 텍스트")];
  const previewStop=visibleElement("BUTTON");
  const previewSend=visibleElement("BUTTON");
  const threadStop=visibleElement("BUTTON");
  threadStop.disabled=false;
  if(streaming)form.descendants.push(threadStop);
  const body=visibleElement("DIV",{"data-dil-message-id":"assistant-msg-fixture"});
  body.messageContainer=!noCanonicalBody;
  const selection=visibleElement("DIV",{"data-chatgpt-selection-message-id":"assistant-msg-fixture"});
  const source=visibleElement("DIV",{"data-dil-source-message-id":"assistant-msg-fixture"});
  selection.descendants=[body];source.descendants=[body];
  for(let i=0;i<chunks;i++){
    const span=visibleElement("SPAN");
    span.childNodes=[text(message)];
    body.childNodes.push(span);
  }
  if(hidden){
    const tooltip=visibleElement("SPAN");
    tooltip.hiddenForTest=true;
    tooltip.childNodes=[text("이 텍스트는 화면에 나타나지 않습니다")];
    body.childNodes.push(tooltip);
  }
  if(unsafe)body.childNodes.push(visibleElement("INPUT"));
  const turn=visibleElement("DIV",{"data-content-search-turn-key":"fixture-turn"});
  turn.withinMain=true;
  const unit=visibleElement("DIV",{
    "data-chatgpt-search-unit-key":"fixture-turn:0:assistant",
    "data-chatgpt-search-message-ids":"assistant-msg-fixture"
  });
  unit.parentTurn=turn;
  if(mismatchedSource)source.attrs["data-dil-source-message-id"]="wrong-id";
  unit.queries={
    "[data-dil-message-id]":duplicateBody?[body,body]:[body],
    "[data-chatgpt-selection-message-id]":missingSelection?[]:[selection],
    "[data-dil-source-message-id]":missingSource?[]:[source]
  };
  const state=visibleElement("DIV",{"data-talvt-turn-state":streaming?"streaming":"complete"});
  state.descendants=[unit];
  turn.queries={"[data-talvt-turn-state]":[state]};
  const permissionCard=visibleElement("DIV");
  permissionCard.innerText="ChatGPT가 Remote Desktop Commander을(를) 사용하도록 허용할까요? Windows 장치에서 작업에 접근하도록 요청합니다. 항상 허용 거부 한 번만 허용";
  const permissionButtons=["항상 허용","거부","한 번만 허용"].map(label=>{
    const el=visibleElement("BUTTON");
    el.innerText=label;
    el.parentElement=permissionCard;
    if(quotedPermission)el.closest=selector=>
      selector.includes("pre,code")?{}:null;
    return el;
  });
  permissionCard.contains=el=>permissionButtons.includes(el);
  const selectors={
    button:permission?permissionButtons:[],
    'textarea,[contenteditable="true"]':preview?[editor,previewEditor]:[editor],
    "[data-message-author-role]":[],
    "[data-content-search-turn-key]":[turn],
    "[data-chatgpt-search-unit-key]":[unit,
      ...(trailingDecoration||trailingUser?[Object.assign(
        visibleElement("DIV",{"data-chatgpt-search-unit-key":
          trailingUser?"fixture-turn:1:user":"fixture-turn:1:decoration"}),
        {parentTurn:turn})]:[])],
    'form[data-chatgpt-composer][data-composer-placement="thread"]':duplicateComposer?[form,visibleElement("FORM")]:[form],
    'button[data-testid="stop-button"]':streaming?[threadStop]:preview?[previewStop]:[],
    'button[aria-label="Stop generating"],button[aria-label="Stop"]':[],
    'button[data-testid="send-button"],button[data-testid="composer-send-button"]':preview?[previewSend]:[],
    '[role="alert"]':[]
  };
  return {
    visibilityState:"visible",
    querySelectorAll(selector){return selectors[selector]||[]}
  };
}
async function inspect(doc){
  globalThis.document=doc;
  return captureChatObservation({permitted:true,expectedPath:PAGE,bindingFingerprint:BINDING});
}
test("actual tool-permission controls block continuation without reading command arguments",async()=>{
  const oldDocument=globalThis.document,oldLocation=globalThis.location;
  globalThis.location={origin:"https://chatgpt.com",pathname:PAGE};
  try{
    const live=await inspect(fixture({chunks:9,permission:true}));
    assert.equal(live.verified,true);
    assert.deepEqual(live.toolApproval,{observed:true,pending:true,
      kind:"tool_permission",tool:"Remote Desktop Commander"});
    assert.equal(live.humanActionCue,true);
    assert.equal(live.humanActionCategory,"tool_permission");
    const json=JSON.stringify(live);
    assert.equal(json.includes("Windows 장치"),false);
    const quoted=await inspect(fixture({chunks:9,permission:true,quotedPermission:true}));
    assert.equal(quoted.toolApproval.pending,false);
    assert.equal(quoted.humanActionCue,false);
    const clear=await inspect(fixture({chunks:9}));
    assert.equal(clear.toolApproval.pending,false);
    assert.equal(clear.toolApproval.observed,true);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;
  }
});
test("preview panel editors and toolbar buttons cannot poison the thread-completion proof",async()=>{
  const oldDocument=globalThis.document,oldLocation=globalThis.location;
  globalThis.location={origin:"https://chatgpt.com",pathname:PAGE};
  try{
    const clean=await inspect(fixture({chunks:10,preview:false}));
    const withPreview=await inspect(fixture({chunks:10,preview:true}));
    assert.equal(withPreview.verified,true);
    assert.equal(withPreview.uiAmbiguous,false);
    assert.equal(withPreview.assistantBusy,false);
    assert.equal(withPreview.composerHasDraft,false);
    assert.equal(withPreview.contentComplete,true);
    assert.equal(withPreview.stopControlVerified,false);
    assert.equal(withPreview.diagnostic.threadEditors,1);
    assert.equal(withPreview.diagnostic.ignoredOutsideEditors,1);
    assert.equal(withPreview.replyFingerprint,clean.replyFingerprint);

    const drafting=await inspect(fixture({chunks:10,preview:true,threadDraft:true}));
    assert.equal(drafting.composerHasDraft,true);
    const streaming=await inspect(fixture({chunks:10,preview:true,streaming:true}));
    assert.equal(streaming.assistantBusy,true);
    assert.equal(streaming.stopControlVerified,true);
    const ambiguous=await inspect(fixture({chunks:10,preview:true,duplicateComposer:true}));
    assert.equal(ambiguous.uiAmbiguous,true);
    assert.equal(ambiguous.composerHasDraft,null);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;
  }
});

test("long completed assistant DOM with hidden elements is valid and digest remains stable",async()=>{
  const oldDocument=globalThis.document,oldLocation=globalThis.location;
  globalThis.location={origin:"https://chatgpt.com",pathname:PAGE};
  try{
    const a=await inspect(fixture());
    assert.equal(a.verified,true);
    assert.equal(a.assistantBusy,false);
    assert.equal(a.contentComplete,true);
    assert.equal(a.composerHasDraft,false);
    assert.equal(a.uiAmbiguous,false);
    assert.ok(a.diagnostic.hiddenSkipped>=2);
    assert.equal(a.diagnostic.traversalIncomplete,false);
    assert.match(a.replyFingerprint,/^[a-f0-9]{64}$/);

    const b=await inspect(fixture());
    assert.equal(a.replyFingerprint,b.replyFingerprint);
    const changed=await inspect(fixture({message:"변경된 검증 완료"}));
    assert.notEqual(a.replyFingerprint,changed.replyFingerprint);

    const input=await inspect(fixture({unsafe:true}));
    assert.equal(input.contentComplete,false);
    assert.equal(input.diagnostic.unsafeEmbedded>0,true);

    const massive=await inspect(fixture({chunks:21000,hidden:false}));
    assert.equal(massive.contentComplete,false);
    assert.equal(massive.diagnostic.nodeBudgetExceeded,true);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;
  }
});

test("completed assistant tolerates absent optional wrappers and trailing decoration, not a later user",async()=>{
  const oldDocument=globalThis.document,oldLocation=globalThis.location;
  globalThis.location={origin:"https://chatgpt.com",pathname:PAGE};
  try{
    for(const opts of [
      {missingSelection:true},{missingSource:true},
      {missingSelection:true,missingSource:true},
      {trailingDecoration:true,missingSelection:true,missingSource:true}
    ]){
      const r=await inspect(fixture({chunks:8,...opts}));
      assert.equal(r.verified,true);
      assert.equal(r.assistantBusy,false);
      assert.equal(r.contentComplete,true,JSON.stringify(opts));
      assert.equal(r.uiAmbiguous,false,JSON.stringify(opts));
      assert.match(r.replyFingerprint,/^[a-f0-9]{64}$/);
    }
    for(const opts of [
      {trailingUser:true},{duplicateBody:true},{mismatchedSource:true},
      {noCanonicalBody:true}
    ]){
      const r=await inspect(fixture({chunks:8,...opts}));
      assert.equal(r.contentComplete,false,JSON.stringify(opts));
      assert.equal(r.uiAmbiguous,true,JSON.stringify(opts));
      assert.equal(r.replyFingerprint,null);
    }
    const streaming=await inspect(fixture({chunks:8,missingSelection:true,missingSource:true,streaming:true}));
    assert.equal(streaming.assistantBusy,true);
    assert.equal(streaming.contentComplete,true);
  }finally{
    if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;
    if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;
  }
});
