import test from "node:test";
import assert from "node:assert/strict";
import {inspectChatLengthLimit,inspectMigrationSource,copyLastMigrationAssistant} from "../extension/migration-page.js";

function withFakePage(url,warningText,quoted,run){
  const before={location:globalThis.location,document:globalThis.document};
  const page=new URL(url);
  globalThis.location={origin:page.origin,pathname:page.pathname};
  const node=(text,isQuoted=false)=>({
    childNodes:[{nodeType:3,textContent:text}],
    children:[],textContent:text,
    getClientRects:()=>[{}],
    closest:selector=>isQuoted&&selector.includes("data-message-author-role")?{}:null
  });
  globalThis.document={
    querySelectorAll:()=>[node(warningText),node(quoted,true)]
  };
  try{return run()}finally{
    globalThis.location=before.location;
    globalThis.document=before.document;
  }
}
test("real visible Korean length banner automatically triggers without reading chat transcript",()=>{
  withFakePage("https://chatgpt.com/g/g-p-saju/c/last",
    "이 대화의 최대 길이에 도달했으나 새 채팅을 시작해 계속 이야기할 수 있습니다.",
    "assistant may quote the maximum-length banner",()=>{
      const status=inspectChatLengthLimit();
      assert.equal(status.eligible,true);
      assert.equal(status.warning,true);
      assert.equal(Object.hasOwn(status,"text"),false);
    });
});
test("quoting a warning within a conversation does not trigger migration",()=>{
  withFakePage("https://chatgpt.com/g/g-p-saju/c/last",
    "새 채팅을 눌러주세요", "이 대화의 최대 길이에 도달했습니다",()=>{
      const status=inspectChatLengthLimit();
      assert.equal(status.warning,false);
    });
});
test("project landing or unrelated page is ineligible for migration",()=>{
  for(const url of [
    "https://chatgpt.com/",
    "https://chatgpt.com/g/g-p-saju/project",
    "https://evil.com/g/g-p-saju/c/last"
  ])withFakePage(url,"이 대화의 최대 길이에 도달했으나", "",()=>{
    const result=inspectChatLengthLimit();
    assert.equal(result.eligible,false,url);
    assert.equal(result.warning,false,url);
  });
});

test("nested ChatGPT warning button is recognized while nested quoted assistant text is excluded",()=>{
  const before={location:globalThis.location,document:globalThis.document};
  globalThis.location={origin:"https://chatgpt.com",pathname:"/g/g-p-bejewely/c/face-lab-23"};
  const make=(text,quoted=false)=>({
    childNodes:[],children:[{}],innerText:text,textContent:text,
    closest:selector=>quoted && selector.includes("data-message-author-role")?{}:null,
    querySelector:()=>null,getClientRects:()=>[{}]
  });
  globalThis.document={querySelectorAll:()=>[
    make("이 대화의 최대 길이에 도달했으나 새 채팅을 시작해 계속 이야기할 수 있습니다."),
    make("이 대화의 최대 길이에 도달",true)
  ]};
  try{
    const result=inspectChatLengthLimit();
    assert.equal(result.warning,true);
    assert.equal(result.reason,"VISIBLE_LENGTH_WARNING_DETECTED");
  }finally{
    globalThis.location=before.location;globalThis.document=before.document;
  }
});

test("virtualized ChatGPT messages: new marked handoff captured despite unchanged assistant count",()=>{
  const prev={location:globalThis.location,document:globalThis.document};
  globalThis.location={origin:"https://chatgpt.com",pathname:"/g/g-p-bejewely/c/face-lab-23"};
  let text="이전 작업의 실제 답변";
  const message={
    getAttribute:()=>null,
    querySelector:()=>null,
    get innerText(){return text}
  };
  globalThis.document={
    querySelectorAll:selector=>selector.includes("stop-button")?[]:[message],
    body:{innerText:""}
  };
  try{
    const baseline=inspectMigrationSource();
    assert.equal(baseline.assistantCount,1);
    const reply={id:baseline.lastAssistantId,
      fingerprint:baseline.lastAssistantFingerprint};
    text="AUTOPILOT_MIGRATION_HANDOFF\\n"+"원본 대화가 작성한 로드맵 기반 이관문 ".repeat(12);
    const result=copyLastMigrationAssistant(1,"AUTOPILOT_MIGRATION_HANDOFF",30000,reply);
    assert.equal(result.ok,true);
    assert.match(result.body,/원본 대화가 작성한 로드맵/);
  }finally{globalThis.location=prev.location;globalThis.document=prev.document}
});
test("virtualized count cannot reuse unchanged old marker; old in-flight requires explicit recovery",()=>{
  const prev={location:globalThis.location,document:globalThis.document};
  globalThis.location={origin:"https://chatgpt.com",pathname:"/g/g-p-bejewely/c/face-lab-23"};
  const text="AUTOPILOT_MIGRATION_HANDOFF\\n"+"기존 다른 이관문 내용 ".repeat(15);
  const message={getAttribute:()=>null,querySelector:()=>null,innerText:text};
  globalThis.document={
    querySelectorAll:selector=>selector.includes("stop-button")?[]:[message]
  };
  try{
    const baseline=inspectMigrationSource();
    const old={id:baseline.lastAssistantId,fingerprint:baseline.lastAssistantFingerprint};
    const denied=copyLastMigrationAssistant(1,"AUTOPILOT_MIGRATION_HANDOFF",30000,old);
    assert.equal(denied.ok,false);
    assert.equal(denied.reason,"MIGRATION_NEW_RESPONSE_NOT_FOUND");
    const legacy=copyLastMigrationAssistant(1,"AUTOPILOT_MIGRATION_HANDOFF",30000);
    assert.equal(legacy.ok,false);
    const confirmed=copyLastMigrationAssistant(1,"AUTOPILOT_MIGRATION_HANDOFF",30000,null,true);
    assert.equal(confirmed.ok,true);
  }finally{globalThis.location=prev.location;globalThis.document=prev.document}
});
