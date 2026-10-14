import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";

test("delete workstream clears all direct dependent tables atomically and leaves other workstreams",()=>{
  const store=new WorkstreamStore();
  try{
    const a=store.create({id:"remove",name:"Autopilot 테스트 D",projectKey:"test",repository:"owner/repo"});
    store.create({id:"keep",name:"Autopilot 테스트 A",projectKey:"test",repository:"owner/repo"});
    store.db.exec("CREATE TABLE IF NOT EXISTS chrome_workstream_test("+
      "workstream_id TEXT REFERENCES workstreams(id), detail TEXT) STRICT;");
    store.db.prepare("INSERT INTO chrome_workstream_test(workstream_id,detail) VALUES(?,?)")
      .run(a.id,"linked");
    assert.throws(()=>store.deleteWorkstream("remove","wrong"),/DELETE_CONFIRM_NAME_MISMATCH/);
    assert.equal(store.list().length,2);
    const deleted=store.deleteWorkstream("remove","Autopilot 테스트 D");
    assert.deepEqual(deleted,{deleted:true,id:"remove",name:"Autopilot 테스트 D"});
    assert.equal(store.get("remove"),null);
    assert.equal(store.list().length,1);
    assert.equal(store.list()[0].id,"keep");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM chrome_workstream_test").get().n,0);
    assert.equal(store.events().some(e=>e.workstream_id==="remove"),false);
    assert.throws(()=>store.deleteWorkstream("remove","Autopilot 테스트 D"),
      /작업축을 찾을 수 없습니다/);
  }finally{store.close()}
});
test("delete blocks active work and claimed ChatGPT command without partial removal",()=>{
  const store=new WorkstreamStore();
  try{
    store.create({id:"active",name:"진행 작업축",projectKey:"test",repository:"owner/repo"});
    store.db.prepare(
      "UPDATE workstreams SET state='WAIT_EXTERNAL',active_operation_id='active-op' WHERE id='active'"
    ).run();
    assert.throws(()=>store.deleteWorkstream("active","진행 작업축"),
      /DELETE_WORKSTREAM_ACTIVE_OPERATION/);
    assert.ok(store.get("active"));
    store.db.prepare("UPDATE workstreams SET state='OBSERVING',active_operation_id=NULL WHERE id='active'").run();
    store.db.exec(
      "CREATE TABLE chat_continuation_commands(id TEXT,workstream_id TEXT REFERENCES workstreams(id),state TEXT);"
    );
    store.db.prepare("INSERT INTO chat_continuation_commands VALUES('cmd','active','claimed')").run();
    assert.throws(()=>store.deleteWorkstream("active","진행 작업축"),
      /DELETE_WORKSTREAM_COMMAND_IN_FLIGHT/);
    assert.ok(store.get("active"));
    store.db.prepare("UPDATE chat_continuation_commands SET state='queued'").run();
    assert.equal(store.deleteWorkstream("active","진행 작업축").deleted,true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM chat_continuation_commands").get().n,0);
  }finally{store.close()}
});
