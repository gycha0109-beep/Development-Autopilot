// Copied ONLY into generated simulator runtime. Uses production HTTP parsers,
// target reconciliation and GitHub verifier; no direct gate/decision injection.
import { WatchtowerClient } from './local/watchtower-client.js';
import { GitHubVerifier,GitHubFactError } from './local/github-verifier.js';
export function simulatorSources(origin){
  return {watchtower:{client:new WatchtowerClient({baseUrl:origin+'/v1',getToken:async()=>'f'.repeat(64)})},
    github:{verifier:new GitHubVerifier({client:{get:async path=>{
      if(!path.startsWith('/repos/sim-owner/sim-repo/'))throw new GitHubFactError('INVALID_API_PATH');
      const r=await fetch(origin+'/github'+path,{redirect:'error',signal:AbortSignal.timeout(2500)});
      if(!r.ok)throw new GitHubFactError(r.status===404?'GITHUB_NOT_FOUND':'GITHUB_UNAVAILABLE');
      return r.json();
    }}})}};
}
