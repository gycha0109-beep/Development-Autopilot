import test from "node:test";
import assert from "node:assert/strict";
import {readRegisteredChatTitle} from "../extension/migration-page.js";
function withPage(url,{sidebarTitles=[],browserTitle="ChatGPT",offpageTitle=null}={},callback){
  const beforeLocation=globalThis.location,beforeDoc=globalThis.document;
  const parsed=new URL(url);
  const sidebar=sidebarTitles.map(title=>({
    href:url,getAttribute:key=>key==="href"?parsed.pathname:null,
    innerText:title,textContent:title,
    getClientRects:()=>[{}],closest:selector=>selector.includes("nav")?{}:null
  }));
  if(offpageTitle) sidebar.push({
    href:"https://chatgpt.com/c/other",
    getAttribute:key=>key==="href"?"/c/other":null,
    innerText:offpageTitle,textContent:offpageTitle,
    getClientRects:()=>[{}],closest:()=>({})
  });
  globalThis.location={origin:parsed.origin,pathname:parsed.pathname};
  globalThis.document={title:browserTitle,querySelectorAll:()=>sidebar};
  try{return callback()}finally{
    globalThis.location=beforeLocation;
    globalThis.document=beforeDoc;
  }
}
test("read exact active sidebar chat title and preserve trailing incrementable number",()=>{
  withPage("https://chatgpt.com/g/g-p-xyz/c/abc",{
    sidebarTitles:["사주 범용화 및 권한 통합 3"],
    browserTitle:"비주얼리 - ChatGPT",
    offpageTitle:"Autopilot 테스트 12"
  },()=>{
    const title=readRegisteredChatTitle();
    assert.deepEqual(title,{ok:true,title:"사주 범용화 및 권한 통합 3",source:"chat-sidebar"});
  });
});
test("read numbered browser title when active sidebar entry is absent",()=>{
  withPage("https://chatgpt.com/g/g-p-xyz/c/abc",{
    browserTitle:"Face Lab 23 - ChatGPT"
  },()=>{
    const title=readRegisteredChatTitle();
    assert.equal(title.title,"Face Lab 23");
    assert.equal(title.source,"browser-title");
  });
});
test("never silently assign number for generic project page, unrelated link or conflicting names",()=>{
  for(const config of [
    {browserTitle:"비주얼리 - ChatGPT"},
    {sidebarTitles:["Face Lab 23","Face Lab 24"],browserTitle:"Face Lab 23"}
  ]){
    withPage("https://chatgpt.com/g/g-p-xyz/c/abc",config,()=>{
      const result=readRegisteredChatTitle();
      assert.equal(result.ok,false);
    });
  }
  withPage("https://chatgpt.com/g/g-p-xyz/project",{
    sidebarTitles:["Face Lab 23"]
  },()=>assert.equal(readRegisteredChatTitle().ok,false));
});
