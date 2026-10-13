import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
test("Chrome extension is MV3 with minimal metadata-only permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, "module");
  assert.deepEqual([...manifest.permissions].sort(), ["storage", "tabGroups", "tabs", "alarms"].sort());
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
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
