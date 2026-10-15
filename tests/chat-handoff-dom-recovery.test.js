import test from "node:test";
import assert from "node:assert/strict";
import {
  copyLastMigrationAssistant,inspectAuthoredHandoffDomShape,inspectMigrationTarget,
  inspectAlreadyTransferredHandoff,readRegisteredChatTitle,
  inspectTransferredHandoffTrackPair
} from "../extension/migration-page.js";

const MARKER="AUTOPILOT_MIGRATION_HANDOFF";
const PROMPT="현재 개발 채팅의 길이 제한으로 다음 채팅에 이관해야 합니다. GitHub 저장소 owner/repo 로드맵을 확인하고 새 프로젝트 채팅의 첫 메시지로 붙여넣을 이관 프롬프트를 작성하십시오. 응답은 "+MARKER+" 로 시작하십시오.";
const HANDOFF="실제 원본 대화에서 작성한 개발 이관문입니다. 로드맵과 브랜치 PR 커밋을 확인한 후 다음 작업을 계속 수행하십시오. ".repeat(6);
const assistantText=MARKER+"\n"+HANDOFF;
const node=(role,text,id,kind="classic")=>{
  const el={
    innerText:text,textContent:text,
    getAttribute:name=>name==="data-message-author-role"&&kind==="classic"?role:
      name==="data-turn"&&kind==="article"?role:
      name==="data-message-id"&&kind==="classic"?id:
      name==="data-turn-id"&&kind==="article"?id:null,
    querySelector:()=>null
  };
  return el;
};
function page(turns,run,{generating=false,origin="https://chatgpt.com"}={}){
  const prior={location:globalThis.location,document:globalThis.document};
  globalThis.location={origin,pathname:"/g/g-p-bejewely/c/face-lab-23"};
  globalThis.document={querySelectorAll:selector=>{
    if(selector.includes("stop-button"))return generating?[{disabled:false,getClientRects:()=>[{}]}]:[];
    if(selector==='[data-message-author-role="assistant"]')
      return turns.filter(x=>x.getAttribute("data-message-author-role")==="assistant");
    if(selector==="[data-message-author-role]")
      return turns.filter(x=>x.getAttribute("data-message-author-role"));
    if(selector==='article[data-turn="user"],article[data-turn="assistant"]')
      return turns.filter(x=>x.getAttribute("data-turn"));
    return [];
  }};
  try{return run()}finally{
    globalThis.location=prior.location;
    globalThis.document=prior.document;
  }
}

test("same mounted assistant count still captures a completed authoring reply whose preceding user asked for handoff",()=>{
  page([node("user",PROMPT,"user-new"),node("assistant",assistantText,"assistant-new")],()=>{
    const result=copyLastMigrationAssistant(1,MARKER,30000,"assistant-old");
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
    assert.equal(result.evidence,"NEW_ASSISTANT_ID");
    const noIds=copyLastMigrationAssistant(1,MARKER,30000);
    assert.equal(noIds.ok,true);
    assert.equal(noIds.evidence,"ORIGINAL_USER_REQUEST_PRECEDES_ASSISTANT");
  });
});
test("after extension reload, authoring proof recovers exact reply without historical count or ID",()=>{
  page([node("user",PROMPT,null),node("assistant",assistantText,null)],()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null);
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
    assert.equal(result.evidence,"ORIGINAL_USER_REQUEST_PRECEDES_ASSISTANT");
  });
});
test("does not accept unrelated/old assistant reply or missing provenance after count reset",()=>{
  for(const turns of [
    [node("user","다음 작업 해봐",null),node("assistant",assistantText,null)],
    [node("user",PROMPT,null),node("assistant",assistantText,null),
      node("user","다른 질문이 있어요",null)],
    [node("assistant",assistantText,null)]
  ])page(turns,()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000);
    assert.equal(result.ok,false);
    assert.match(result.reason,
      /^MIGRATION_(SOURCE_REQUEST_MISMATCH|ASSISTANT_NOT_LATEST_TURN|SOURCE_REQUEST_PROVENANCE_UNCERTAIN)$/);
  });
});
test("checks authored marker and never collects generic reply even with increased count",()=>{
  page([node("user",PROMPT,"u"),node("assistant","완료했습니다. "+HANDOFF,"a")],()=>{
    const result=copyLastMigrationAssistant(0,MARKER,30000);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_MARKER_NOT_FOUND");
  });
});
test("refuses in-progress output and wrong domain despite otherwise valid handoff",()=>{
  const turns=[node("user",PROMPT,"u"),node("assistant",assistantText,"a")];
  page(turns,()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000).reason,
      "MIGRATION_RESPONSE_STILL_GENERATING");
  },{generating:true});
  page(turns,()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000).reason,
      "MIGRATION_SOURCE_CHANGED");
  },{origin:"https://evil.example"});
});

