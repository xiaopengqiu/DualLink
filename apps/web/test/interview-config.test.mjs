import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../src/interview-config.mjs').catch(()=>({}));
test('native audio availability is independent from transcript recognition',()=>{
 assert.equal(typeof module.modeReady,'function');
 assert.equal(module.modeReady({configured:false,audioConfigured:true},'audio'),true);
 assert.equal(module.modeReady({configured:false,audioConfigured:true},'transcript'),false);
 assert.equal(module.modeReady({configured:true,audioConfigured:false},'audio'),false);
});
test('account defaults normalize without auto-answering and preserve text-provider choice',()=>{
 assert.equal(typeof module.interviewPreferences,'function');
 assert.deepEqual(module.interviewPreferences({defaults:{mode:'audio',provider:'claude',transcribe:false,audioModel:'omni-custom',audioWindowSeconds:60}}),{mode:'audio',provider:'claude',transcribe:false,audioModel:'omni-custom',audioWindowSeconds:60,textModels:{codex:'',claude:'',bailian:''},asrModel:''});
 assert.equal(module.interviewPreferences({defaultProvider:'bailian'}).mode,'transcript');
 assert.equal(module.interviewPreferences({defaultProvider:'bailian'}).provider,'bailian');
});

test('interview models remain separate per text executor and from ASR/audio models',()=>{
 const saved={provider:'claude',textModels:{codex:'gpt-fast',claude:'qwen-fast',bailian:'qwen-text'},asrModel:'qwen-asr',audioModel:'qwen-omni'};
 const result=module.interviewPreferences({},saved);
 assert.deepEqual(result.textModels,saved.textModels);
 assert.equal(result.asrModel,'qwen-asr');
 assert.equal(result.audioModel,'qwen-omni');
 result.textModels.codex='changed';
 assert.equal(saved.textModels.codex,'gpt-fast');
 assert.equal(module.interviewPreferences({asrModel:'server-asr'}).asrModel,'server-asr');
});
