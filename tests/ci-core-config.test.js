import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {configureVerifiedLocalCore} from "../local/ci-core-config.js";
const names=["ci-core-inspect.exe","ci-core-registry.exe","ci-core-history.exe","ci-core-scan.exe"];
test("all four pinned files activate without touching tokens or other env",()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-core-pins-"));
  try{
    const hashes={};
    for(const [i,name] of names.entries()){
      const content=Buffer.from("fake-win-binary-"+i);
      writeFileSync(join(dir,name),content);
      hashes[name]=createHash("sha256").update(content).digest("hex");
    }
    const cfg=join(dir,"config.json");writeFileSync(cfg,"\uFEFF"+JSON.stringify({enabled:true,directory:dir,sha256:hashes}));
    const env={AUTOPILOT_TELEGRAM_ENABLED:"1",GH_TOKEN:"not-read"};
    const result=configureVerifiedLocalCore({configPath:cfg,env});
    assert.equal(result.status,"verified");
    assert.equal(result.configured,true);
    assert.equal(env.AUTOPILOT_TELEGRAM_ENABLED,"1");
    assert.equal(env.GH_TOKEN,"not-read");
    assert.equal(env.CI_CORE_INSPECT_EXE,join(dir,names[0]));
    assert.equal(env.CI_CORE_SCAN_EXE,join(dir,names[3]));
    writeFileSync(join(dir,names[3]),"tampered");
    const clean={};
    const denied=configureVerifiedLocalCore({configPath:cfg,env:clean});
    assert.equal(denied.status,"binary_verification_failed");
    assert.equal(denied.configured,false);
    assert.equal(clean.CI_CORE_INSPECT_EXE,undefined);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test("missing, disabled and malformed config never enable Core",()=>{
  const env={};
  assert.equal(configureVerifiedLocalCore({configPath:join(tmpdir(),"absent-ci-core-82738723.json"),env}).configured,false);
  assert.equal(env.CI_CORE_INSPECT_EXE,undefined);
  const dir=mkdtempSync(join(tmpdir(),"autopilot-core-disabled-"));
  try{
    const cfg=join(dir,"config.json");writeFileSync(cfg,'{"enabled":false}');
    assert.equal(configureVerifiedLocalCore({configPath:cfg,env}).status,"invalid_config");
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test("operator environment remains an explicit existing opt-in",()=>{
  const env={CI_CORE_INSPECT_EXE:"C:\\Program Files\\Core\\ci-core-inspect.exe"};
  const r=configureVerifiedLocalCore({configPath:"bad",env});
  assert.equal(r.status,"operator_environment");
});
