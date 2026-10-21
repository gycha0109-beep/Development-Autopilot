import test from 'node:test';
import assert from 'node:assert/strict';
import {startSimulator} from '../simulator/server.js';
import {CI_TARGET} from '../simulator/ci-fixture.js';
import {WatchtowerClient,decideWatchtowerRun} from '../local/watchtower-client.js';
import {GitHubVerifier} from '../local/github-verifier.js';

test('synthetic HTTP CI contract exercises production exact-target checks, failures and unavailable sources',async()=>{
  const s=await startSimulator();
  try{
    const client=new WatchtowerClient({baseUrl:s.origin+'/v1',getToken:async()=>'synthetic-test-credential-not-a-real-account'});
    const github=new GitHubVerifier({client:{get:async path=>{const r=await fetch(s.origin+'/github'+path);if(!r.ok)throw Error('SYNTHETIC_UNAVAILABLE');return r.json();}}});
    for(const [state,watchDecision,gitState]of [['running','WAIT_EXTERNAL','WAIT_EXTERNAL'],['success','VERIFY_GITHUB','MERGED_CONFIRMED'],['failure','BLOCKED','FAILURE']]){
      s.model.setCI('ops',{state});
      const run=await client.run(CI_TARGET),facts=await github.verify(CI_TARGET);
      assert.equal(decideWatchtowerRun(run,CI_TARGET).decision,watchDecision);
      assert.equal(facts.runVerified,true);assert.equal(facts.state,gitState);assert.equal(facts.safeToAdvance,false);
    }
    s.model.setCI('ops',{state:'success',identity:{runId:78}});
    assert.equal(decideWatchtowerRun(await client.run(CI_TARGET),CI_TARGET).decision,'UNKNOWN');
    assert.equal((await github.verify(CI_TARGET)).runVerified,false);
    s.model.setCI('ops',{state:'success',identity:{trackKey:'other'}});
    assert.equal(decideWatchtowerRun(await client.run(CI_TARGET),CI_TARGET).reason,'WORK_TRACK_MISMATCH');
    s.model.setCI('ops',{state:'success',merged:false});
    assert.equal((await github.verify(CI_TARGET)).state,'CHECKS_PASSED_NOT_MERGED');
    s.model.setCI('ops',{state:'unknown'});await assert.rejects(()=>client.run(CI_TARGET),/DATABASE_UNAVAILABLE/);
  }finally{await s.close();}
});
