import test from "node:test";
import assert from "node:assert/strict";
import {macroCiTargets} from "../local/macro-ci-targets.js";

test("active multi-repo chat adds primary and extra GitHub CI poll targets",()=>{
  const targets=macroCiTargets([
    {enabled:1,mode:"auto",repository:"owner/MyeongHa",ci_branch:"main",
      ci_observers_json:JSON.stringify([{repository:"owner/Saju",branch:"main"}])},
    {enabled:1,mode:"auto",repository:"owner/MyeongHa",ci_branch:"main",
      ci_observers_json:"[]"},
    {enabled:0,mode:"auto",repository:"owner/Stopped",ci_branch:"main",
      ci_observers_json:JSON.stringify([{repository:"owner/Hidden",branch:"main"}])}
  ]);
  assert.deepEqual(targets,[
    {repository:"owner/MyeongHa",branch:"main"},
    {repository:"owner/Saju",branch:"main"}
  ]);
});
test("invalid or legacy stored extra observers never inject a poll target",()=>{
  assert.deepEqual(macroCiTargets([
    {enabled:1,mode:"auto",repository:"owner/A",ci_branch:null,ci_observers_json:"broken"},
    {enabled:1,mode:"manual",repository:"owner/B",ci_branch:"main",
      ci_observers_json:'[{"repository":"owner/C","branch":"main"}]'}
  ]),[]);
});