test("changed assistant ID and count cannot bypass unrelated user request",()=>{
  page([node("user","다른 일을 해주세요","u-new"),node("assistant",assistantText,"a-new")],()=>{
    const result=copyLastMigrationAssistant(0,MARKER,30000,"a-old");
    assert.equal(result.reason,"MIGRATION_SOURCE_REQUEST_MISMATCH");
  });
});
test("later user turn makes previous assistant handoff stale",()=>{
  page([node("user",PROMPT,"u1"),node("assistant",assistantText,"a-new"),
    node("user","이어서 다른 질문","u2")],()=>{
    assert.equal(copyLastMigrationAssistant(0,MARKER,30000,"a-old").reason,
      "MIGRATION_ASSISTANT_NOT_LATEST_TURN");
  });
});
test("count alone without user provenance never proves freshness",()=>{
  page([node("assistant",assistantText,"a-new")],()=>{
    assert.equal(copyLastMigrationAssistant(0,MARKER,30000).reason,
      "MIGRATION_SOURCE_REQUEST_PROVENANCE_UNCERTAIN");
    assert.equal(copyLastMigrationAssistant(0,MARKER,30000,"a-old").ok,true);
  });
});
test("unchanged user ID rejects old handoff despite assistant churn",()=>{
  page([node("user",PROMPT,"old-user"),node("assistant",assistantText,"a-new")],()=>{
    assert.equal(copyLastMigrationAssistant(0,MARKER,30000,"a-old","old-user").reason,
      "MIGRATION_SOURCE_REQUEST_NOT_NEW");
    assert.equal(copyLastMigrationAssistant(0,MARKER,30000,"a-old","prior-user").ok,true);
  });
});

test("article data-turn source recovers actual authored handoff",()=>{
  page([node("user",PROMPT,"u-new","article"),
    node("assistant",assistantText,"a-new","article")],()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000);
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
    assert.equal(result.evidence,"ORIGINAL_USER_REQUEST_PRECEDES_ASSISTANT");
  });
});
test("article DOM rejects an unrelated user request",()=>{
  page([node("user","무관한 요청","u","article"),
    node("assistant",assistantText,"a","article")],()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000).reason,
      "MIGRATION_SOURCE_REQUEST_MISMATCH");
  });
});
test("virtualized article assistant requires independent pre-send ID",()=>{
  page([node("assistant",assistantText,"a-new","article")],()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000).reason,
      "MIGRATION_SOURCE_REQUEST_PROVENANCE_UNCERTAIN");
    const result=copyLastMigrationAssistant(null,MARKER,30000,"a-old");
    assert.equal(result.ok,true);
    assert.equal(result.evidence,"NEW_ASSISTANT_ID");
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000,"a-new").reason,
      "MIGRATION_SOURCE_REQUEST_PROVENANCE_UNCERTAIN");
  });
});
test("missing explicit assistant role reports DOM diagnostic",()=>{
  page([],()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000).reason,
      "MIGRATION_ASSISTANT_DOM_NOT_FOUND");
  });
});

function unlabelledPage(run,{request=PROMPT,markerText=MARKER,
  codeText=HANDOFF,codeBlocks=1}={}){
  const prior={location:globalThis.location,document:globalThis.document};
  const main={};
  const user={innerText:request,textContent:request,parentElement:main};
  const sourceText={textContent:request,parentElement:user,
    compareDocumentPosition:()=>4};
  const code={innerText:codeText,textContent:codeText};
  const container={parentElement:main,
    querySelectorAll:selector=>selector==="pre code"?
      Array.from({length:codeBlocks},()=>code):[]};
  const markerEl={parentElement:container,closest:()=>null,querySelectorAll:()=>[]};
  const mark={textContent:markerText,parentElement:markerEl,
    compareDocumentPosition:()=>4};
  const queue=[sourceText,mark];
  globalThis.location={origin:"https://chatgpt.com",
    pathname:"/g/g-p-bejewely/c/face-lab-23"};
  globalThis.document={
    querySelectorAll:()=>[],
    querySelector:selector=>selector==="main"?main:null,
    createTreeWalker:()=>({
      nextNode:()=>queue.shift()||null
    })
  };
  try{return run()}finally{
    globalThis.location=prior.location;globalThis.document=prior.document;
  }
}
test("operator recovers unattributed DOM marker followed by a code block exactly",()=>{
  unlabelledPage(()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000,null,null).reason,
      "MIGRATION_ASSISTANT_DOM_NOT_FOUND");
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
    assert.equal(result.evidence,"UNATTRIBUTED_SOURCE_REQUEST_MARKER_CODEBLOCK");
  });
});
test("unattributed recovery refuses a missing exact response marker",()=>{
  unlabelledPage(()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000,null,null,true).reason,
      "MIGRATION_UNATTRIBUTED_MARKER_NOT_FOUND");
  },{markerText:"another message"});
});
test("unattributed recovery refuses unrelated source request despite marked code block",()=>{
  unlabelledPage(()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000,null,null,true).reason,
      "MIGRATION_UNATTRIBUTED_SOURCE_REQUEST_NOT_FOUND");
  },{request:"unrelated request"});
});
test("unattributed recovery rejects ambiguous adjacent code blocks",()=>{
  unlabelledPage(()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000,null,null,true).reason,
      "MIGRATION_UNATTRIBUTED_CODE_BLOCK_AMBIGUOUS");
  },{codeBlocks:2});
});
test("unattributed recovery enforces handoff length",()=>{
  unlabelledPage(()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000,null,null,true).reason,
      "MIGRATION_PROMPT_TOO_SHORT");
  },{codeText:"too short"});
});

