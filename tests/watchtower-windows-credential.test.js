import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

test("Windows keyring decoder accepts UTF-16LE and rejects UTF-8, malformed and oversized blobs",{
  skip:process.platform!=="win32"
},async()=>{
  const script=fileURLToPath(new URL("../local/watchtower-credential.ps1",import.meta.url));
  const {stdout,stderr}=await promisify(execFile)("powershell.exe",[
    "-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,"-SelfTest"
  ],{windowsHide:true,timeout:10000,maxBuffer:4096});
  assert.equal(stdout,"WATCHTOWER_CREDENTIAL_SELF_TEST_PASSED");
  assert.equal(stderr,"");
});
