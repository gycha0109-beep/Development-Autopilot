import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
export function loopbackOrigin(value){
  const u=new URL(value);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.origin!==value||Number(u.port)<1024)
    throw Error('TEST_BUILD_REQUIRES_EXACT_LOOPBACK_ORIGIN');
  return value;
}
// This compiler is test infrastructure, never imported by production runtime.
// Change only exact origin literals in an absent output tree. All policies,
// timings, proof checks, SQLite claims and budgets remain byte-for-byte intact.
export function buildSimulatorRuntime({destination,simulatorOrigin,bridgeOrigin,syntheticCI=false}){
  loopbackOrigin(simulatorOrigin);loopbackOrigin(bridgeOrigin);
  const output=path.resolve(destination);
  if(existsSync(output)||output===path.resolve(root)||output.startsWith(path.resolve(root,'extension')+path.sep))
    throw Error('TEST_BUILD_DESTINATION_MUST_BE_ABSENT');
  mkdirSync(output,{recursive:true});
  const replacements=[];
  for(const tree of ['extension','local']){
    cpSync(path.join(root,tree),path.join(output,tree),{recursive:true});
    const walk=dir=>{for(const item of readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,item.name);if(item.isDirectory())walk(file);
      else if(item.name.endsWith('.js')){
        const before=readFileSync(file,'utf8');let after=before.replaceAll('https://chatgpt.com',simulatorOrigin);
        const regexOrigin=simulatorOrigin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replaceAll('/','\\/');
        after=after.replaceAll('https:\\/\\/chatgpt\\.com',regexOrigin);
        if(tree==='extension')after=after.replaceAll('http://127.0.0.1:48173',bridgeOrigin);
        if(after!==before){writeFileSync(file,after);replacements.push(path.relative(output,file).replaceAll('\\','/'));}
      }
    }};walk(path.join(output,tree));
  }
  writeFileSync(path.join(output,'package.json'),JSON.stringify({type:'module',private:true}));
  if(syntheticCI){
    cpSync(new URL('./ci-adapters.js',import.meta.url),path.join(output,'simulator-ci.js'));
    const file=path.join(output,'local','server.js');let source=readFileSync(file,'utf8');
    const watch='const watchtower = new WatchtowerObserver(store);',git='const github = new GitHubObserver(store,{watchtower});';
    if(!source.includes(watch)||!source.includes(git))throw Error('TEST_SOURCE_ADAPTER_SEAM_CHANGED');
    source='import { simulatorSources } from "../simulator-ci.js";\nconst simulatorDependencies=simulatorSources('+JSON.stringify(simulatorOrigin)+');\n'+source;
    source=source.replace(watch,'const watchtower = new WatchtowerObserver(store,simulatorDependencies.watchtower);')
      .replace(git,'const github = new GitHubObserver(store,{watchtower,...simulatorDependencies.github});');
    writeFileSync(file,source);
  }
  const manifestPath=path.join(output,'extension','manifest.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  manifest.name='TEST ONLY — Autopilot Local Simulator';manifest.short_name='SIM TEST';
  // Chrome match patterns cannot restrict ports. Page origin predicates above do.
  manifest.host_permissions=['http://127.0.0.1/*'];
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
  const report={kind:'local-simulator-only',source:'PR76-compatible-production-logic',simulatorOrigin,bridgeOrigin,syntheticCI,replacements};
  writeFileSync(path.join(output,'SIMULATOR-TEST-BUILD.json'),JSON.stringify(report,null,2));
  return {...report,extensionDir:path.join(output,'extension'),serverPath:path.join(output,'local','server.js')};
}
