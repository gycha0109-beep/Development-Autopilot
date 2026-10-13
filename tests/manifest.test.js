import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
test("Chrome extension is MV3 and grants only localhost + ChatGPT host permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, "module");
  assert.deepEqual([...manifest.permissions].sort(), ["storage", "tabGroups", "tabs", "alarms", "scripting"].sort());
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "https://chatgpt.com/*"]);
  assert.equal(manifest.host_permissions.some(h=>h.includes("<all_urls>")),false);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.options_page, "options.html");
});
test("no remote scripts and no inline event execution in extension HTML", () => {
  for (const path of ["options.html", "popup.html"]) {
    const html = readFileSync(new URL("../extension/" + path, import.meta.url), "utf8");
    assert.match(html, /<script type="module" src="(?:options|popup)\.js"><\/script>/);
    assert.doesNotMatch(html, /https?:\/\/[^"\s]+\.js/);
    assert.doesNotMatch(html, /\son(?:click|load|error)\s*=/i);
  }
});
test("dashboard does not inject tab titles as HTML", () => {
  const code = readFileSync(new URL("../extension/options.js", import.meta.url), "utf8");
  assert.doesNotMatch(code, /\.innerHTML\s*=/);
  assert.doesNotMatch(code, /document\.write\(/);
});

test("no ChatGPT output collection APIs or content script auto-enrollment",()=>{
  const code=readFileSync(new URL("../extension/chat-page.js",import.meta.url),"utf8");
  assert.doesNotMatch(code,/querySelectorAll\([^)]*conversation|localStorage|fetch\(|XMLHttpRequest|MutationObserver/);
});
