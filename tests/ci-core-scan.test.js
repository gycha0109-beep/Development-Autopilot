import test from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {CoreScanClient,CoreScanObserver,CoreScanError,validateScan}
  from "../local/ci-core-scan.js";

const REPO="owner/repo",SHA="a".repeat(40),EXE=resolve("ci-core-scan.exe");
function run(extra={}){
  return {runId:22,workflowId:2,workflowName:"CI",workflowPath:".github/workflows/ci.yml",
    ciKind:"general",ciState:"SUCCESS",status:"completed",conclusion:"success",
    headSha:SHA,headBranch:"main",runAttempt:2,runNumber:3,prNumbers:[9],
    integrationCandidateHeadSha:null,
    createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-01T00:03:00Z",
    targetVerified:false,requiredChecksVerified:false,safeToAdvance:false,...extra};
}
function response(extra={}){
  return {source:"github_actions_recent",repository:REPO,
    observedAt:new Date().toISOString(),apiRequests:6,maxApiRequests:6,
    sampleLimit:30,completeCoverage:false,targetVerified:false,
    requiredChecksVerified:false,safeToAdvance:false,runs:[run()],...extra};
}
test("green recent run is never verified or permission to resume",()=>{
  const r=validateScan(response(),REPO,30);
  assert.equal(r.runs[0].ciState,"SUCCESS");
  assert.equal(r.runs[0].targetVerified,false);
  assert.equal(r.safeToAdvance,false);
  assert.equal(r.requiredChecksVerified,false);
  assert.equal(r.completeCoverage,false);
});
test("reject scope, fake coverage, excess API use and duplicate run IDs",()=>{
  const bad=[
    {repository:"wrong/repo"},{safeToAdvance:true},{targetVerified:true},
    {requiredChecksVerified:true},{completeCoverage:true},{apiRequests:7},
    {sampleLimit:60},{observedAt:new Date(Date.now()-180000).toISOString()},
    {runs:[run({safeToAdvance:true})]},
    {runs:[run({headSha:"x"})]},
    {runs:[run({runAttempt:0})]},
    {runs:[run(),run()]},
  ];
  for(const extra of bad)assert.throws(()=>validateScan(response(extra),REPO,30),CoreScanError);
});
test("execFile only accepts explicit repository and bounded limit",async()=>{
  const calls=[];
  const client=new CoreScanClient({platform:"win32",binaryPath:EXE,
    exec:async(path,args,options)=>{
      calls.push({path,args,options});
      return {stdout:JSON.stringify({contractVersion:"ci-core-scan/0.1",data:response()})};
    }});
  const r=await client.read(REPO);
  assert.equal(r.runs.length,1);
  assert.deepEqual(calls[0].args,["--repository","owner/repo","--limit","30"]);
  assert.equal(calls[0].options.shell,false);
  await assert.rejects(client.read("owner/repo?token="),e=>e.code==="INVALID_TARGET");
  assert.equal(calls.length,1);
});
test("safe throttling code and child stderr are kept separate",async()=>{
  const client=new CoreScanClient({platform:"win32",binaryPath:EXE,
    exec:async()=>{
      const e=new Error("PAT must never be included");
      e.stdout=JSON.stringify({contractVersion:"ci-core-scan/0.1",
        error:{code:"GITHUB_RATE_LIMITED"}});
      e.stderr="sensitive raw response";throw e;
    }});
  await assert.rejects(client.read(REPO),e=>e.code==="GITHUB_RATE_LIMITED"&&
    !e.message.includes("PAT"));
});
test("registry-enabled repositories scanned at most twice per cycle",async()=>{
  const repos=Array.from({length:5},(_,i)=>({id:i+1,name:"owner/repo"+i,enabled:true}));
  let calls=0;
  const observer=new CoreScanObserver({registry:{current:()=>({status:"observed",repositories:repos})},
    client:{configured:true,read:async()=>{calls++;return {runs:[],observedAt:new Date().toISOString()};}}});
  const snapshot=await observer.refresh();
  assert.equal(snapshot.launched,2);
  assert.equal(calls,2);
  assert.equal(snapshot.repositories.filter(r=>r.reason==="SCAN_RATE_BUDGET").length,3);
  assert.equal(snapshot.safeToAdvance,false);
});
test("API forbidden or rate limiting enters 15-minute backoff",async()=>{
  const repos=[{id:1,name:REPO,enabled:true},{id:2,name:"owner/next",enabled:true}];
  let calls=0,now=Date.now();
  const observer=new CoreScanObserver({registry:{current:()=>({status:"observed",repositories:repos})},
    now:()=>now,client:{configured:true,read:async()=>{
      calls++;throw new CoreScanError("GITHUB_FORBIDDEN");
    }}});
  const first=await observer.refresh();
  assert.equal(calls,1);
  assert.equal(first.launched,1);
  assert.equal(first.repositories[0].reason,"GITHUB_FORBIDDEN");
  assert.equal(first.repositories[1].reason,"SCAN_AUTH_BACKOFF");
  now+=120001;
  const second=await observer.refresh();
  assert.equal(calls,1);
  assert.equal(second.safeToAdvance,false);
  now+=15*60_000+1;
  await observer.refresh();
  assert.equal(calls,2);
});
test("unavailable registry never triggers GitHub requests",async()=>{
  let calls=0;
  const obs=new CoreScanObserver({registry:{current:()=>({status:"unavailable"})},
    client:{configured:true,read:async()=>{calls++;throw Error("never");}}});
  assert.equal((await obs.refresh()).status,"unavailable");
  assert.equal(calls,0);
});