function realisticUnattributed(run,{quotedMarker=true,priorHandoff=false,
  doubleLatest=false,sourceCode=false,omitLatest=false,
  splitRenderer=false,separationNodes=0,plainRenderer=false,
  shortPlain=false,chromeCodeNoPre=false,bodyMentionsMarker=false,
  multipleAdjacentCodes=false,writingBlock=false,
  writingBody=null,writingTitle=null,requestText=PROMPT}={}){
  const prior={location:globalThis.location,document:globalThis.document};
  const main={tag:"main",children:[],parentElement:null};
  function element(tag,parent){
    const e={tag,children:[],parentElement:parent,
      get tagName(){return tag.toUpperCase();},
      get nextElementSibling(){
        const siblings=this.parentElement?.children?.filter(x=>x.tag)||[];
        const index=siblings.indexOf(this);
        return index<0?null:siblings[index+1]||null;
      },
      closest(sel){let n=this;
        while(n&&n!==main){
          if(sel.split(",").includes(n.tag))return n;
          n=n.parentElement;
        }return null;
      },
      contains(child){for(let n=child?.parentElement;n;n=n.parentElement){
        if(n===this)return true;
      }return child===this;},
      querySelectorAll(sel){
        const matched=[];
        const traverse=n=>{
          for(const c of n.children||[]){
            if(sel==="pre code"&&c.tag==="code"&&c.parentElement?.tag==="pre")
              matched.push(c);
            if(sel==="pre"&&c.tag==="pre")matched.push(c);
            if(sel==="code"&&c.tag==="code")matched.push(c);
            traverse(c);
          }
        };
        traverse(this);
        return matched;
      },
      get textContent(){return this.children.map(x=>x.textContent||"").join(" ");},
      get innerText(){return this.textContent;}
    };
    parent.children.push(e);
    return e;
  }
  function textNode(parent,value){
    const n={textContent:value,parentElement:parent};
    parent.children.push(n);return n;
  }
  const shared=splitRenderer?element("div",main):main;
  function source(){
    const div=element("div",shared);
    textNode(element("p",div),requestText);
    if(quotedMarker)textNode(element("code",element("p",div)),MARKER);
    if(sourceCode)textNode(element("code",element("pre",div)),"user source code");
  }
  function handoff(){
    const div=element("div",shared);
    textNode(chromeCodeNoPre?element("span",element("p",div)):
      element("p",div),MARKER);
    for(let i=0;i<separationNodes;i++)
      textNode(element("p",main),"intervening non-assistant content "+i);
    const codeParent=chromeCodeNoPre?element("div",div):
      splitRenderer?element("div",main):div;
    if(writingBlock){
      const card=element("div",div);
      const title=writingTitle??"채팅 이관 프롬프트 — 이관 테스트 1 → 이관 테스트 2";
      const body=writingBody??(
        "1. 이관 기본 정보\n이전 트랙: 이관 테스트 1\n"+
        "신규 트랙: 이관 테스트 2\n"+
        "저장소: gycha0109-beep/Development-Autopilot\n"+
        "이관 식별자: AUTOPILOT_MIGRATION_HANDOFF\n"+
        "2. 작업 목적\n검증된 작업만 이어서 진행하십시오. ".repeat(8));
      textNode(element("span",card),"글쓰기");
      textNode(element("h1",card),title);
      textNode(element("div",card),body);
      Object.defineProperty(card,"innerText",{
        get:()=>["글쓰기",title,body].join("\n")
      });
    }else if(chromeCodeNoPre){
      // Real Chrome evidence: p > span marker and immediately adjacent div
      // containing exactly one CODE element, without a PRE ancestor.
      const code=element("code",codeParent);
      textNode(code,bodyMentionsMarker?
        HANDOFF+"\n원본 응답에 인용된 "+MARKER+" 마커입니다.":HANDOFF);
      if(multipleAdjacentCodes)
        textNode(element("code",codeParent),"additional unrelated code");
    }else if(plainRenderer){
      const styled=element("div",codeParent);
      textNode(styled,shortPlain?"too short":HANDOFF);
    }else{
      const code=element("code",element("pre",codeParent));
      textNode(code,HANDOFF);
    }
  }
  if(priorHandoff){source();handoff();}
  source();
  if(!omitLatest){handoff();if(doubleLatest)handoff();}
  const traversal=[];
  function walk(n){for(const c of n.children||[]){
    if(c.tag)walk(c);else traversal.push(c);
  }}
  walk(main);
  function docOrder(start,target){
    const startIdx=traversal.indexOf(start);
    const targetEl=target.tag?target:target.parentElement;
    const index=target.tag?traversal.findIndex(node=>
      targetEl.contains(node)):traversal.indexOf(target);
    return startIdx<index?4:startIdx>index?2:0;
  }
  for(const n of traversal)n.compareDocumentPosition=other=>docOrder(n,other);
  const allTexts=traversal.slice();
  main.querySelectorAll=sel=>{
    const found=[];
    function descend(n){
      for(const child of n.children||[]){
        if(child.tag){
          if(sel==="pre code"&&child.tag==="code"&&child.parentElement?.tag==="pre")
            found.push(child);
          else if(sel==="pre"&&child.tag==="pre")found.push(child);
          else if(sel==="code"&&child.tag==="code")found.push(child);
          descend(child);
        }
      }
    }
    descend(main);
    return found;
  };
  globalThis.location={origin:"https://chatgpt.com",
    pathname:"/g/g-p-bejewely/c/face-lab-23"};
  globalThis.document={
    querySelectorAll:()=>[],
    querySelector:sel=>sel==="main"?main:null,
    createTreeWalker:()=>({
      nextNode:()=>allTexts.shift()||null
    })
  };
  try{return run()}finally{
    globalThis.location=prior.location;globalThis.document=prior.document;
  }
}
test("source instruction quotes a standalone marker in inline code; latest authored handoff is extracted",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
    assert.equal(result.evidence,"UNATTRIBUTED_SOURCE_REQUEST_MARKER_CODEBLOCK");
  });
});
test("older marked handoff and current one coexist; only the response after latest request qualifies",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
  },{priorHandoff:true});
});
test("source user code block cannot be mistaken for the assistant reply's adjacent code",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
  },{sourceCode:true});
});
test("two valid marked assistant code blocks after latest source request fail closed",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_MARKER_AMBIGUOUS");
  },{doubleLatest:true});
});
test("user's quoted marker alone without an authored response is not an extractable handoff",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND");
  },{omitLatest:true});
});

