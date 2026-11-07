import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildInvocation} from '../src/providers.mjs';
import {createTextRunner} from '../src/text-providers.mjs';

async function directory(t){const root=await mkdtemp(path.join(tmpdir(),'dual-model-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('request model overrides provider defaults and cannot inject additional arguments',async t=>{
 const jobDir=await directory(t);
 for(const provider of ['codex','claude']){
  const invocation=await buildInvocation({codexModel:'codex-default',claudeModel:'claude-default'},{jobDir,provider,prompt:'test',model:'custom/flash[1m]+v2'});
  assert.equal(invocation.args[invocation.args.indexOf('--model')+1],'custom/flash[1m]+v2');
  assert.equal(invocation.args.filter(x=>x==='--model').length,1);
  await assert.rejects(buildInvocation({},{jobDir,provider,prompt:'test',model:'--help'}),e=>e.code==='INVALID_MODEL');
  await assert.rejects(buildInvocation({},{jobDir,provider,prompt:'test',model:'x --tools Bash'}),e=>e.code==='INVALID_MODEL');
 }
});

test('Bailian Claude credentials reach native and Docker CLI without loading project settings',async t=>{
 const jobDir=await directory(t);const previous=process.env.ANTHROPIC_AUTH_TOKEN;
 process.env.ANTHROPIC_AUTH_TOKEN='fixture-bailian-token';
 t.after(()=>{if(previous===undefined)delete process.env.ANTHROPIC_AUTH_TOKEN;else process.env.ANTHROPIC_AUTH_TOKEN=previous;});
 const input={jobDir,provider:'claude',prompt:'test'};
 const native=await buildInvocation({},input);
 assert.equal(native.env.ANTHROPIC_AUTH_TOKEN,'fixture-bailian-token');
 assert.equal(native.args[native.args.indexOf('--setting-sources')+1],'');
 const userConfig=await buildInvocation({claudeLoadUserConfig:true},input);
 assert.equal(userConfig.args[userConfig.args.indexOf('--setting-sources')+1],'user');
 const docker=await buildInvocation({mode:'docker',claudeLoadUserConfig:true},input);
 assert(docker.args.includes('ANTHROPIC_AUTH_TOKEN'));
});

test('warm Codex uses each answer model while reusing one process',async t=>{
 const root=await directory(t),jobDir=path.join(root,'job');await mkdir(jobDir);
 const starts=path.join(root,'starts'),models=path.join(root,'models');
 const fixture=fileURLToPath(new URL('./fixtures/provider-appserver.mjs',import.meta.url));
 const runner=createTextRunner({codexTransport:'app-server',codexBin:process.execPath,codexPrefixArgs:[fixture],codexModel:'default-model',timeoutMs:3000,extraEnv:{FIXTURE_JOURNAL:starts,FIXTURE_MODELS_JOURNAL:models}});
 t.after(()=>runner.close());
 for(const model of ['quality-model','flash-model']){
  const result=await runner({provider:'codex',userId:'owner',sessionId:'session',jobDir,prompt:'test',model});assert.equal(result.answer,'test');
 }
 assert.deepEqual((await readFile(models,'utf8')).trim().split('\n').map(JSON.parse),['quality-model','flash-model']);
 assert.equal((await readFile(starts,'utf8')).trim().split('\n').length,1);
});
