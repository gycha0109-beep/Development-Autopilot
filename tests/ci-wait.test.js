import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {CIWaitLedger,ciWaitTimeout,CI_WAIT_TIMEOUT_MS,CI_UNKNOWN_TIMEOUT_MS} from "../local/ci-wait.js";
import {inputs,ciEvidence,NOW} from "../test-support/autopilot-fixture.js";

test("CI wait episodes bind response and exact target, retain history and ignore sibling changes",()=>{
  const store=new WorkstreamStore();try{
    store.create({id:"work",name:"Test",projectKey:"project",repository:"owner/repo",trackKey:"track"},NOW);
    let ledger=new CIWaitLedger(store);
    const args=inputs({ci:ciEvidence()});
    let wait=ledger.record(args,false);
    assert.equal(ciWaitTimeout({...args,ci:{...args.ci,wait},now:NOW+CI_WAIT_TIMEOUT_MS},false),"CI_WAIT_TOO_LONG");
    args.ci.github.targets.push({workstreamId:"other",prNumber:99});
    assert.equal(ledger.record({...args,now:NOW+1000},false).startedAt,NOW);
    ledger=new CIWaitLedger(store); // same persistent DB, new runtime
    assert.equal(ledger.current("work").startedAt,NOW);
    args.ci.watchtower.targets[0].attempt=3;
    assert.equal(ciWaitTimeout({...args,ci:{...args.ci,wait},now:NOW+CI_WAIT_TIMEOUT_MS},false),null);
    wait=ledger.record({...args,now:NOW+2000},true);
    assert.equal(wait.startedAt,NOW+2000);assert.equal(wait.unknownSince,NOW+2000);
    assert.equal(ciWaitTimeout({...args,ci:{...args.ci,wait},now:NOW+2000+CI_UNKNOWN_TIMEOUT_MS},true),"CI_QUERY_UNAVAILABLE_TOO_LONG");
    wait=ledger.record({...args,now:NOW+3000},false);
    assert.equal(wait.unknownSince,null);assert.equal(wait.startedAt,NOW+2000);
    args.observation.replyFingerprint="e".repeat(64);
    assert.equal(ciWaitTimeout({...args,ci:{...args.ci,wait},now:NOW+CI_WAIT_TIMEOUT_MS},false),null);
    ledger.record({...args,now:NOW+4000},false);
    ledger.finish("work",NOW+5000,"CI_GATE_RELEASED");
    assert.equal(ledger.current("work"),null);
    const rows=store.db.prepare("SELECT * FROM autopilot_ci_waits ORDER BY id").all();
    assert.equal(rows.length,3);assert.ok(rows.every(r=>r.ended_at!==null));
    assert.equal(rows[0].end_reason,"CI_CONTEXT_CHANGED");
  }finally{store.close();}
});
