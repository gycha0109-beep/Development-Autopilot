import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DEFAULT_MACROS} from "../local/chat-macro-controller.js";

const popup=readFileSync(new URL("../extension/popup-advanced.html",import.meta.url),"utf8");
const ui=readFileSync(new URL("../extension/popup.js",import.meta.url),"utf8");
const macro=readFileSync(new URL("../local/chat-macro-controller.js",import.meta.url),"utf8");

test("CI branch field renders Korean label, help and meaningful example",()=>{
  assert.match(popup,/\u0043\u0049 \uC870\uD68C \uBE0C\uB79C\uCE58 \(\uC120\uD0DD \uC0AC\uD56D\)/);
  assert.match(popup,/placeholder="\uC608: feat\/saju\/reading-coverage-seven-stage"/);
  assert.match(popup,/\uBBF8\uC9C0\uC815 \uC0C1\uD0DC\uC5D0\uC11C \uC5EC\uB7EC \uBE0C\uB79C\uCE58\uAC00/);
  assert.doesNotMatch(popup,/\u0043\u0049 \?{3}/);
});

test("completion status and CI evidence contain no corrupted placeholder",()=>{
  assert.match(ui,/\uB85C\uB4DC\uB9F5 \uC644\uB8CC/);
  assert.match(ui,/\u0047\u0069\u0074\u0048\u0075\u0062 Actions \uC9C1\uC811 \uD655\uC778 \uAC00\uB2A5/);
  assert.match(macro,/\u0043\u0049 \uC2E4\uD328 \uADFC\uAC70/);
  assert.match(macro,/\uC2B9\uC778\uB41C \uC800\uC7A5\uC18C/);
  assert.match(macro,/\uCD5C\uC885 \uAC10\uC0AC \uAE30\uC900 \u0043\u0049 HEAD SHA/);
  assert.doesNotMatch(macro,/\u0043\u0049 \?\? \?\?:/);
  assert.doesNotMatch(macro,/\u005C\u006E\?{3} \?{3}:/);
  assert.ok(DEFAULT_MACROS.audit.includes("\uD504\uB85C\uC81D\uD2B8 \uC9C0\uCE68"));
});
