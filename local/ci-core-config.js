// Exact, operator-owned local binary trust list. No PAT or token is ever stored.
// An absent/invalid config leaves all Core readers inert.
import {createHash} from "node:crypto";
import {readFileSync,realpathSync} from "node:fs";
import {join,dirname,isAbsolute} from "node:path";

const FILES={
  inspector:"ci-core-inspect.exe",
  registry:"ci-core-registry.exe",
  history:"ci-core-history.exe",
  scan:"ci-core-scan.exe"
};
const isHash=value=>typeof value==="string"&&/^[0-9a-f]{64}$/i.test(value);
export function configureVerifiedLocalCore({
  configPath=process.env.LOCALAPPDATA?
    join(process.env.LOCALAPPDATA,"Development-Autopilot","config","ci-core.json"):"",
  env=process.env,
  readFile=readFileSync,
  realpath=realpathSync
}={}){
  if(env.CI_CORE_INSPECT_EXE)
    return {status:"operator_environment",configured:true};
  if(!configPath)return {status:"disabled",configured:false};
  let value;
  try{value=JSON.parse(readFile(configPath,"utf8"));}
  catch{return {status:"disabled",configured:false};}
  if(value?.enabled!==true||typeof value?.directory!=="string"||
     !isAbsolute(value.directory)||!value?.sha256||
     typeof value.sha256!=="object")return {status:"invalid_config",configured:false};
  const verified={};
  try{
    const root=realpath(value.directory);
    for(const [kind,name] of Object.entries(FILES)){
      const expected=value.sha256[name];
      if(!isHash(expected))throw Error("MISSING_PINNED_HASH");
      const exact=realpath(join(root,name));
      if(dirname(exact)!==root)throw Error("BINARY_OUTSIDE_TRUSTED_DIRECTORY");
      const actual=createHash("sha256").update(readFile(exact)).digest("hex");
      if(actual!==expected.toLowerCase())throw Error("BINARY_HASH_MISMATCH");
      verified[kind]=exact;
    }
  }catch{return {status:"binary_verification_failed",configured:false};}
  env.CI_CORE_INSPECT_EXE=verified.inspector;
  env.CI_CORE_REGISTRY_EXE=verified.registry;
  env.CI_CORE_HISTORY_EXE=verified.history;
  env.CI_CORE_SCAN_EXE=verified.scan;
  return {status:"verified",configured:true};
}
