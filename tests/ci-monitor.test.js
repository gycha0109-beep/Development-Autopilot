import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {inspectCiAnomalies,CiMonitor} from "../local/ci-monitor.js";

const NOW=3_000_000;
const sampleRun=(overrides={})=>({
  runId:81,runAttempt:1,headSha:"a".repeat(40),ciState:"FAILURE",
  createdAt:new Date(NOW-45*60_000).toISOString(),...overrides
});
const snapshot=(runs=[sampleRun()],overrides={})=>({
  registry:{status:"observed",checkedAt:NOW-200},
  scan:{status:"observed",checkedAt:NOW-100,
    repositories:[{repository:"owner/repo",repositoryId:2,status:"observed",
      observedAt:new Date(NOW-100).toISOString(),runs}]},
  github:{status:"observed",checkedAt:NOW-100,targets:[],results:[]},
  directCore:{status:"observed",checkedAt:NOW-100,results:[]},
  archive:{findRun:()=>({headSha:"a".repeat(40),attribution:"UNATTRIBUTED"})},
  ...overrides
});
test("CI failures, stalls, track and PR drift are detected from fresh observations",()=>{
  const data=snapshot([sampleRun(),sampleRun({runId:82,ciState:"RUNNING"})],{
    github:{status:"observed",checkedAt:NOW-100,
      targets:[{workstreamId:"a"}],results:[{workstreamId:"a",state:"UNKNOWN",
        reason:"PR_HEAD_SHA_DRIFT"}]},
    directCore:{status:"observed",checkedAt:NOW-100,
      results:[{workstreamId:"a",reason:"DIRECT_ATTEMPT_CHANGED"}]}
  });
  const x=inspectCiAnomalies({...data,now:NOW});
  for(const code of ["CI_FAILED","CI_STALLED","TRACK_UNATTRIBUTED","PR_HEAD_DRIFT","CI_ATTEMPT_DRIFT"])
    assert.ok(x.findings.some(y=>y.code===code),code);
  assert.equal(x.safeToAdvance,false);
});
test("event is durable and deduplicated, recovery only for the observed exact run",()=>{
  const store=new WorkstreamStore();
  try{
    const monitor=new CiMonitor(store,{now:()=>NOW,alertsEnabled:false});
    const input=snapshot();
    let x=monitor.capture(input);
    assert.equal(x.changes,2);
    assert.equal(x.open,2);
    assert.equal(x.notifications.length,2);
    assert.equal(x.notifications.every(n=>n.state==="suppressed"),true);
    x=monitor.capture(input);
    assert.equal(x.changes,0);
    assert.equal(x.notifications.length,2);
    x=monitor.capture(snapshot([]));
    assert.equal(x.changes,0);
    assert.equal(x.open,2);
    x=monitor.capture(snapshot([sampleRun({ciState:"SUCCESS"})]));
    assert.equal(x.changes,1);
    assert.equal(x.open,1);
    assert.equal(x.notifications.length,3);
    x=monitor.capture(input);
    assert.equal(x.changes,1);
    assert.equal(x.open,2);
    assert.equal(x.notifications.length,4);
  }finally{store.close();}
});
test("separate opt-in Telegram channel uses one-shot fake delivery and never auto-resumes",async()=>{
  const store=new WorkstreamStore();
  const messages=[];
  try{
    const monitor=new CiMonitor(store,{now:()=>NOW,alertsEnabled:true,
      sender:async text=>{messages.push(text);return true;}});
    const trustedArchive={findRun:()=>({headSha:"a".repeat(40),
      attribution:"HISTORICAL_EXACT"})};
    monitor.capture(snapshot([sampleRun({ciState:"SUCCESS"})],{archive:trustedArchive}));
    monitor.capture(snapshot([sampleRun({ciState:"FAILURE"})],{archive:trustedArchive}));
    assert.equal(monitor.current().notifications.length,1);
    assert.equal((await monitor.drain()).status,"accepted");
    assert.equal(messages.length,1);
    assert.equal((await monitor.drain()).status,"empty");
    assert.equal(messages.length,1);
    assert.equal(monitor.current().safeToAdvance,false);
  }finally{store.close();}
});
test("unknown provider delivery is never retried and claims become unknown after restart",async()=>{
  const store=new WorkstreamStore();
  try{
    const args={now:()=>NOW,alertsEnabled:true,sender:async()=>{throw Error("unconfirmed")}};
    const monitor=new CiMonitor(store,args);
    const trustedArchive={findRun:()=>({headSha:"a".repeat(40),
      attribution:"HISTORICAL_EXACT"})};
    monitor.capture(snapshot([sampleRun({ciState:"SUCCESS"})],{archive:trustedArchive}));
    monitor.capture(snapshot([sampleRun({ciState:"FAILURE"})],{archive:trustedArchive}));
    assert.equal((await monitor.drain()).status,"unknown");
    assert.equal((await monitor.drain()).status,"empty");
    const duplicate=new CiMonitor(store,args);
    duplicate.capture(snapshot([sampleRun({ciState:"FAILURE"})],{
      archive:{findRun:()=>({headSha:"a".repeat(40),attribution:"HISTORICAL_EXACT"})}
    }));
    assert.equal(duplicate.current().notifications.length,1);
    assert.equal((await duplicate.drain()).status,"empty");
  }finally{store.close();}
});
test("unavailable source never silently resolves previously failed CI",()=>{
  const store=new WorkstreamStore();
  try{
    const monitor=new CiMonitor(store,{now:()=>NOW,alertsEnabled:false});
    monitor.capture(snapshot([sampleRun()],{
      archive:{findRun:()=>({headSha:"a".repeat(40),attribution:"HISTORICAL_EXACT"})}
    }));
    monitor.capture(snapshot([],{scan:{status:"unavailable",errorCode:"GITHUB_RATE_LIMITED"}}));
    assert.equal(monitor.current().incidents.find(x=>x.code==="CI_FAILED").state,"open");
    assert.ok(monitor.current().incidents.some(x=>x.code==="CI_COLLECTION_UNAVAILABLE"));
  }finally{store.close();}
});


