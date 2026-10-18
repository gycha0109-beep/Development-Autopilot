import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkstreamStore} from "../local/store.js";
import {FairWorkQueue} from "../local/fair-work-queue.js";
import {queueLimits} from "../test-support/queue-limits.js";

function fixture(patches={}){
  const store=new WorkstreamStore();let now=1000;
  for(const id of ["a","b","c"])store.create({id,name:id,projectKey:"project",repository:"owner/repo"},now);
  const limits=queueLimits(patches),make=()=>new FairWorkQueue(store,{limits,now:()=>now});
  return {store,queue:make(),make,limits,clock:at=>{now=at;}};
}
const task=(kind,key)=>({kind,resourceKey:key,workstreamId:key});

test("purpose queues have independent concurrent budgets and reserve leases before callbacks",async()=>{
  const f=fixture({inspect:{maxConcurrent:1}});let release;
  try{
    const first=f.queue.run(task("inspect","a"),()=>new Promise(resolve=>{release=()=>resolve("a");
      assert.equal(f.queue.task("inspect","a").status,"running");}));
    assert.equal((await f.make().run(task("inspect","b"),async()=>"b")).reasonCode,"QUEUE_CONCURRENCY_LIMIT");
    assert.equal((await f.queue.run(task("ci","c"),async()=>"ci")).outcome,"completed");
    release();assert.equal((await first).value,"a");
    assert.equal((await f.queue.run(task("inspect","b"),async()=>"b")).value,"b");
  }finally{f.store.close();}
});

test("never-served pending axes precede repeated busy axes and cannot be starved",async()=>{
  const f=fixture({inspect:{maxConcurrent:1}});let release;
  try{
    const first=f.queue.run(task("inspect","a"),()=>new Promise(resolve=>{release=resolve;}));
    await f.queue.run(task("inspect","b"),async()=>"b");release();await first;
    assert.equal((await f.queue.run(task("inspect","a"),async()=>"again")).reasonCode,"QUEUE_FAIR_TURN");
    assert.equal((await f.queue.run(task("inspect","b"),async()=>"b")).value,"b");
    assert.equal((await f.queue.run(task("inspect","a"),async()=>"again")).value,"again");
  }finally{f.store.close();}
});

test("rate clocks persist across queue recreation and one purpose never consumes another purpose budget",async()=>{
  const f=fixture();try{
    assert.equal((await f.queue.run(task("dispatch","a"),async()=>"a")).ran,true);
    const restored=f.make();assert.equal((await restored.run(task("dispatch","b"),async()=>"b")).reasonCode,"QUEUE_RATE_LIMIT");
    assert.equal((await restored.run(task("inspect","c"),async()=>"inspect")).ran,true);
    f.clock(2000);assert.equal((await restored.run(task("dispatch","b"),async()=>"b")).value,"b");
  }finally{f.store.close();}
});

test("read-only failures use bounded exponential backoff/jitter; mutation failures cannot replay",async()=>{
  const f=fixture();let calls=0;
  try{
    for(let i=0;i<3;i++){
      await f.queue.run(task("inspect","a"),async()=>{calls++;throw Error("PRIVATE_FAILURE");});
      f.clock(f.queue.task("inspect","a").next_eligible_at);
    }
    assert.equal((await f.queue.run(task("inspect","a"),async()=>{calls++;})).blocked,true);assert.equal(calls,3);
    await f.queue.run(task("notify","b"),async()=>{throw Error("ACK_LOST");});
    assert.equal((await f.queue.run(task("notify","b"),async()=>{throw Error("NO_REPLAY");})).blocked,true);
    assert.equal((await f.queue.run(task("inspect","c"),async()=>"other")).value,"other");
    assert.doesNotMatch(JSON.stringify(f.store.db.prepare("SELECT * FROM autopilot_queue_tasks").all()),/PRIVATE_FAILURE|ACK_LOST/);
  }finally{f.store.close();}
});

test("expired lease discards late read results, while write leases become UNKNOWN after restart",async()=>{
  const f=fixture({inspect:{leaseMs:1000},recovery:{leaseMs:1000}});let releaseRead,releaseWrite;
  try{
    const read=f.queue.run(task("inspect","a"),()=>new Promise(resolve=>{releaseRead=()=>resolve("PRIVATE_LATE_RESULT");}));
    const write=f.queue.run(task("recovery","b"),()=>new Promise(resolve=>{releaseWrite=resolve;}));
    f.clock(2001);const restored=f.make();assert.equal(restored.reconcile(),2);
    releaseRead();releaseWrite();assert.equal((await read).value,null);assert.equal((await write).outcome,"unknown");
    assert.equal(restored.task("recovery","b").status,"unknown");assert.equal(restored.task("inspect","a").status,"pending");
    assert.equal((await restored.run(task("recovery","b"),async()=>"no")).blocked,true);
  }finally{f.store.close();}
});

test("paused pending axes cannot starve others and STOP forbids new callbacks",async()=>{
  const f=fixture({inspect:{maxConcurrent:1}});let release;
  try{
    const first=f.queue.run(task("inspect","a"),()=>new Promise(resolve=>{release=resolve;}));
    await f.queue.run(task("inspect","b"),async()=>{});release();await first;
    f.store.configure("b",{paused:true},1000);
    assert.equal((await f.queue.run(task("inspect","a"),async()=>"a")).value,"a");
    assert.equal(f.queue.cancelPending("b"),1);f.store.setStopped(true,1000);
    assert.equal((await f.queue.run(task("inspect","c"),async()=>{throw Error("SHOULD_NOT_RUN");})).reasonCode,"GLOBAL_STOP");
  }finally{f.store.close();}
});

test("a restart cannot silently broaden a persisted policy or reassign an existing resource",async()=>{
  const f=fixture();try{
    assert.throws(()=>new FairWorkQueue(f.store,{limits:queueLimits({inspect:{maxConcurrent:20}})}),/REQUIRES_REVIEW/);
    await f.queue.run(task("inspect","a"),async()=>{});
    await assert.rejects(f.queue.run({kind:"inspect",resourceKey:"a",workstreamId:"b"},async()=>{}),/OWNER_MISMATCH/);
    await assert.rejects(f.queue.run({kind:"inspect",resourceKey:"https://private.invalid"},async()=>{}),/INVALID_QUEUE_TASK/);
  }finally{f.store.close();}
});

test("two independent SQLite handles share one global concurrency/rate lease",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-queue-")),path=join(dir,"queue.sqlite3");
  const a=new WorkstreamStore(path),b=new WorkstreamStore(path);let release;
  try{
    for(const id of ["a","b"])a.create({id,name:id,projectKey:"project",repository:"owner/repo"},1000);
    const options={limits:queueLimits({inspect:{maxConcurrent:1}}),now:()=>1000};
    const one=new FairWorkQueue(a,options),two=new FairWorkQueue(b,options);
    const pending=one.run(task("inspect","a"),()=>new Promise(resolve=>{release=resolve;}));
    assert.equal((await two.run(task("inspect","b"),async()=>"b")).reasonCode,"QUEUE_CONCURRENCY_LIMIT");
    release();await pending;assert.equal((await two.run(task("inspect","b"),async()=>"b")).value,"b");
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
