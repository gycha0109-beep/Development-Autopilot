import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const base = new URL("../", import.meta.url);

test("user-facing Autopilot screens contain no irreversibly corrupted question-mark labels",()=>{
  const files=[
    "local/public/index.html","local/public/app.js",
    "extension/options.html","extension/migration-auto-ui.js",
    "extension/popup-group.js"
  ];
  for(const file of files){
    const content=readFileSync(new URL(file,base),"utf8");
    assert.doesNotMatch(content, /[?]{2,}|\uFFFD/,file);
    assert.match(content,/[\uac00-\ud7a3]/u,file);
  }
});

test("dashboard clears stale fetch errors after reconnecting",()=>{
  const app=readFileSync(new URL("local/public/app.js",base),"utf8");
  assert.match(app,/let snapshotFetchFailed = false;/);
  assert.match(app,/if\(snapshotFetchFailed\)\{snapshotFetchFailed=false;notify\(""\);\}/);
  assert.match(app,/snapshotFetchFailed=true;/);
});

test("the actual Chrome extension popup is minimal and preserves one-shot and management actions",()=>{
  const manifest=JSON.parse(readFileSync(new URL("extension/manifest.json",base),"utf8"));
  assert.equal(manifest.action.default_popup,"popup-simple.html");
  const html=readFileSync(new URL("extension/popup-simple.html",base),"utf8");
  for(const id of ["chat","macro","start","stop","once","manage","status"]){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  for(const hidden of ["macro-repository","macro-ci-branch","macro-prompt","macro-interval"]){
    assert.doesNotMatch(html,new RegExp('id="'+hidden+'"'));
  }
  const script=readFileSync(new URL("extension/popup-simple.js",base),"utf8");
  assert.match(script,/preferredMacroKey:macroKey/);
  assert.match(script,/action:"send"/);
  assert.match(script,/action:"stop"/);
  assert.match(script,/chrome.runtime.openOptionsPage/);
  assert.match(script,/isApprovalBlocked/);
  assert.match(script,/cfg\?\.status==="migrating"/);
  assert.doesNotMatch(html,/\?\?|\uFFFD/);
  assert.doesNotMatch(script,/\?\?|\uFFFD/);
});
test("repo-only migration recovery is a separate explicit consent path",()=>{
  const options=readFileSync(new URL("extension/options.html",base),"utf8");
  const controller=readFileSync(new URL("extension/migration-auto.js",base),"utf8");
  const background=readFileSync(new URL("extension/background.js",base),"utf8");
  assert.match(options,/id="auto-migration-repo-fallback"/);
  assert.match(options,/id="auto-migration-recover-feedback"/);
  assert.match(controller,/acceptMissingHistory!==true/);
  assert.match(controller,/repositoryOnlyMigrationPrompt/);
  assert.match(background,/AP_AUTO_MIGRATION_REPOSITORY_FALLBACK/);
});