test("recovers code under a sibling renderer outside all safe marker ancestors",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
    assert.equal(result.evidence,"UNATTRIBUTED_SOURCE_REQUEST_MARKER_CODEBLOCK");
  },{splitRenderer:true});
});
test("sibling-rendered code cannot be chosen after a distant unrelated section",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND");
    assert.equal(result.diagnostic.structuredCodes,1);
    assert.equal(result.diagnostic.qualifiedReplies,0);
  },{splitRenderer:true,separationNodes:15});
});
test("ambiguous multiple sibling-rendered handoffs never silently choose one",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_MARKER_AMBIGUOUS");
  },{splitRenderer:true,doubleLatest:true});
});
test("quoted source marker without assistant is not paired with a later unrelated block",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND");
  },{splitRenderer:true,omitLatest:true,sourceCode:true});
});

const REQUIRED_CONTEXT={repository:"owner/repo",trackTitle:"개발 테스트 3"};
const MATCHED_AUTHORING_PROMPT=PROMPT+
  " 지금 작업하던 트랙 '개발 테스트 3'에서 새 프로젝트 채팅으로 계속 진행하십시오.";
test("role-labelled original request proves repository and track after trigger loss",()=>{
  page([
    node("user",MATCHED_AUTHORING_PROMPT,"user-new"),
    node("assistant",assistantText,"assistant-new")
  ],()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,
      null,null,true,REQUIRED_CONTEXT);
    assert.equal(result.ok,true);
    assert.equal(result.sourceContextVerified,true);
    assert.equal(result.body,HANDOFF.trim());
    assert.equal(result.evidence,"ORIGINAL_USER_REQUEST_PRECEDES_ASSISTANT");
  });
});
test("role-labelled original request from a different track cannot replace missing trigger",()=>{
  page([
    node("user",PROMPT,"user-new"),
    node("assistant",assistantText,"assistant-new")
  ],()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,
      null,null,true,REQUIRED_CONTEXT);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_SOURCE_REQUEST_MISMATCH");
  });
});
test("unattributed marker and fenced code require matching repository and track",()=>{
  unlabelledPage(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,
      null,null,true,REQUIRED_CONTEXT);
    assert.equal(result.ok,true);
    assert.equal(result.sourceContextVerified,true);
    assert.equal(result.body,HANDOFF.trim());
  },{request:MATCHED_AUTHORING_PROMPT});
  unlabelledPage(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,
      null,null,true,REQUIRED_CONTEXT);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_SOURCE_REQUEST_NOT_FOUND");
  });
});
test("optional source proof cannot be bypassed with malformed identity",()=>{
  page([node("user",MATCHED_AUTHORING_PROMPT,"u"),
    node("assistant",assistantText,"a")],()=>{
    assert.equal(copyLastMigrationAssistant(null,MARKER,30000,
      null,null,true,{repository:1,trackTitle:"개발 테스트 3"}).reason,
      "MIGRATION_CAPTURE_INVALID_SOURCE_CONTEXT");
  });
});

test("styled DIV text with zero PRE/CODE is recovered inside a bounded assistant-only reply",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
    assert.equal(result.evidence,"UNATTRIBUTED_SOURCE_REQUEST_MARKER_TEXT");
  },{plainRenderer:true});
});
test("zero PRE/CODE with verified source repository and title supports lost-trigger recovery",()=>{
  const prompt=MATCHED_AUTHORING_PROMPT;
  // Even without historical trigger metadata, provenance comes from the
  // original, not merely from a marker observed elsewhere.
  unstructuredWithExactPrompt(prompt,()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,
      null,null,true,REQUIRED_CONTEXT);
    assert.equal(result.ok,true);
    assert.equal(result.sourceContextVerified,true);
    assert.equal(result.evidence,"UNATTRIBUTED_SOURCE_REQUEST_MARKER_TEXT");
    assert.equal(result.body,HANDOFF.trim());
  });
});
function unstructuredWithExactPrompt(request,callback){
  const prior={location:globalThis.location,document:globalThis.document};
  // This fixture models a root main with a user bubble and an adjacent
  // assistant bubble rendered using plain DIVs rather than PRE/CODE.
  const main={parentElement:null,querySelectorAll:()=>[]};
  function wrapper(text,parent){
    const node={parentElement:parent,innerText:text,textContent:text,
      closest:()=>null,querySelectorAll:()=>[],
      contains(child){for(let p=child;p;p=p.parentElement)
        if(p===this)return true;return false;}};
    return node;
  }
  const user=wrapper(request,main);
  const requestNode={textContent:request,parentElement:user,
    compareDocumentPosition:()=>4};
  const reply=wrapper(MARKER+"\n"+HANDOFF,main);
  const markerEl=wrapper(MARKER,reply);
  const marker={textContent:MARKER,parentElement:markerEl,
    compareDocumentPosition:()=>4};
  const content=wrapper(HANDOFF,reply);
  const payloadNode={textContent:HANDOFF,parentElement:content,
    compareDocumentPosition:()=>0};
  const queue=[requestNode,marker,payloadNode];
  main.contains=()=>true;
  globalThis.location={origin:"https://chatgpt.com",
    pathname:"/g/g-p-bejewely/c/face-lab-23"};
  globalThis.document={
    querySelectorAll:()=>[],
    querySelector:key=>key==="main"?main:null,
    createTreeWalker:()=>({nextNode:()=>queue.shift()||null})
  };
  try{callback()}finally{
    globalThis.location=prior.location;globalThis.document=prior.document;
  }
}
test("styled DIV text is never recovered from common ancestor containing original user request",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND");
    assert.equal(result.diagnostic.structuredCodes,0);
    assert.equal(result.diagnostic.boundedTextScopes,0);
  },{plainRenderer:true,splitRenderer:true});
});
test("styled DIV response with insufficient text is refused",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND");
  },{plainRenderer:true,shortPlain:true});
});
test("two unstructured responses with standalone markers remain ambiguous",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_MARKER_AMBIGUOUS");
  },{plainRenderer:true,doubleLatest:true});
});
test("source-only quoted marker and plain text never count as an authored handoff",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND");
  },{plainRenderer:true,omitLatest:true});
});

