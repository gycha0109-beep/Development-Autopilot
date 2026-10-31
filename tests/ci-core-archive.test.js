import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {CoreRunArchive} from "../local/ci-core-archive.js";

let now=Date.parse("2026-11-01T06:00:00.000Z");
const sha="a".repeat(40);
const repo={id:2,projectId:1,name:"owner/repo",enabled:true};
const registry={status:"observed",repositories:[repo],
  tracks:[{id:3,projectId:1,canonicalTrackKey:"ops"}]};
const run=(changes={})=>({
  runId:44,runAttempt:1,workflowId:20,workflowName:"Fast CI",ciKind:"general",
  headSha:sha,ciState:"RUNNING",status:"in_progress",conclusion:null,
  updatedAt:"2026-11-01T05:59:30Z",safeToAdvance:false,
  targetVerified:false,requiredChecksVerified:false,...changes});
const scan=(runs=[run()],changes={})=>({
  status:"observed",checkedAt:now,completeCoverage:false,safeToAdvance:false,
  repositories:[{repositoryId:2,repository:repo.name,status:"observed",
    observedAt:new Date(now).toISOString(),runs}],...changes});
const history=(runs=[])=>({status:"observed",repositories:[{repository:repo.name,status:"observed",runs}]});
function setup(){
  const store=new WorkstreamStore(":memory:");
  const archive=new CoreRunArchive(store,{now:()=>now});
  return {store,archive};
}
test("live scan is written into Autopilot-owned database with zero approval",()=>{
  const {store,archive}=setup();
  try{
    const result=archive.capture(scan(),registry,history());
    assert.equal(result.status,"recorded");
    assert.equal(result.accepted,1);
    assert.equal(result.changes,1);
    assert.equal(result.totals.runs,1);
    assert.equal(result.totals.attempts,1);
    assert.equal(result.safeToAdvance,false);
    assert.equal(archive.latest()[0].attribution,"UNATTRIBUTED");
    assert.equal(archive.latest()[0].safeToAdvance,false);
    assert.equal(archive.events()[0].kind,"DISCOVERED");
  }finally{store.close()}
});
test("replayed snapshot and repeated scan do not duplicate records or notifications",()=>{
  const {store,archive}=setup();
  try{
    archive.capture(scan(),registry);
    assert.equal(archive.capture(scan(),registry).accepted,0);
    now+=120_001;
    const result=archive.capture(scan([run()]),registry);
    assert.equal(result.totals.runs,1);
    assert.equal(result.totals.attempts,1);
    assert.equal(archive.events().length,1);
    assert.equal(result.changes,0);
  }finally{store.close()}
});
test("next attempt and state transitions are separately durable",()=>{
  const {store,archive}=setup();
  try{
    archive.capture(scan(),registry);
    now+=120_001;
    const first=archive.capture(scan([run({ciState:"SUCCESS",status:"completed",
      conclusion:"success",updatedAt:"2026-11-01T06:01:01Z"})]),registry);
    assert.equal(first.changes,1);
    now+=120_001;
    const next=archive.capture(scan([run({runAttempt:2,ciState:"QUEUED",status:"queued",
      updatedAt:"2026-11-01T06:03:01Z"})]),registry);
    assert.equal(next.totals.runs,1);
    assert.equal(next.totals.attempts,2);
    assert.equal(archive.events().length,3);
    assert.equal(next.safeToAdvance,false);
  }finally{store.close()}
});
test("older source updates cannot change newer result",()=>{
  const {store,archive}=setup();
  try{
    archive.capture(scan([run({ciState:"SUCCESS",status:"completed",
      conclusion:"success",updatedAt:"2026-11-01T05:59:59Z"})]),registry);
    now+=120_001;
    const result=archive.capture(scan([run({ciState:"FAILURE",status:"completed",
      conclusion:"failure",updatedAt:"2026-11-01T05:59:30Z"})]),registry);
    assert.equal(result.accepted,0);
    assert.equal(archive.latest()[0].ciState,"SUCCESS");
    assert.equal(archive.events().length,1);
  }finally{store.close()}
});
test("a head SHA conflict rolls the whole batch back",()=>{
  const {store,archive}=setup();
  try{
    archive.capture(scan(),registry);
    now+=120_001;
    const result=archive.capture(scan([run({headSha:"b".repeat(40)})]),registry);
    assert.equal(result.status,"unavailable");
    assert.equal(result.reason,"RUN_HEAD_CONFLICT");
    assert.equal(archive.latest()[0].headSha,sha);
    assert.equal(archive.events().length,1);
  }finally{store.close()}
});
test("historical exact attribution preserved and conflicting claims fail closed",()=>{
  const {store,archive}=setup();
  try{
    const verified={runId:44,headSha:sha,workTrackId:3,workTrackKey:"ops",
      attributionConflict:false};
    archive.capture(scan(),registry,history([verified]));
    assert.equal(archive.latest()[0].attribution,"HISTORICAL_EXACT");
    assert.equal(archive.latest()[0].trackKey,"ops");
    now+=120_001;
    archive.capture(scan([run({ciState:"SUCCESS",status:"completed",conclusion:"success",
      updatedAt:"2026-11-01T06:01:01Z"})]),registry,history([
        {...verified,workTrackId:null,attributionConflict:true}
      ]));
    assert.equal(archive.latest()[0].trackKey,"ops");
    assert.equal(archive.latest()[0].safeToAdvance,false);
  }finally{store.close()}
});
test("invalid/mismatched/stale snapshots write nothing",()=>{
  const {store,archive}=setup();
  try{
    assert.equal(archive.capture(scan([run({safeToAdvance:true})]),registry).reason,
      "RUN_IDENTITY_INVALID");
    assert.equal(archive.capture(scan([run({headSha:"bad"})]),registry).reason,
      "RUN_IDENTITY_INVALID");
    assert.equal(archive.capture(scan([run()],{checkedAt:now-120000}),registry).reason,
      "FRESH_SCAN_REQUIRED");
    assert.equal(archive.capture(scan([run()],{repositories:[
      {repositoryId:999,repository:repo.name,status:"observed",
        observedAt:new Date(now).toISOString(),runs:[run()]}
    ]}),registry).reason,"SCAN_IDENTITY_INVALID");
    assert.equal(archive.current().totals.attempts,0);
  }finally{store.close()}
});
test("partial/failed scan does not imply green, archives only successful repositories",()=>{
  const {store,archive}=setup();
  try{
    const input=scan([run()],{repositories:[
      {repositoryId:2,repository:repo.name,status:"observed",
        observedAt:new Date(now).toISOString(),runs:[run()]},
      {repositoryId:3,repository:"owner/error",status:"unavailable",reason:"GITHUB_FORBIDDEN",runs:[]}
    ]});
    const result=archive.capture(input,registry);
    assert.equal(result.totals.attempts,1);
    assert.equal(result.safeToAdvance,false);
    assert.equal(result.completeCoverage,false);
  }finally{store.close()}
});
