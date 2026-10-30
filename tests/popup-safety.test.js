import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
test("popup state requests never invoke bridge sync or scheduled command processing",()=>{
 const script=readFileSync(new URL("../extension/background.js",import.meta.url),"utf8");
 const start=script.indexOf('if(message.type==="AP_POPUP_CONTROL")');
 const end=script.indexOf('if(message.type==="AP_POPUP_CREATE_GROUP")',start);
 assert.ok(start>0&&end>start);
 const block=script.slice(start,end);
 assert.doesNotMatch(block,/bridgeSync\s*\(/);
 assert.doesNotMatch(block,/processChatCommand\s*\(/);
});
test("popup status is independent of local server availability",()=>{
 const code=readFileSync(new URL("../extension/popup.js",import.meta.url),"utf8");
 const fn=code.slice(code.indexOf("async function quickRefresh()"),code.indexOf("async function quickAct("));
 assert.ok(fn.indexOf('choices("quick-tab"')<fn.indexOf('action:"state"'));
 assert.ok(fn.includes("quickNotice"));
});