test("read-only structural DOM report shows scoped ancestry without handoff or source text",()=>{
  realisticUnattributed(()=>{
    const result=inspectAuthoredHandoffDomShape(MARKER);
    assert.equal(result.ok,true);
    assert.equal(result.readOnly,true);
    assert.equal(result.version,1);
    assert.ok(result.counts.markers>=2);
    assert.ok(result.counts.requests>=1);
    assert.ok(result.markerOrigins.length>=1);
    assert.ok(result.markerOrigins.at(-1).ancestors.length>=2);
    const json=JSON.stringify(result);
    assert.equal(json.includes(HANDOFF.trim()),false);
    assert.equal(json.includes("현재 개발 채팅의 길이 제한으로"),false);
    assert.equal(json.includes("/g/g-p-bejewely"),false);
    assert.equal(json.includes("owner/repo"),false);
  },{plainRenderer:true,sourceCode:true});
});
test("DOM structural diagnosis refuses unrelated web origin",()=>{
  page([node("user",PROMPT,"u"),node("assistant",assistantText,"a")],()=>{
    const result=inspectAuthoredHandoffDomShape(MARKER);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_DIAGNOSTIC_WRONG_CHAT");
  },{origin:"https://another.example"});
});

test("real Chrome 2026-10-14 DOM: inline quoted source CODE plus adjacent DIV > CODE without PRE",()=>{
  realisticUnattributed(()=>{
    assert.equal(document.querySelectorAll("pre code").length,0);
    assert.equal(document.querySelectorAll("pre").length,0);
    assert.equal(document.querySelector("main").querySelectorAll("code").length,2);
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,true);
    assert.equal(result.body,HANDOFF.trim());
    assert.equal(result.evidence,"UNATTRIBUTED_SOURCE_REQUEST_MARKER_CODEBLOCK");
  },{chromeCodeNoPre:true});
});
test("real Chrome adjacent CODE can legitimately quote marker inside the actual handoff body",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,true);
    assert.equal(result.body,
      (HANDOFF+"\n원본 응답에 인용된 "+MARKER+" 마커입니다.").trim());
  },{chromeCodeNoPre:true,bodyMentionsMarker:true});
});
test("real Chrome adjacent reply DIV with two CODE payloads fails closed",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_CODE_BLOCK_AMBIGUOUS");
  },{chromeCodeNoPre:true,multipleAdjacentCodes:true});
});
test("real Chrome quoted user marker without a valid post-request reply remains rejected",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true);
    assert.equal(result.ok,false);
  },{chromeCodeNoPre:true,omitLatest:true});
});

const WRITING_SOURCE_CONTEXT={
  repository:"gycha0109-beep/Development-Autopilot",trackTitle:"이관 테스트 1"
};
const WRITING_SOURCE_PROMPT=PROMPT+
  " 현재 등록된 채팅은 이관 테스트 1이고 저장소는 "+
  "gycha0109-beep/Development-Autopilot 입니다.";
test("ChatGPT Writing Block after standalone marker captures only title and full document",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true,
      WRITING_SOURCE_CONTEXT);
    assert.equal(result.ok,true);
    assert.equal(result.evidence,"UNATTRIBUTED_SOURCE_REQUEST_WRITING_BLOCK");
    assert.equal(result.sourceContextVerified,true);
    assert.ok(result.body.startsWith("채팅 이관 프롬프트 — 이관 테스트 1 → 이관 테스트 2"));
    assert.ok(result.body.includes("2. 작업 목적"));
    assert.ok(result.body.includes("AUTOPILOT_MIGRATION_HANDOFF"));
    assert.equal(result.body.includes("\n글쓰기\n"),false);
    assert.equal(result.body.includes("현재 개발 채팅의 길이 제한으로"),false);
  },{writingBlock:true,requestText:WRITING_SOURCE_PROMPT});
});
test("Writing Block requires exact original repository and numbered source track",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true,{
      repository:"someone-else/repo",trackTitle:"이관 테스트 1"});
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_SOURCE_REQUEST_NOT_FOUND");
  },{writingBlock:true,requestText:WRITING_SOURCE_PROMPT});
});
test("Writing Block refuses a card without a matching handoff title",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true,
      WRITING_SOURCE_CONTEXT);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_UNATTRIBUTED_WRITING_BLOCK_NOT_VERIFIED");
  },{writingBlock:true,requestText:WRITING_SOURCE_PROMPT,
    writingTitle:"관련 없는 일반 작업 기록",
    writingBody:"단순 작업 기록: 잘못된 문서 제목과 내용입니다. ".repeat(10)});
});
test("Writing Block cannot be copied from an older response before a new source request",()=>{
  realisticUnattributed(()=>{
    const result=copyLastMigrationAssistant(null,MARKER,30000,null,null,true,
      WRITING_SOURCE_CONTEXT);
    assert.equal(result.ok,false);
  },{writingBlock:true,omitLatest:true,requestText:WRITING_SOURCE_PROMPT});
});

