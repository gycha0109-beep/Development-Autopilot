#!/usr/bin/env node
import { resolve } from "node:path";
import { CodexLocalRunner, CodexRunError } from "../local/codex-cli-adapter.js";

function argsOf(argv){
  const result={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i];
    if(!key.startsWith("--")||i+1>=argv.length||argv[i+1].startsWith("--"))
      throw new CodexRunError("INVALID_CLI_ARGUMENTS");
    if(result[key]!==undefined && key!=="--allow")
      throw new CodexRunError("DUPLICATE_CLI_ARGUMENT");
    if(key==="--allow")result[key]=[...(result[key]||[]),argv[++i]];
    else result[key]=argv[++i];
  }
  return result;
}
const usage="node scripts/codex-one-shot.js prepare|run --workspace ABS_PATH "+
  "--repository owner/repo --task-file ABS_PATH --allow docs/exact-file.md "+
  "[--allow src/exact-file.js] [--approval SHA256]";
async function main(argv){
  if(!["prepare","run"].includes(argv[0]))throw new CodexRunError("MODE_MUST_BE_PREPARE_OR_RUN");
  const v=argsOf(argv.slice(1));
  const input={
    workspace:resolve(v["--workspace"]||""),
    repository:v["--repository"],
    taskFile:resolve(v["--task-file"]||""),
    allowedPaths:v["--allow"]||[]
  };
  if(!v["--workspace"]||!v["--task-file"])
    throw new CodexRunError("ABSOLUTE_WORKSPACE_AND_TASK_REQUIRED");
  const runner=new CodexLocalRunner();
  if(argv[0]==="prepare"){
    const plan=await runner.prepare(input);
    console.log(JSON.stringify({
      state:"WAIT_OPERATOR_APPROVAL",
      fingerprint:plan.fingerprint,repository:plan.repository,sourceHead:plan.sourceHead,
      sourceBranch:plan.sourceBranch,taskHash:plan.taskHash,
      allowedPaths:plan.allowedPaths,
      warning:"Review scope and fingerprint. No Codex was executed."
    },null,2));
    return;
  }
  if(!v["--approval"])throw new CodexRunError("EXACT_TASK_APPROVAL_REQUIRED");
  const result=await runner.runApproved(input,v["--approval"]);
  // Never print task text, Codex stdout, secrets or an auth token.
  console.log(JSON.stringify(result,null,2));
  if(result.state!=="WAIT_GITHUB_PR_AND_CI")process.exitCode=1;
}
main(process.argv.slice(2)).catch(error=>{
  console.error(error instanceof CodexRunError ? error.code : "LOCAL_CLI_RUN_FAILED");
  console.error(usage);
  process.exitCode=1;
});
