import test from "node:test";
import assert from "node:assert/strict";
import { attachChatToExistingGroup } from "../extension/popup-group.js";

const chatA="https://chatgpt.com/g/g-p-build/c/chat-a";
const chatB="https://chatgpt.com/g/g-p-build/c/chat-b";

function fixture({
  tab={id:11,groupId:-1,windowId:1,url:chatA,title:"BuildMap chat"},
  groups=[{id:31,windowId:1,title:"BuildMap",color:"blue"}],
  initial={version:1,groups:[],sessions:[]},
  onMove
}={}){
  let tabState={...tab},groupState=groups.map(g=>({...g}));
  let registry=structuredClone(initial),saves=0,moves=0,nextId=0;
  const adapters={
    getTab:async id=>id===tabState.id?{...tabState}:null,
    getGroup:async id=>groupState.find(g=>g.id===id),
    groupTabs:async options=>{
      moves++;
      assert.equal(options.tabIds[0],tabState.id);
      tabState.groupId=options.groupId;
      if(onMove)tabState=onMove({...tabState});
      return options.groupId;
    },
    browserSnapshot:async()=>({
      groups:groupState.map(g=>({...g})),
      tabs: tabState.groupId<0?[]:[{...tabState}]
    }),
    load:async()=>structuredClone(registry),
    save:async data=>{saves++;registry=structuredClone(data);},
    epoch:async()=> "token",
    newKey:()=> "new-"+(++nextId),
    now:()=>10000
  };
  return {adapters,
    state:()=>({tab:{...tabState},registry,saves,moves})};
}

test("ungrouped existing ChatGPT chat joins selected existing group and registers",async()=>{
  const f=fixture();
  const result=await attachChatToExistingGroup({tabId:11,groupId:31},f.adapters);
  const state=f.state();
  assert.equal(state.moves,1);
  assert.equal(state.saves,1);
  assert.equal(state.tab.groupId,31);
  assert.equal(state.registry.groups.length,1);
  assert.equal(state.registry.sessions.length,1);
  assert.equal(state.registry.sessions[0].url,chatA);
  assert.equal(result.groupName,"BuildMap");
  assert.equal(result.preservedSession,false);
});

test("already grouped and registered chat is idempotent",async()=>{
  const f=fixture({
    tab:{id:11,groupId:31,windowId:1,url:chatA,title:"BuildMap chat"},
    initial:{version:1,groups:[{key:"g1",groupId:31,windowId:1,
      sessionToken:"token",label:"BuildMap",color:"blue",paused:false,enrolledAt:1}],
      sessions:[{key:"s1",groupKey:"g1",tabId:11,sessionToken:"token",
        url:chatA,title:"BuildMap chat",paused:true,enrolledAt:1}]}
  });
  const result=await attachChatToExistingGroup({tabId:11,groupId:31},f.adapters);
  const state=f.state();
  assert.equal(state.moves,0);
  assert.equal(state.registry.sessions.length,1);
  assert.equal(state.registry.sessions[0].key,"s1");
  assert.equal(state.registry.sessions[0].paused,true);
  assert.equal(result.preservedSession,true);
});

test("moving an approved registered chat preserves session key and chat identity",async()=>{
  const f=fixture({
    tab:{id:11,groupId:22,windowId:1,url:chatA,title:"BuildMap chat"},
    groups:[{id:22,windowId:1,title:"Old group"},{id:31,windowId:1,title:"BuildMap"}],
    initial:{version:1,groups:[
      {key:"old",groupId:22,windowId:1,sessionToken:"token",label:"Old group",paused:false,enrolledAt:1},
      {key:"target",groupId:31,windowId:1,sessionToken:"token",label:"BuildMap",paused:false,enrolledAt:2}
    ],sessions:[{key:"approved-session",groupKey:"old",tabId:11,
      sessionToken:"token",url:chatA,title:"BuildMap chat",paused:false,enrolledAt:1}]}
  });
  const result=await attachChatToExistingGroup({tabId:11,groupId:31},f.adapters);
  const state=f.state();
  assert.equal(state.moves,1);
  assert.equal(state.registry.sessions.length,1);
  assert.equal(state.registry.sessions[0].key,"approved-session");
  assert.equal(state.registry.sessions[0].groupKey,"target");
  assert.equal(state.registry.sessions[0].url,chatA);
  assert.equal(result.preservedSession,true);
});

test("cross-window group cannot move a tab or mutate registry",async()=>{
  const f=fixture({groups:[{id:31,windowId:9,title:"Other window"}]});
  await assert.rejects(
    attachChatToExistingGroup({tabId:11,groupId:31},f.adapters),/동일한 Chrome 창/
  );
  assert.equal(f.state().moves,0);
  assert.equal(f.state().saves,0);
});

test("non-chat route cannot be enrolled by existing-group action",async()=>{
  const f=fixture({tab:{id:11,groupId:-1,windowId:1,
    url:"https://chatgpt.com/g/g-p-build/project",title:"Project home"}});
  await assert.rejects(
    attachChatToExistingGroup({tabId:11,groupId:31},f.adapters),/ChatGPT 대화/
  );
  assert.equal(f.state().moves,0);
});

test("navigation during Chrome group move does not register an unrelated chat",async()=>{
  const f=fixture({
    tab:{id:11,groupId:-1,windowId:1,url:chatA,title:"BuildMap chat"},
    onMove:tab=>({...tab,url:chatB})
  });
  f.adapters.browserSnapshot=async()=>({
    groups:[{id:31,windowId:1,title:"BuildMap",color:"blue"}],
    tabs:[{...f.state().tab}]
  });
  await assert.rejects(
    attachChatToExistingGroup({tabId:11,groupId:31},f.adapters),/동일성/
  );
  assert.equal(f.state().saves,0);
});

test("stale previous registration cannot inherit identity when reparenting",async()=>{
  const f=fixture({
    tab:{id:11,groupId:22,windowId:1,url:chatA,title:"BuildMap chat"},
    groups:[{id:22,windowId:1,title:"Old"},{id:31,windowId:1,title:"New"}],
    initial:{version:1,groups:[{key:"g",groupId:22,windowId:1,
      sessionToken:"old",label:"Old",paused:false,enrolledAt:1}],
      sessions:[{key:"s",groupKey:"g",tabId:11,
        sessionToken:"old",url:chatA,paused:false,enrolledAt:1}]}
  });
  await assert.rejects(
    attachChatToExistingGroup({tabId:11,groupId:31},f.adapters),/복구/
  );
  assert.equal(f.state().moves,0);
});
