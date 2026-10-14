import test from "node:test";
import assert from "node:assert/strict";
import {copyLastMigrationAssistant} from "../extension/migration-page.js";

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
  splitRenderer=false,separationNodes=0}={}){
  const prior={location:globalThis.location,document:globalThis.document};
  const main={tag:"main",children:[],parentElement:null};
  function element(tag,parent){
    const e={tag,children:[],parentElement:parent,
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
    textNode(element("p",div),PROMPT);
    if(quotedMarker)textNode(element("code",element("p",div)),MARKER);
    if(sourceCode)textNode(element("code",element("pre",div)),"user source code");
  }
  function handoff(){
    const div=element("div",shared);
    textNode(element("p",div),MARKER);
    for(let i=0;i<separationNodes;i++)
      textNode(element("p",main),"intervening non-assistant content "+i);
    const codeParent=splitRenderer?element("div",main):div;
    const code=element("code",element("pre",codeParent));
    textNode(code,HANDOFF);
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
