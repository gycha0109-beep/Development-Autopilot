import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {HumanApprovalAlerts} from "../local/human-approval-alerts.js";
import {ChatContinuation} from "../local/chat-continuation.js";

const EXT="abcdefghijklmnopabcdefghijklmnop",SESSION="pie-session";
function setup(){
  const store=new WorkstreamStore();
  store.create({id:"pie",name:"PIE 데이터 분석",projectKey:"pie",
    repository:"owner/pie"},1_000_000);
  let now=1_000_000;
  const sent=[];
  const alerts=new HumanApprovalAlerts(store,{now:()=>now,
    send:async text=>{sent.push(text);}});
  const observed=(pending,tool="Remote Desktop Commander",extra={})=>({
    verified:true,uiAmbiguous:false,connectionWarning:false,
    providerRestriction:false,otherWarning:false,
    toolApproval:{observed:true,pending,kind:"tool_permission",tool},...extra
  });
  return {store,alerts,sent,now:()=>now,clock:n=>{now=n},observed,
    close:()=>store.close()};
}
test("per-workstream tool gate sends one Telegram notification per approval episode, no duplicate",async()=>{
  const x=setup();try{
    assert.deepEqual(x.alerts.observe("pie",EXT,SESSION,x.observed(true)),
      {accepted:true,pending:true,newAlert:true});
    assert.equal(x.alerts.active("pie"),true);
    assert.equal(x.alerts.observe("pie",EXT,SESSION,x.observed(true)).newAlert,false);
    await x.alerts.flush();await x.alerts.flush();
    assert.equal(x.sent.length,1);
    assert.match(x.sent[0],/PIE 데이터 분석/);
    assert.match(x.sent[0],/Remote Desktop Commander/);
    assert.doesNotMatch(x.sent[0],/한 번만 허용|Windows 장치/);
    assert.equal(x.alerts.status().alerts[0].notification,"sent");
    x.clock(1_010_000);
    assert.equal(x.alerts.observe("pie",EXT,SESSION,x.observed(false)).pending,true);
    x.clock(1_026_000);
    assert.equal(x.alerts.observe("pie",EXT,SESSION,x.observed(false)).cleared,true);
    assert.equal(x.alerts.active("pie"),false);
    x.clock(1_030_000);
    assert.equal(x.alerts.observe("pie",EXT,SESSION,x.observed(true)).newAlert,true);
    await x.alerts.flush();
    assert.equal(x.sent.length,2,"new approval episode, same tool, may notify again");
  }finally{x.close()}
});
test("ambiguous page or single disappearance cannot clear approval gate",()=>{
  const x=setup();try{
    x.alerts.observe("pie",EXT,SESSION,x.observed(true));
    x.clock(1_050_000);
    x.alerts.observe("pie",EXT,SESSION,x.observed(false,undefined,{uiAmbiguous:true}));
    assert.equal(x.alerts.active("pie"),true);
    x.alerts.observe("pie",EXT,SESSION,x.observed(false));
    assert.equal(x.alerts.active("pie"),true);
    x.clock(1_080_000);
    x.alerts.observe("pie",EXT,SESSION,x.observed(false,undefined,{verified:false}));
    assert.equal(x.alerts.active("pie"),true);
    x.alerts.observe("pie",EXT,SESSION,x.observed(false));
    assert.equal(x.alerts.active("pie"),false);
  }finally{x.close()}
});
test("unconfigured Telegram keeps durable pending alert, never marks sent",async()=>{
  const x=setup();try{
    const alerts=new HumanApprovalAlerts(x.store,{now:x.now,token:"",chatId:""});
    alerts.observe("pie",EXT,SESSION,x.observed(true));
    assert.equal((await alerts.flush()).configured,false);
    assert.equal(alerts.status().alerts[0].notification,"pending");
  }finally{x.close()}
});
test("interrupted delivery is unknown, not automatically resent after restart",async()=>{
  const x=setup();try{
    x.alerts.observe("pie",EXT,SESSION,x.observed(true));
    x.store.db.exec("UPDATE chat_tool_permission_alerts SET notify_state='sending'");
    const again=new HumanApprovalAlerts(x.store,{now:x.now,
      send:async t=>x.sent.push(t)});
    assert.equal(again.status().alerts[0].notification,"unknown");
    await again.flush();
    assert.equal(x.sent.length,0);
  }finally{x.close()}
});
test("live tool approval pauses scheduled sends, then response must complete again before resuming",()=>{
  const x=setup();try{
    const bridge={getSnapshot:()=>({
      clients:[{extensionId:EXT,status:"online",composerBuild:"composer-2026-10-15-r17"}],
      sessions:[{extensionId:EXT,sessionKey:SESSION,status:"connected",origin:"https://chatgpt.com"}],
      links:[{workstreamId:"pie",extensionId:EXT,sessionKey:SESSION,status:"connected"}]
    })};
    const empty={targets:{list:()=>[]}};
    const chat=new ChatContinuation(x.store,{bridge,watchtower:empty,github:empty,
      gate:{one:()=>null},now:x.now});
    chat.configure("pie",{enabled:true,mode:"scheduled",
      message:"로드맵 따라서 계속 진행",intervalMinutes:1});
    function sample(pending=false,overrides={}){
      return {schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",
        verified:true,observedAt:x.now(),assistantBusy:false,composerHasDraft:false,
        stopControlVerified:false,contentComplete:true,uiAmbiguous:false,
        connectionWarning:false,lengthWarning:false,providerRestriction:false,
        otherWarning:false,humanActionCue:pending,scopeCompleteCue:false,
        ciWaitCue:false,bindingFingerprint:"b".repeat(64),
        replyFingerprint:"a".repeat(64),
        toolApproval:{observed:true,pending,kind:"tool_permission",
          tool:"Remote Desktop Commander"},...overrides};
    }
    function submit(pending=false,overrides={}){
      const req=chat.requestObservations(EXT)[0];
      assert.ok(req);
      return chat.acceptObservation(EXT,{requestId:req.requestId,
        observation:sample(pending,overrides)});
    }
    x.clock(1_030_000);submit(true);
    assert.equal(chat.config("pie").enabled,true);
    assert.equal(chat.config("pie").statusReason,"WAITING_HUMAN_APPROVAL");
    x.clock(1_090_000);assert.equal(chat.tick().length,0);
    submit(true);
    assert.equal(chat.approvals.status().alerts.length,1);
    x.clock(1_100_000);submit(false,{assistantBusy:true});
    assert.equal(chat.tick().length,0);
    x.clock(1_120_000);submit(false,{assistantBusy:true});
    assert.equal(chat.approvals.active("pie"),false);
    assert.equal(chat.tick().length,0);
    x.clock(1_150_000);submit(false);
    assert.equal(chat.tick().length,0,"first stable reply not enough");
    x.clock(1_185_000);submit(false);
    assert.equal(chat.tick().length,1);
    assert.ok(chat.claim(EXT)?.observationProof,"claim remains bound to safe reply");
  }finally{x.close()}
});

