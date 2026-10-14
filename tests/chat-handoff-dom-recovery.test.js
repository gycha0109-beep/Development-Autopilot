import test from "node:test";
import assert from "node:assert/strict";
import {copyLastMigrationAssistant} from "../extension/migration-page.js";

const MARKER="AUTOPILOT_MIGRATION_HANDOFF";
const PROMPT="현재 개발 채팅의 길이 제한으로 다음 채팅에 이관해야 합니다. GitHub 저장소 owner/repo 로드맵을 확인하고 새 프로젝트 채팅의 첫 메시지로 붙여넣을 이관 프롬프트를 작성하십시오. 응답은 "+MARKER+" 로 시작하십시오.";
const HANDOFF="실제 원본 대화에서 작성한 개발 이관문입니다. 로드맵과 브랜치 PR 커밋을 확인한 후 다음 작업을 계속 수행하십시오. ".repeat(6);
const assistantText=MARKER+"\n"+HANDOFF;
const node=(role,text,id)=>{
  const el={
    innerText:text,textContent:text,
    getAttribute:name=>name==="data-message-author-role"?role:
      name==="data-message-id"?id:null,
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
    if(selector==="[data-message-author-role]")return turns;
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
    assert.equal(result.reason,"MIGRATION_NEW_RESPONSE_NOT_FOUND");
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