function targetDOMTest(fn,{feedback=true,busy=false,paired=true,role=false,
  project=true,duplicate=false}={}){
  const prior={location:globalThis.location,document:globalThis.document};
  const main={innerText:"작성된 첫 번째 이관 프롬프트 ".repeat(9)+
    "assistant 답변이 정상적으로 완료됐습니다. ".repeat(9),
    contains:()=>paired};
  const parent={parentElement:main,
    contains:node=>paired && node?.kind==="negative"};
  const good={kind:"positive",parentElement:parent};
  const bad={kind:"negative",parentElement:parent};
  const assistant={innerText:"실제 assistant 완료 답변 ".repeat(15)};
  globalThis.location={origin:"https://chatgpt.com",pathname:project?
    "/g/g-p-test-project/c/next":"/g/g-p-test-project/project"};
  globalThis.document={
    querySelector:selector=>selector==="main"?main:null,
    querySelectorAll:selector=>{
      if(selector.includes("stop-button"))
        return busy?[{disabled:false,getClientRects:()=>[{}]}]:[];
      if(selector.includes("data-turn=\"assistant\""))
        return role?[assistant]:[];
      if(selector.includes("good-response"))
        return feedback?(duplicate?[good,good]:[good]):[];
      if(selector.includes("bad-response"))
        return feedback?[bad]:[];
      return [];
    }
  };
  try{return fn()}finally{
    globalThis.location=prior.location;
    globalThis.document=prior.document;
  }
}
test("role-less target response with paired completion feedback advances to stable fingerprint",()=>{
  targetDOMTest(()=>{
    const result=inspectMigrationTarget();
    assert.equal(result.ok,true);
    assert.equal(result.projectConversation,true);
    assert.equal(result.assistantCount,1);
    assert.equal(result.evidence,"ASSISTANT_FEEDBACK_PAIR");
    assert.match(result.lastReplyFingerprint,/^ASSISTANT_FEEDBACK_PAIR:/);
    assert.equal(JSON.stringify(result).includes("실제 assistant"),false);
  });
});
test("a user-only response or unrelated feedback buttons never proves assistant completion",()=>{
  for(const opts of [{feedback:false},{paired:false},{busy:true},
    {project:false},{duplicate:true}]){
    targetDOMTest(()=>{
      const result=inspectMigrationTarget();
      assert.equal(result.assistantCount,0);
      assert.equal(result.lastReplyFingerprint,null);
    },opts);
  }
});
test("article data-turn assistant also supports first reply completion",()=>{
  targetDOMTest(()=>{
    const result=inspectMigrationTarget();
    assert.equal(result.assistantCount,1);
    assert.equal(result.evidence,"ASSISTANT_TURN_ROLE");
    assert.ok(result.lastReplyFingerprint);
  },{role:true,feedback:false});
});

test("stateless transfer proof verifies the original handoff on the exact project chat without returning text",()=>{
  const previous={location:globalThis.location,document:globalThis.document};
  globalThis.location={origin:"https://chatgpt.com",
    pathname:"/g/g-p-saju-project/c/new-4"};
  globalThis.document={
    querySelectorAll:()=>[],
    querySelector:selector=>selector==="main"?{
      innerText:"AUTOPILOT_MIGRATION_HANDOFF "+
        "owner/Saju 사주 범용화 및 권한 통합 3 "+
        "사주 범용화 및 권한 통합 4 작업 목적과 원본 지시를 확인합니다. ".repeat(8)
    }:null
  };
  try{
    const result=inspectAlreadyTransferredHandoff(
      MARKER,"owner/Saju","사주 범용화 및 권한 통합 3",
      "사주 범용화 및 권한 통합 4");
    assert.equal(result.ok,true);
    assert.equal(result.evidence,"VISIBLE_TRANSFERRED_HANDOFF_CONTEXT");
    assert.equal(JSON.stringify(result).includes("owner/Saju"),false);
    const bad=inspectAlreadyTransferredHandoff(
      MARKER,"different/repo","사주 범용화 및 권한 통합 3",
      "사주 범용화 및 권한 통합 4");
    assert.equal(bad.ok,false);
    assert.equal(bad.reason,"MIGRATION_REPAIR_HANDOFF_PROVENANCE_NOT_VISIBLE");
  }finally{
    globalThis.location=previous.location;
    globalThis.document=previous.document;
  }
});

