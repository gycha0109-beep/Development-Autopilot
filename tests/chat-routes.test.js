import test from "node:test";
import assert from "node:assert/strict";
import { classifyChatGPTRoute } from "../extension/chat-routes.js";
import { applyAction,emptyRegistry,sessionStatus } from "../extension/core.js";
import { bridgePayload } from "../extension/bridge-core.js";

test("allow only existing, new and project landing ChatGPT routes",()=>{
  const cases=[
    ["https://chatgpt.com/","new"],
    ["https://chatgpt.com/?model=fast","new"],
    ["https://chatgpt.com/c/abc","existing"],
    ["https://chatgpt.com/g/g-p-1234-name/c/abc","existing"],
    ["https://chatgpt.com/g/g-p-1234-name/project","project-new"],
    ["https://chatgpt.com/g/g-p-1234-name","project-new"],
    ["https://chatgpt.com/g/g-p-1234-name/","project-new"],
    ["https://chatgpt.com/g/g-p-1234-name/project/","project-new"],
    ["https://chatgpt.com/g/g-test","null"],
    ["https://chatgpt.com/g/g-p-1234-name/settings","null"],
    ["https://chatgpt.com/g/g-p-1234-name/files","null"],
    ["https://chatgpt.com/settings","null"],
    ["https://chatgpt.com/search","null"],
    ["https://evil.example.com/","null"],
    ["https://chatgpt.com.evil.example.com/","null"],
    ["http://chatgpt.com/","null"],
    ["https://user:pass@chatgpt.com/","null"]
  ];
  for(const [url,expected] of cases)
    assert.equal(classifyChatGPTRoute(url),expected==="null"?null:expected,url);
});

test("project first message changes URL: registered tab becomes stale until explicit rebind",()=>{
  const token="browser-epoch";
  const group={id:3,windowId:4,title:"project",color:"blue"};
  const tab={id:8,windowId:4,groupId:3,
    url:"https://chatgpt.com/g/g-p-1234-name/project",title:"Project"};
  const snapshot={groups:[group],tabs:[tab]};
  let id=0;
  const makeId=()=>String(++id);
  let registry=applyAction(emptyRegistry(),{type:"enrollGroup",groupId:3},
    snapshot,token,makeId,1_000);
  registry=applyAction(registry,{type:"enrollTab",groupKey:registry.groups[0].key,tabId:8},
    snapshot,token,makeId,1_001);
  const session=registry.sessions[0];
  assert.equal(sessionStatus(session,registry,snapshot,token),"connected");
  const moved={groups:[group],tabs:[{...tab,
    url:"https://chatgpt.com/g/g-p-1234-name/c/newly-created"}]};
  assert.equal(sessionStatus(session,registry,moved,token),"url-changed");
  assert.equal(bridgePayload(registry,moved,token).sessions[0].status,"url-changed");
  registry=applyAction(registry,{type:"rebindTab",sessionKey:session.key,tabId:8},
    moved,token,makeId,1_002);
  assert.equal(sessionStatus(registry.sessions[0],registry,moved,token),"connected");
  assert.equal(bridgePayload(registry,moved,token).sessions[0].status,"connected");
});
