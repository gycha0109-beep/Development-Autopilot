import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../",import.meta.url));
test("popup labels and errors retain real Korean characters",()=>{
  const expected=[["extension/popup.html","\ube60\ub978 \uc2e4\ud589"],["extension/popup.html","\uc120\ud0dd\ud55c \ucc44\ud305 \ub4f1\ub85d"],["extension/popup.html","\ud504\ub86c\ud504\ud2b8 \uc800\uc7a5 \ubc0f \uc790\ub3d9 \uc9c4\ud589"],["extension/popup.html","\uc5f0\uacb0\u00b7\uc624\ub958 \uc0c1\ud0dc \ub2e4\uc2dc \ud655\uc778"],["extension/popup.js","\ud655\uc7a5 \ud504\ub85c\uadf8\ub7a8\uc774 \uc751\ub2f5\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4."],["extension/popup.js","\uc5f0\uacb0: "],["extension/background.js","\ub85c\uceec \uc11c\ubc84 \uc5f0\uacb0\uc774 \ud544\uc694\ud569\ub2c8\ub2e4."],["extension/background.js","\uc774\ubbf8 \uadf8\ub8f9\uc5d0 \uc18d\ud55c \ud0ed\uc785\ub2c8\ub2e4."]];
  for(const [file,label] of expected) {
    const content=readFileSync(new URL("../"+file,import.meta.url),"utf8");
    assert.ok(content.includes(label),file+" is missing "+label);
  }
  for(const file of ["extension/popup.html","extension/popup.js"]) {
    const content=readFileSync(new URL("../"+file,import.meta.url),"utf8");
    assert.ok((content.match(/[\\uac00-\\ud7a3]/g)||[]).length>50);
  }
});
test("existing-group and pairing labels retain UTF-8 Korean text",()=>{
  const html=readFileSync(new URL("../extension/popup.html",import.meta.url),"utf8");
  for(const label of ["로컬 서버 연결","20자리 연결 코드","기존 Chrome 그룹",
    "선택한 채팅을 기존 그룹에 넣고 등록"]){
    assert.ok(html.includes(label),"missing "+label);
  }
});