function titleDOMTest(callback,{url="/g/g-p-test/c/new",
  sidebarTitle="이관 테스트 2",browserTitle="ChatGPT",
  innerTitle=null,attributeTitle=null,extraLink=null,visible=true}={}){
  const prev={location:globalThis.location,document:globalThis.document};
  const node=(href,title,{nav=true,attr=null}={})=>({
    href:"https://chatgpt.com"+href,innerText:title,textContent:title,
    getAttribute:k=>k==="href"?href:k==="aria-label"?attr:null,
    getClientRects:()=>visible?[{}]:[],
    closest:()=>nav?{}:null,
    querySelectorAll:()=>innerTitle?[{
      innerText:innerTitle,textContent:innerTitle,
      getAttribute:()=>null
    }]:[]
  });
  const links=[node(url,sidebarTitle,{attr:attributeTitle})];
  if(extraLink)links.push(node(url,extraLink));
  links.push(node("/g/g-p-test/c/other","이관 테스트 2"));
  globalThis.location={origin:"https://chatgpt.com",pathname:url};
  globalThis.document={title:browserTitle,querySelectorAll:()=>links};
  try{return callback()}finally{
    globalThis.location=prev.location;globalThis.document=prev.document;
  }
}
test("title verification reads exact current-conversation sidebar title without mixing another chat",()=>{
  titleDOMTest(()=>{
    const result=readRegisteredChatTitle("이관 테스트 2");
    assert.equal(result.ok,true);
    assert.equal(result.title,"이관 테스트 2");
    assert.equal(result.source,"chat-sidebar-exact");
    assert.equal(result.diagnostic.currentConversationLinks,1);
  });
});
test("title verification supports a nested visible label or same-link aria attribute",()=>{
  titleDOMTest(()=>{
    const result=readRegisteredChatTitle("이관 테스트 2");
    assert.equal(result.ok,true);
    assert.equal(result.source,"chat-sidebar-exact");
  },{sidebarTitle:"메뉴",innerTitle:"이관 테스트 2"});
  titleDOMTest(()=>{
    const result=readRegisteredChatTitle("이관 테스트 2");
    assert.equal(result.ok,true);
  },{sidebarTitle:"메뉴",attributeTitle:"이관 테스트 2"});
});
test("title verification supports exact browser title when no numbered sidebar title is readable",()=>{
  titleDOMTest(()=>{
    const result=readRegisteredChatTitle("이관 테스트 2");
    assert.equal(result.ok,true);
    assert.equal(result.source,"browser-title-exact");
  },{sidebarTitle:"더 보기",browserTitle:"이관 테스트 2 - ChatGPT"});
});
test("title verification fails closed on conflicting sidebar title even if browser title matches",()=>{
  titleDOMTest(()=>{
    const result=readRegisteredChatTitle("이관 테스트 2");
    assert.equal(result.ok,false);
    assert.equal(result.reason,"CHAT_TITLE_LINK_TITLE_MISMATCH");
    assert.equal(result.diagnostic.expectedInLinkedTitle,false);
    assert.equal(JSON.stringify(result).includes("이관 테스트 실행"),false);
  },{sidebarTitle:"이관 테스트 실행 1",browserTitle:"이관 테스트 2 - ChatGPT"});
});
test("title verification refuses two different numbered titles in current URL links",()=>{
  titleDOMTest(()=>{
    const result=readRegisteredChatTitle("이관 테스트 2");
    assert.equal(result.ok,false);
    assert.equal(result.reason,"CHAT_TITLE_CONFLICTING_LINK_TITLES");
  },{extraLink:"이관 테스트 3"});
});
test("title verification does not borrow title from different chat without matching current link",()=>{
  titleDOMTest(()=>{
    const result=readRegisteredChatTitle("이관 테스트 2");
    assert.equal(result.ok,false);
    assert.equal(result.reason,"CHAT_TITLE_LINK_TITLE_MISMATCH");
  },{sidebarTitle:"이관 테스트 1",browserTitle:"ChatGPT"});
});

const HANDOFF_REPO="gycha0109-beep/Development-Autopilot";
const transferredHandoff=(oldTitle="이관 테스트 1",newTitle="이관 테스트 2")=>
  "AUTOPILOT_MIGRATION_HANDOFF\n글쓰기\n"+
  "채팅 이관 프롬프트 — "+oldTitle+" → "+newTitle+"\n"+
  "1. 이관 기본 정보\n"+
  "• 이전 트랙: "+oldTitle+"\n"+
  "• 신규 트랙: "+newTitle+"\n"+
  "• 저장소: "+HANDOFF_REPO+"\n"+
  "• 이관 식별자: AUTOPILOT_MIGRATION_HANDOFF\n"+
  "2. 작업 목적\n"+"검증된 작업을 이어서 진행합니다. ".repeat(12);
