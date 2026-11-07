import test from "node:test";
import assert from "node:assert/strict";
import {renameMigrationConversation} from "../extension/migration-page.js";

async function withAnchorlessChat({duplicate=false}={}){
  const prior={document:globalThis.document,location:globalThis.location,
    MouseEvent:globalThis.MouseEvent,HTMLInputElement:globalThis.HTMLInputElement};
  const original="Payment continuation";
  const desired="Payment continuation 2";
  const path="/g/g-p-myproject/c/current-chat";
  let menuOpen=false,editorOpen=false,clicks=0;
  const visible={getClientRects:()=>[{}]};
  const getText=el=>el.innerText||el.textContent||"";
  const header={...visible,innerText:original,
    closest:()=>null};
  const menuButton={...visible,click(){clicks++;menuOpen=true;},
    getAttribute:name=>name==="aria-haspopup"?"menu":null,
    closest:()=>null};
  const item={...visible,closest:selector=>selector.includes("nav")?{}:null,
    querySelectorAll:selector=>selector==="button"?[menuButton]:
      selector==='button[aria-haspopup="menu"]'?[menuButton]:[],
    dispatchEvent(){},parentElement:null};
  const leaf={...visible,children:[],innerText:original,
    closest:selector=>selector.includes("nav")?{}:null,
    parentElement:item,querySelectorAll:()=>[]};
  const second={...leaf};
  const renameItem={...visible,innerText:"이름 변경",closest:()=>null,
    click(){menuOpen=false;editorOpen=true;}};
  class FakeInput {
    #value=original;
    get value(){return this.#value;}
    set value(value){this.#value=value;}
    getClientRects(){return [{}];}
    closest(){return null;}
    dispatchEvent(){}
  }
  const editor=new FakeInput();
  const saveButton={...visible,innerText:"저장",closest:()=>null,click(){
    if(!editorOpen)return;
    globalThis.document.title=editor.value;
    header.innerText=editor.value;
    leaf.innerText=editor.value;
    editorOpen=false;
  }};
  globalThis.location={origin:"https://chatgpt.com",pathname:path};
  globalThis.MouseEvent=class {constructor(){}};
  globalThis.HTMLInputElement=FakeInput;
  globalThis.document={
    title:original,
    querySelectorAll(selector){
      if(selector==="a[href]")return [];
      if(selector==='header button[aria-haspopup="menu"]')return [header];
      if(selector==='nav span,aside span,[data-sidebar] span')
        return duplicate?[leaf,second]:[leaf];
      if(selector.includes('[role="menuitem"]'))return menuOpen?[renameItem]:[];
      if(selector==='[role="dialog"] input[type="text"],[role="dialog"] input:not([type]),input[data-testid*="rename"]')
        return editorOpen?[editor]:[];
      if(selector==='[role="dialog"] button')return editorOpen?[saveButton]:[];
      return [];
    }
  };
  try{return {out:await renameMigrationConversation(desired),clicks,
    title:globalThis.document.title};}
  finally{
    for(const [key,value] of Object.entries(prior)){
      if(value===undefined)delete globalThis[key];
      else globalThis[key]=value;
    }
  }
}
test("rename uses one uniquely identified anchorless sidebar row",async()=>{
  const result=await withAnchorlessChat();
  assert.deepEqual(result,{out:{ok:true,reason:"MIGRATION_TITLE_VERIFIED_ANCHORLESS"},
    clicks:1,title:"Payment continuation 2"});
});
test("rename refuses duplicate sidebar titles without touching menus",async()=>{
  const result=await withAnchorlessChat({duplicate:true});
  assert.equal(result.out.ok,false);
  assert.equal(result.out.reason,"MIGRATION_TITLE_CHAT_MENU_NOT_FOUND");
  assert.equal(result.clicks,0);
  assert.equal(result.title,"Payment continuation");
});
