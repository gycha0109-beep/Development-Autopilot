import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync
} from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";

const hash = value => createHash("sha256").update(value).digest("hex");
const SHA = /^[0-9a-f]{40}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PROMPT = 12_000;
const RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_CAPTURE = 2 * 1024 * 1024;

export class CodexRunError extends Error {
  constructor(code){super(code);this.code=code;this.name="CodexRunError";}
}

function scopedPath(value){
  if(typeof value!=="string" || !value || value.length>300 ||
     isAbsolute(value) || value.includes("\\") || value.includes("\0") ||
     value.split("/").some(p=>!p||p==="."||p===".."||p===".git"||p===".autopilot") ||
     !/^[A-Za-z0-9._/@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(value)){
    throw new CodexRunError("INVALID_ALLOWED_PATH");
  }
  return value;
}
function safeEnvironment(env=process.env){
  const keys=[
    "PATH","Path","HOME","USERPROFILE","APPDATA","LOCALAPPDATA","PROGRAMDATA",
    "SYSTEMROOT","SystemRoot","WINDIR","TMP","TEMP","TMPDIR","LANG","LC_ALL",
    "COMSPEC","PATHEXT","CODEX_HOME"
  ];
  const clean={};
  for(const key of keys)if(typeof env[key]==="string")clean[key]=env[key];
  return clean;
}

export async function processCommand(command,args,{cwd,input="",timeoutMs=30_000,
  maxBytes=MAX_CAPTURE,env=safeEnvironment()}={}){
  return new Promise((done,reject)=>{
    const child=spawn(command,args,{
      cwd,env,windowsHide:true,stdio:["pipe","pipe","pipe"],shell:false
    });
    let stdout="",stderr="",settled=false;
    const finish=(fn,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);fn(value);
    };
    const timer=setTimeout(()=>{
      child.kill();
      finish(reject,new CodexRunError("PROCESS_TIMEOUT"));
    },timeoutMs);
    for(const [stream,label] of [[child.stdout,"stdout"],[child.stderr,"stderr"]]){
      stream.on("data",chunk=>{
        if(settled)return;
        if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+chunk.length>maxBytes){
          child.kill();
          finish(reject,new CodexRunError("OUTPUT_LIMIT_EXCEEDED"));return;
        }
        if(label==="stdout")stdout+=chunk.toString("utf8");
        else stderr+=chunk.toString("utf8");
      });
    }
    child.once("error",()=>finish(reject,new CodexRunError("PROCESS_UNAVAILABLE")));
    child.once("close",(code,signal)=>finish(done,{code,signal,stdout,stderr}));
    child.stdin.on("error",()=>{});
    child.stdin.end(input);
  });
}

function ensureSuccess(result,code){
  if(result.code!==0)throw new CodexRunError(code);
  return result.stdout.trim();
}
async function git(run,cwd,...args){
  return run("git",["-C",cwd,...args],{
    cwd,timeoutMs:12_000,maxBytes:MAX_CAPTURE,env:safeEnvironment()
  });
}
function parseOrigin(value){
  const cleaned=value.trim().replace(/\.git$/,"");
  const ssh=/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(cleaned);
  if(ssh)return ssh[1];
  const https=/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(cleaned);
  return https?.[1]||null;
}
function promptFingerprint(meta){
  return hash(JSON.stringify({
    version:1,adapter:"codex-cli-v1",repository:meta.repository,
    sourceHead:meta.sourceHead,sourceBranch:meta.sourceBranch,
    taskHash:meta.taskHash,allowedPaths:meta.allowedPaths
  }));
}