function transferredDom(text,cb,{textContent=text,collapsed=false}={}){
  const prior={location:globalThis.location,document:globalThis.document};
  globalThis.location={origin:"https://chatgpt.com",
    pathname:"/g/g-p-test-project/c/new-chat"};
  const main={innerText:text,textContent,
    querySelectorAll:selector=>selector==="button"&&collapsed?
      [{innerText:"더 보기"}]:[]};
  globalThis.document={
    querySelector:query=>query==="main"?main:null,
    querySelectorAll:()=>[]
  };
  try{cb()}finally{globalThis.location=prior.location;globalThis.document=prior.document}
}
test("Writing Block handoff is authoritative for source 1 to target 2 even if watcher title is already 2",()=>{
  transferredDom(transferredHandoff(),()=>{
    const result=inspectTransferredHandoffTrackPair(MARKER,HANDOFF_REPO);
    assert.deepEqual(result,{
      ok:true,sourceTitle:"이관 테스트 1",nextTitle:"이관 테스트 2",
      evidence:"TRANSFERRED_HANDOFF_SOURCE_TARGET_PAIR"
    });
  });
});
test("handoff parser fails closed if wrong repo, inconsistent numeric step or missing marker",()=>{
  for(const [body,repo,reason] of [
    [transferredHandoff(), "someone/other","MIGRATION_REPAIR_HANDOFF_TRACK_PAIR_NOT_FOUND"],
    [transferredHandoff("이관 테스트 1","이관 테스트 3"),HANDOFF_REPO,
      "MIGRATION_REPAIR_HANDOFF_TRACK_PAIR_NOT_FOUND"],
    [transferredHandoff().replaceAll(MARKER,"no handoff"),HANDOFF_REPO,
      "MIGRATION_REPAIR_HANDOFF_MARKER_NOT_VISIBLE"]
  ]){
    transferredDom(body,()=>{
      const result=inspectTransferredHandoffTrackPair(MARKER,repo);
      assert.equal(result.ok,false);
      assert.equal(result.reason,reason);
    });
  }
});
test("different transferred handoffs with same repo in current chat are ambiguous",()=>{
  transferredDom(
    transferredHandoff()+"\n"+transferredHandoff("이관 테스트 2","이관 테스트 3"),()=>{
      const result=inspectTransferredHandoffTrackPair(MARKER,HANDOFF_REPO);
      assert.equal(result.ok,false);
      assert.equal(result.reason,"MIGRATION_REPAIR_HANDOFF_TRACK_PAIR_AMBIGUOUS");
    });
});
test("handoff parser returns no complete conversation text, identifiers or HTML",()=>{
  transferredDom(transferredHandoff(),()=>{
    const result=inspectTransferredHandoffTrackPair(MARKER,HANDOFF_REPO);
    const json=JSON.stringify(result);
    assert.equal(json.includes(HANDOFF_REPO),false);
    assert.equal(json.includes("글쓰기"),false);
    assert.equal(json.includes("검증된 작업을 이어서 진행"),false);
  });
});

test("collapsed Writing Block heading alone proves source to target when marker and repository remain visible",()=>{
  const text="AUTOPILOT_MIGRATION_HANDOFF\n글쓰기\n"+
    "채팅 이관 프롬프트 — 이관 테스트 1 → 이관 테스트 2\n"+
    "1. 이관 기본 정보\n저장소: "+HANDOFF_REPO+"\n"+
    "더 보기\n"+"assistant 첫 답변 완료. ".repeat(9);
  transferredDom(text,()=>{
    const result=inspectTransferredHandoffTrackPair(MARKER,HANDOFF_REPO);
    assert.equal(result.ok,true);
    assert.equal(result.sourceTitle,"이관 테스트 1");
    assert.equal(result.nextTitle,"이관 테스트 2");
  },{collapsed:true});
});
test("hidden original handoff in textContent is checked without modifying expanded state",()=>{
  const visible="기존 이관문이 접혀 있습니다. 더 보기\n"+
    "새 assistant가 이미 이관한 문서를 이해하고 첫 응답을 완료했습니다.";
  transferredDom(visible,()=>{
    const pair=inspectTransferredHandoffTrackPair(MARKER,HANDOFF_REPO);
    assert.equal(pair.ok,true);
    assert.equal(pair.sourceTitle,"이관 테스트 1");
    assert.equal(pair.nextTitle,"이관 테스트 2");
    const proof=inspectAlreadyTransferredHandoff(MARKER,HANDOFF_REPO,
      "이관 테스트 1","이관 테스트 2");
    assert.equal(proof.ok,true);
  },{textContent:transferredHandoff(),collapsed:true});
});
test("collapsed DOM with no mounted handoff reports evidence absence, never guesses from sidebar title",()=>{
  transferredDom("현재 응답 본문만 보입니다. ".repeat(15),()=>{
    const result=inspectTransferredHandoffTrackPair(MARKER,HANDOFF_REPO);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_REPAIR_HANDOFF_MARKER_NOT_VISIBLE");
    assert.equal(result.diagnostic.renderedMarkerVisible,false);
    assert.equal(result.diagnostic.renderedRepositoryVisible,false);
    assert.equal(result.diagnostic.hasExpandControl,true);
    assert.equal(JSON.stringify(result).includes(HANDOFF_REPO),false);
  },{collapsed:true});
});
test("handoff heading and bullet fields must agree or repair stops safely",()=>{
  const content=transferredHandoff()+
    "\n채팅 이관 프롬프트 — 이관 테스트 2 → 이관 테스트 3";
  transferredDom(content,()=>{
    const result=inspectTransferredHandoffTrackPair(MARKER,HANDOFF_REPO);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_REPAIR_HANDOFF_TRACK_PAIR_AMBIGUOUS");
  });
});
test("missing repository in otherwise correct document cannot authorize registration",()=>{
  transferredDom(transferredHandoff().replaceAll(HANDOFF_REPO,"other/repo"),()=>{
    const result=inspectTransferredHandoffTrackPair(MARKER,HANDOFF_REPO);
    assert.equal(result.ok,false);
    assert.equal(result.reason,"MIGRATION_REPAIR_HANDOFF_REPOSITORY_NOT_VISIBLE");
    assert.equal(result.diagnostic.headingCandidates>=1,true);
  });
});
