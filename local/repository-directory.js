import {execFile} from "node:child_process";
import {promisify} from "node:util";

const runFile=promisify(execFile);
const REPOSITORY=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
export function normalizeRepository(input){
  if(typeof input!=="string"||input!==input.trim()||input.length>150||
    !REPOSITORY.test(input))throw Error("REPOSITORY_NAME_INVALID");
  const [owner,repo]=input.split("/");
  if(owner.startsWith("-")||repo==="."||repo===".."||repo.endsWith(".")||
    repo.includes("..")||repo.startsWith("."))throw Error("REPOSITORY_NAME_INVALID");
  return input;
}
export async function listAccessibleGitHubRepos({run=runFile,maxPages=5}={}){
  const output=[];
  let truncated=false;
  for(let page=1;page<=maxPages;page++){
    const {stdout}=await run("gh",["api",
      "/user/repos?per_page=100&page="+page+"&affiliation=owner,collaborator,organization_member",
      "-H","Accept: application/vnd.github+json"],{
        timeout:12000,maxBuffer:4*1024*1024,windowsHide:true
      });
    let rows;
    try{rows=JSON.parse(stdout);}catch{throw Error("GITHUB_REPOSITORIES_INVALID_JSON");}
    if(!Array.isArray(rows))throw Error("GITHUB_REPOSITORIES_INVALID_RESPONSE");
    for(const item of rows){
      if(typeof item?.full_name!=="string")continue;
      try{const repository=normalizeRepository(item.full_name);
        output.push({repository,visibility:item.private===true?"private":"public"});
      }catch{/* Reject malformed external repo identities. */}
    }
    if(rows.length<100)return {items:output,truncated:false};
    if(page===maxPages)truncated=true;
  }
  return {items:output,truncated};
}
export class RepositoryDirectory {
  constructor(store,{discover=listAccessibleGitHubRepos,now=()=>Date.now()}={}){
    this.store=store;this.db=store.db;this.discover=discover;this.now=now;
    this.refreshing=null;this.checkedAt=null;this.githubStatus="not_checked";
    this.lastError=null;this.truncated=false;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS repository_catalog(",
      "repository TEXT PRIMARY KEY,origin TEXT NOT NULL CHECK(origin IN ('manual','github')),",
      "visibility TEXT NOT NULL CHECK(visibility IN ('unknown','public','private')),",
      "updated_at INTEGER NOT NULL) STRICT;",
      "CREATE INDEX IF NOT EXISTS repository_catalog_origin_idx ON repository_catalog(origin);"
    ].join(" "));
  }
  register({repository}={}){
    const name=normalizeRepository(repository),at=this.now();
    this.db.prepare("INSERT INTO repository_catalog(repository,origin,visibility,updated_at)"+
      " VALUES(?,'manual','unknown',?) ON CONFLICT(repository) DO NOTHING").run(name,at);
    return {repository:name,registered:true};
  }
  list(){
    const catalog=this.db.prepare("SELECT repository,origin,visibility,updated_at AS updatedAt"+
      " FROM repository_catalog ORDER BY repository COLLATE NOCASE").all();
    const entries=new Map(catalog.map(x=>[x.repository.toLowerCase(),{
      name:x.repository,source:x.origin,visibility:x.visibility
    }]));
    const merge=(name,source)=>{
      try{const canonical=normalizeRepository(name),key=canonical.toLowerCase();
        if(!entries.has(key))entries.set(key,{name:canonical,source,visibility:"unknown"});
      }catch{}
    };
    for(const w of this.store.list())merge(w.repository,"workstream");
    for(const c of this.db.prepare(
      "SELECT DISTINCT repository FROM macro_sessions WHERE repository IS NOT NULL").all())
      merge(c.repository,"chat");
    return [...entries.values()].sort((a,b)=>a.name.localeCompare(b.name,"en",{sensitivity:"base"}));
  }
  state(ciRegistry=null){
    const repos=this.list();
    const observed=ciRegistry?.status==="connected"||ciRegistry?.status==="observed";
    const monitorSet=new Set((ciRegistry?.repositories||[]).map(x=>
      String(x.name||x.fullName||x.repository||"").toLowerCase()));
    return {repositories:repos.map(x=>({...x,
      ciMonitored:Boolean(observed&&monitorSet.has(x.name.toLowerCase()))})),
      githubStatus:this.githubStatus,checkedAt:this.checkedAt,
      githubError:this.lastError,truncated:this.truncated,
      ciStatus:ciRegistry?.status||"not_configured"};
  }
  async refresh({force=false}={}){
    if(this.refreshing)return this.refreshing;
    if(!force&&this.checkedAt!==null&&this.now()-this.checkedAt<10*60_000)
      return this.state();
    this.refreshing=(async()=>{
      try{
        const result=await this.discover();
        if(!Array.isArray(result?.items))throw Error("GITHUB_REPOSITORIES_INVALID_RESPONSE");
        const at=this.now();
        const upsert=this.db.prepare(
          "INSERT INTO repository_catalog(repository,origin,visibility,updated_at) "+
          "VALUES(?,'github',?,?) ON CONFLICT(repository) DO UPDATE SET "+
          "visibility=excluded.visibility,updated_at=excluded.updated_at");
        this.store.transaction(()=>{
          for(const item of result.items){
            const name=normalizeRepository(item.repository);
            const visibility=["public","private"].includes(item.visibility)?
              item.visibility:"unknown";
            upsert.run(name,visibility,at);
          }
        });
        this.githubStatus="connected";this.lastError=null;
        this.truncated=result.truncated===true;
      }catch(error){
        this.githubStatus="unavailable";
        // Do not expose raw gh stderr or tokens to the browser.
        const code=String(error?.message||"");
        this.lastError=code==="ENOENT"?"GITHUB_CLI_MISSING":
          /not logged in|authentication|HTTP 401|HTTP 403|authentication failed/i.test(code)?
          "GITHUB_AUTH_REQUIRED":"GITHUB_REPOSITORIES_UNAVAILABLE";
      }
      this.checkedAt=this.now();
      return this.state();
    })().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
}