export class CodexLocalRunner {
  constructor({run=processCommand,now=()=>Date.now(),codexCommand="codex"}={}){
    this.run=run;this.now=now;this.codexCommand=codexCommand;
  }
  async prepare({workspace,repository,taskFile,allowedPaths}){
    if(typeof workspace!=="string"||!isAbsolute(workspace)||
       typeof taskFile!=="string"||!isAbsolute(taskFile) ||
       typeof repository!=="string"||!REPO.test(repository) ||
       !Array.isArray(allowedPaths)||allowedPaths.length===0||allowedPaths.length>40){
      throw new CodexRunError("INVALID_TASK_CONFIGURATION");
    }
    const paths=allowedPaths.map(scopedPath);
    if(new Set(paths).size!==paths.length)throw new CodexRunError("DUPLICATE_SCOPE");
    const root=resolve(workspace);
    if(!existsSync(root)||!existsSync(taskFile))
      throw new CodexRunError("WORKSPACE_OR_TASK_NOT_FOUND");
    const task=readFileSync(taskFile,"utf8");
    if(!task.trim()||Buffer.byteLength(task,"utf8")>MAX_PROMPT)
      throw new CodexRunError("INVALID_TASK_SIZE");
    const top=ensureSuccess(await git(this.run,root,"rev-parse","--show-toplevel"),"NOT_A_GIT_WORKSPACE");
    if(resolve(top)!==root)throw new CodexRunError("WORKSPACE_MUST_BE_GIT_ROOT");
    const sourceHead=ensureSuccess(await git(this.run,root,"rev-parse","HEAD"),"HEAD_UNAVAILABLE");
    if(!SHA.test(sourceHead))throw new CodexRunError("INVALID_SOURCE_HEAD");
    const sourceBranch=ensureSuccess(await git(this.run,root,"branch","--show-current"),"BRANCH_UNAVAILABLE");
    if(!sourceBranch || ["main","master"].includes(sourceBranch.toLowerCase()))
      throw new CodexRunError("PROTECTED_BRANCH_NOT_ALLOWED");
    const dirty=ensureSuccess(await git(this.run,root,"status","--porcelain=v1","--untracked-files=all"),"WORKTREE_STATUS_FAILED");
    if(dirty)throw new CodexRunError("SOURCE_WORKTREE_DIRTY");
    const origin=ensureSuccess(await git(this.run,root,"remote","get-url","origin"),"REMOTE_UNAVAILABLE");
    if(parseOrigin(origin)?.toLowerCase()!==repository.toLowerCase())
      throw new CodexRunError("GITHUB_REMOTE_MISMATCH");
    const meta={workspace:root,repository,sourceHead:sourceHead.toLowerCase(),
      sourceBranch,taskHash:hash(task),allowedPaths:paths.sort(),taskFile:resolve(taskFile)};
    return {...meta,fingerprint:promptFingerprint(meta)};
  }
  async runApproved(config,approvedFingerprint){
    const prepared=await this.prepare(config);
    if(typeof approvedFingerprint!=="string"||approvedFingerprint!==prepared.fingerprint)
      throw new CodexRunError("EXACT_TASK_APPROVAL_REQUIRED");
    const runId=randomUUID(),now=this.now();
    // The Codex workspace is a separate detached Git worktree, never the user's
    // active checkout. Any unauthorized changes are inspected, not applied.
    const runRoot=mkdtempSync(join(tmpdir(),"autopilot-codex-"));
    const isolated=join(runRoot,"worktree");
    const auditRoot=join(prepared.workspace,".autopilot","codex-runs");
    mkdirSync(auditRoot,{recursive:true});
    const auditFile=join(auditRoot,runId+".json");
    const record={
      version:1,runId,adapterId:"codex-cli-v1",repository:prepared.repository,
      sourceBranch:prepared.sourceBranch,sourceHead:prepared.sourceHead,
      fingerprint:prepared.fingerprint,taskHash:prepared.taskHash,
      allowedPaths:prepared.allowedPaths,startedAt:now,worktree:isolated,
      state:"RESERVED",executionAccepted:false,changeVerified:false,
      githubVerified:false,ciVerified:false,phaseComplete:false
    };
    const persist=()=>writeFileSync(auditFile,JSON.stringify(record,null,2)+"\n",{flag:"w",mode:0o600});
    persist();
    let added=false;
    try{
      ensureSuccess(await git(this.run,prepared.workspace,"worktree","add","--detach",isolated,prepared.sourceHead),
        "ISOLATED_WORKTREE_CREATE_FAILED");
      added=true;
      // Validate root and HEAD once more immediately before submitting.
      const head=ensureSuccess(await git(this.run,isolated,"rev-parse","HEAD"),"ISOLATED_HEAD_UNAVAILABLE");
      if(head.toLowerCase()!==prepared.sourceHead)throw new CodexRunError("ISOLATED_HEAD_DRIFT");
      const fresh=await this.prepare(config);
      if(fresh.fingerprint!==prepared.fingerprint)throw new CodexRunError("APPROVAL_STALE");
      const task=readFileSync(config.taskFile,"utf8");
      const prompt=[
        "You are executing ONE explicitly approved local coding task.",
        "Do not commit, push, create PRs, merge, or send network requests.",
        "Do not read or write outside this isolated Git worktree.",
        "Only change the exact allowed paths listed below. Other edits will be rejected.",
        "Do not access credentials, secrets, or unrelated repositories.",
        "The final text response is NOT evidence of completion; files will be verified independently.",
        "Allowed paths:\n"+prepared.allowedPaths.join("\n"),
        "Task:\n"+task
      ].join("\n\n");
      record.state="RUNNING";persist();
      const args=[
        "exec","--sandbox","workspace-write","--ask-for-approval","never",
        "-c","sandbox_workspace_write.network_access=false",
        "--json","-"
      ];
      const command=await this.run(this.codexCommand,args,{
        cwd:isolated,input:prompt,timeoutMs:RUN_TIMEOUT_MS,
        maxBytes:MAX_CAPTURE,env:safeEnvironment()
      });
      record.executionAccepted=true;
      record.codexExitCode=command.code;
      if(command.code!==0){
        record.state="CODEX_REPORTED_FAILURE";return record;
      }
      const changed=ensureSuccess(
        await git(this.run,isolated,"ls-files","-m","-o","--exclude-standard","-z"),
        "CHANGED_FILES_UNAVAILABLE"
      ).split("\0").filter(Boolean);
      const unique=[...new Set(changed)].sort();
      record.changedPaths=unique;
      record.changeCount=unique.length;
      const forbidden=unique.filter(p=>!prepared.allowedPaths.includes(p));
      if(forbidden.length){
        record.state="OUT_OF_SCOPE_CHANGES";
        record.outOfScopePaths=forbidden;
        return record;
      }
      const finalHead=ensureSuccess(await git(this.run,isolated,"rev-parse","HEAD"),"FINAL_HEAD_UNAVAILABLE");
      if(finalHead.toLowerCase()!==prepared.sourceHead){
        record.state="HEAD_CHANGED";return record;
      }
      if((await git(this.run,isolated,"diff","--check")).code!==0){
        record.state="DIFF_CHECK_FAILED";return record;
      }
      if(!unique.length){
        record.state="NO_CHANGES";return record;
      }
      const digestParts=[];
      for(const p of unique){
        const abs=resolve(isolated,p);
        if(!abs.startsWith(isolated+sep) && abs!==isolated)
          throw new CodexRunError("PATH_ESCAPE_DETECTED");
        // A deleted file is represented distinctly. Do not follow symlinks.
        const {lstatSync,readFileSync:read} = await import("node:fs");
        if(!existsSync(abs)){digestParts.push([p,"DELETED"]);continue;}
        const stat=lstatSync(abs);
        if(!stat.isFile())throw new CodexRunError("NON_REGULAR_OUTPUT");
        if(stat.size>MAX_CAPTURE)throw new CodexRunError("FILE_TOO_LARGE");
        digestParts.push([p,hash(read(abs))]);
      }
      record.changeFingerprint=hash(JSON.stringify({sourceHead:prepared.sourceHead,files:digestParts}));
      record.changeVerified=true;
      // No push/PR/CI claims. Human must inspect and integrate the detached worktree.
      record.state="WAIT_GITHUB_PR_AND_CI";
      return record;
    }catch(err){
      record.state=err instanceof CodexRunError?err.code:"RUN_FAILED_UNKNOWN";
      record.errorCode=record.state;
      return record;
    }finally{
      record.finishedAt=this.now();
      record.worktreeCreated=added;
      persist();
    }
  }
}
