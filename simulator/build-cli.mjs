import { buildSimulatorRuntime } from './test-build.js';
const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
if(!['--output','--simulator','--bridge'].every(flag=>args.includes(flag)&&value(flag)&&!value(flag).startsWith('--')))
  throw Error('Usage: node simulator/build-cli.mjs --output ABSENT_DIRECTORY --simulator http://127.0.0.1:48273 --bridge http://127.0.0.1:48274 [--synthetic-ci]');
console.log(JSON.stringify(buildSimulatorRuntime({destination:value('--output'),simulatorOrigin:value('--simulator'),bridgeOrigin:value('--bridge'),syntheticCI:args.includes('--synthetic-ci')}),null,2));