test("registry mapping changes create a deduplicated drift episode and restoration resolves it",()=>{
  const store=new WorkstreamStore();
  try{
    const monitor=new CiMonitor(store,{now:()=>NOW,alertsEnabled:false});
    const base=snapshot([],{registry:{status:"observed",checkedAt:NOW-100,
      projects:[{id:1,key:"demo"}],repositories:[{id:2,projectId:1,name:"owner/repo",enabled:true}],
      tracks:[{id:3,projectId:1,canonicalTrackKey:"ops",active:true}]}});
    monitor.capture(base);
    assert.equal(monitor.current().incidents.length,0);
    const changed={...base,registry:{...base.registry,
      repositories:[{id:2,projectId:1,name:"owner/repo",enabled:false}]}};
    assert.equal(monitor.capture(changed).changes,1);
    assert.equal(monitor.capture(changed).changes,0);
    assert.equal(monitor.current().incidents.find(x=>x.code==="CI_REGISTRY_DRIFT").state,"open");
    assert.equal(monitor.capture(base).changes,1);
    assert.equal(monitor.current().incidents.find(x=>x.code==="CI_REGISTRY_DRIFT").state,"resolved");
  }finally{store.close();}
});
test("missing pending required checks and completed workstream disagreement raise advisory incidents",()=>{
  const target={workstreamId:"stream",configuredAt:NOW-40*60000};
  const x=inspectCiAnomalies({...snapshot([]),now:NOW,
    github:{status:"observed",checkedAt:NOW-100,targets:[target],
      results:[{workstreamId:"stream",state:"WAIT_EXTERNAL",reason:"REQUIRED_CHECK_PENDING",
        checks:[{name:"CI",state:"PENDING"}]}]},
    workstreams:[{id:"stream",state:"COMPLETE"}]
  });
  assert.ok(x.findings.some(i=>i.code==="EXPECTED_CHECK_STALLED"));
  assert.ok(x.findings.some(i=>i.code==="WORKSTREAM_GITHUB_DRIFT"));
  assert.equal(x.safeToAdvance,false);
});
