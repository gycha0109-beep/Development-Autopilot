import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const runner=fileURLToPath(new URL("../local/telegram-managed-runtime.mjs",import.meta.url));

test("managed SUN runner refuses known-exposed keys in its pure security self-test",()=>{
  const result=execFileSync(process.execPath,[runner,"--selftest"],{
    encoding:"utf8",timeout:10000,windowsHide:true
  });
  assert.match(result,/TELEGRAM_MANAGED_ROTATION_GUARD_SELFTEST_PASS/);
  assert.doesNotMatch(result,/bot[0-9]{6,}:/i);
});