test("permission popup remains observed while migration suspended, without corrupting migration resume state",()=>{
  const x=setup();try{
    const bridge={getSnapshot:()=>({
      clients:[{extensionId:EXT,status:"online",composerBuild:"composer-2026-10-15-r17"}],
      sessions:[{extensionId:EXT,sessionKey:SESSION,status:"connected",origin:"https://chatgpt.com"}],
      links:[{workstreamId:"pie",extensionId:EXT,sessionKey:SESSION,status:"connected"}]
    })};
    const empty={targets:{list:()=>[]}};
    const chat=new ChatContinuation(x.store,{bridge,watchtower:empty,github:empty,
      gate:{one:()=>null},now:x.now});
    chat.configure("pie",{enabled:true,mode:"scheduled",message:"로드맵 따라서 계속 진행",
      intervalMinutes:15});
    chat.pauseForMigration(EXT,SESSION);
    assert.equal(chat.config("pie").statusReason,"MIGRATION_IN_PROGRESS");
    assert.equal(chat.config("pie").enabled,false);
    function deliver(pending,busy=false){
      const request=chat.requestObservations(EXT)[0];
      assert.ok(request,"migration must keep read-only approval surveillance");
      const obs={schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",
        verified:true,observedAt:x.now(),assistantBusy:busy,composerHasDraft:false,
        stopControlVerified:false,contentComplete:!busy,uiAmbiguous:false,
        connectionWarning:false,lengthWarning:false,providerRestriction:false,
        otherWarning:false,humanActionCue:pending,scopeCompleteCue:false,ciWaitCue:false,
        bindingFingerprint:"b".repeat(64),replyFingerprint:"a".repeat(64),
        toolApproval:{observed:true,pending,kind:"tool_permission",tool:"Remote Desktop Commander"}};
      return chat.acceptObservation(EXT,{requestId:request.requestId,observation:obs});
    }
    x.clock(1_020_000);deliver(true);
    assert.equal(chat.approvals.active("pie"),true);
    assert.equal(chat.config("pie").statusReason,"MIGRATION_IN_PROGRESS");
    assert.equal(chat.resumeAfterMigration(EXT,SESSION).reasonCode,"MIGRATION_WAITING_HUMAN_APPROVAL");
    x.clock(1_040_000);deliver(false,true);
    x.clock(1_060_000);deliver(false,true);
    assert.equal(chat.approvals.active("pie"),false);
    assert.equal(chat.config("pie").enabled,false);
    assert.equal(chat.config("pie").statusReason,"MIGRATION_IN_PROGRESS");
    const result=chat.resumeAfterMigration(EXT,SESSION);
    assert.equal(result.resumed,true);
    assert.equal(chat.config("pie").enabled,true);
    assert.equal(chat.tick().length,0,"migration resume doesn't bypass 15-min + complete-reply gate");
  }finally{x.close();}
});
