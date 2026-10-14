import test from "node:test";
import assert from "node:assert/strict";
import {inspectMigrationTarget} from "../extension/migration-page.js";

function assistant(text) {
  return {innerText:text,textContent:text};
}
function withTargetPage({
  origin="https://chatgpt.com",
  pathname="/g/g-p-sample-project/c/new-session",
  articles=[],classic=[],busy=false
}={},run) {
  const previous={location:globalThis.location,document:globalThis.document};
  globalThis.location={origin,pathname};
  globalThis.document={querySelectorAll(selector) {
    if(selector.includes('[data-testid="stop-button"]')) {
      return busy?[{disabled:false,getClientRects:()=>[{}]}]:[];
    }
    if(selector==='article[data-turn="assistant"]')return articles;
    if(selector==='[data-message-author-role="assistant"]')return classic;
    throw Error("Unexpected query: "+selector);
  }};
  try{return run()}finally{
    globalThis.location=previous.location;
    globalThis.document=previous.document;
  }
}

test("new project conversation recognizes completed article-rendered assistant reply",()=>{
  withTargetPage({articles:[assistant("The migration was received; I will resume the verified development work.")]},()=>{
    const found=inspectMigrationTarget();
    assert.equal(found.ok,true);
    assert.equal(found.projectConversation,true);
    assert.equal(found.projectNew,false);
    assert.equal(found.busy,false);
    assert.equal(found.assistantCount,1);
    assert.match(found.lastReplyFingerprint,/^[0-9]+:[0-9a-f]+$/);
    assert.deepEqual(inspectMigrationTarget(),found,"fingerprint must be stable");
  });
});

test("classic assistant renderer remains supported",()=>{
  withTargetPage({classic:[assistant("The new session has replied to the transferred handoff.")]},()=>{
    const found=inspectMigrationTarget();
    assert.equal(found.assistantCount,1);
    assert.ok(found.lastReplyFingerprint);
  });
});

test("nested classic assistant nodes are not double-counted when article turns exist",()=>{
  const reply=assistant("Exactly one verified assistant reply in this project conversation.");
  withTargetPage({articles:[reply],classic:[reply]},()=>{
    assert.equal(inspectMigrationTarget().assistantCount,1);
  });
});

test("target project conversation cannot claim a reply before an assistant turn exists",()=>{
  withTargetPage({},()=>{
    const found=inspectMigrationTarget();
    assert.equal(found.ok,true);
    assert.equal(found.assistantCount,0);
    assert.equal(found.lastReplyFingerprint,null);
  });
});

test("reply remains busy when ChatGPT is still generating",()=>{
  withTargetPage({busy:true,articles:[assistant("A long assistant response is still being generated.")]},()=>{
    const found=inspectMigrationTarget();
    assert.equal(found.assistantCount,1);
    assert.equal(found.busy,true);
  });
});

test("new project composer with no response is not misclassified as an existing conversation",()=>{
  withTargetPage({pathname:"/g/g-p-sample-project/project"},()=>{
    const found=inspectMigrationTarget();
    assert.equal(found.ok,true);
    assert.equal(found.projectNew,true);
    assert.equal(found.projectConversation,false);
    assert.equal(found.assistantCount,0);
  });
});

test("wrong origin or wrong route refuses target reply confirmation",()=>{
  withTargetPage({origin:"https://example.invalid"},()=>{
    assert.deepEqual(inspectMigrationTarget(),{
      ok:false,reason:"MIGRATION_TARGET_WRONG_ORIGIN"
    });
  });
  withTargetPage({pathname:"/c/not-a-project",articles:[assistant("An unrelated assistant reply exists elsewhere.")]},()=>{
    const found=inspectMigrationTarget();
    assert.equal(found.ok,false);
    assert.equal(found.reason,"MIGRATION_TARGET_NOT_PROJECT_CHAT");
  });
});
