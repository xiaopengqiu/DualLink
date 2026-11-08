import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createDashScopeAsrFactory, asrConfiguration } from '../src/asr.mjs';

const pcm = (speech = true) => { const b=Buffer.alloc(3200);if(speech)for(let i=0;i<b.length;i+=2)b.writeInt16LE(1000,i);return b; };
async function upstream(t,handler) {
  const calls=[];
  const server=createServer(async(req,res)=>{let data='';for await(const bytes of req)data+=bytes;const body=JSON.parse(data);calls.push({body,authorization:req.headers.authorization});if(handler)return handler(req,res,body,calls.length);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({output:{sentence:{text:'识别结果',begin_time:20,end_time:100}},usage:{duration:1}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {calls,httpUrl:`http://127.0.0.1:${server.address().port}/api/v1/services/aigc/multimodal-generation/generation`};
}
const waitFor=async fn=>{const until=Date.now()+2000;while(!fn()){if(Date.now()>until)throw Error('Timed out');await new Promise(r=>setTimeout(r,5));}};
const factory=u=>createDashScopeAsrFactory({transport:'token-plan',apiKey:'fixture-secret',model:'qwen-audio-3.0-asr-flash',...u});

test('ASR selects Token Plan HTTP and repairs text API paths while retaining ordinary streaming',()=>{
  const a=asrConfiguration({apiKey:'sk-sp-fixture',model:'qwen-audio-3.0-asr-flash',baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'});
  assert.equal(a.transport,'http');assert.equal(a.httpUrl,'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');assert.equal(a.configured,true);
  assert.equal(asrConfiguration({transport:'token-plan',apiKey:'fixture'}).model,'qwen-audio-3.0-asr-flash');
  assert.equal(asrConfiguration({apiKey:'fixture',workspaceId:'workspace',model:'qwen-audio-3.1-asr-flash-streaming'}).transport,'websocket');
  assert.equal(asrConfiguration({apiKey:'fixture',model:'qwen-audio-3.0-asr-flash',baseUrl:'https://example.test'}).transport,'http');
});

test('HTTP ASR sends inline 16k mono WAV, hotwords and authentication; silence flush preserves session times',async t=>{
  const u=await upstream(t),results=[],task=await factory(u)({track:'remote',hotwords:['Redis'],onResult:r=>results.push(r)});
  for(let i=0;i<3;i++)await task.write(pcm(),1000+i*100);
  for(let i=0;i<5;i++)await task.write(pcm(false),1300+i*100);
  await task.finish();
  assert.equal(u.calls.length,1);const {body,authorization}=u.calls[0];assert.equal(authorization,'Bearer fixture-secret');assert.equal(body.model,'qwen-audio-3.0-asr-flash');assert.equal(body.parameters.vocabulary.Redis,4);
  const wav=Buffer.from(body.input.messages[0].content[0].input_audio.data.split(',')[1],'base64');assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.length,8*3200+44);
  assert.deepEqual(results.map(r=>[r.text,r.startMs,r.endMs,r.final]),[['识别结果',1020,1100,true]]);task.close();
});

test('silent tracks make no requests and manual flush submits a short spoken tail once',async t=>{
  const u=await upstream(t),results=[],task=await factory(u)({track:'self',onResult:r=>results.push(r)});
  for(let i=0;i<30;i++)await task.write(pcm(false),i*100);
  await task.flush();assert.equal(u.calls.length,0);
  await task.write(pcm(),3000);await task.flush();await task.finish();await task.finish();
  assert.equal(u.calls.length,1);assert.equal(results.length,1);assert.equal(results[0].startMs,3020);task.close();
});

test('slow HTTP does not block recording writes; fixed chunks are serialized and gap timestamps are preserved',async t=>{
  const releases=[];const u=await upstream(t,(_req,res)=>releases.push(()=>res.end(JSON.stringify({output:{text:'片段'}}))));
  const results=[],task=await factory({...u,chunkSeconds:2})({track:'remote',onResult:r=>results.push(r)});
  for(let i=0;i<20;i++)await task.write(pcm(),i*100);
  await waitFor(()=>u.calls.length===1);
  // The first request is held open while another complete chunk is accepted.
  for(let i=0;i<20;i++)await task.write(pcm(),5000+i*100);
  assert.equal(u.calls.length,1);const finishing=task.finish();releases[0]();await waitFor(()=>u.calls.length===2);releases[1]();await finishing;
  assert.deepEqual(results.map(r=>[r.startMs,r.endMs]),[[0,2000],[5000,7000]]);assert.notEqual(results[0].segmentId,results[1].segmentId);task.close();
});

test('HTTP ASR retries transient errors once and never duplicates final segments',async t=>{
  const u=await upstream(t,(_req,res,_body,count)=>{if(count===1){res.writeHead(429);res.end('quota fixture');}else res.end(JSON.stringify({text:'成功'}));});
  const results=[],task=await factory(u)({track:'remote',onResult:r=>results.push(r)});await task.write(pcm(),0);await task.finish();assert.equal(u.calls.length,2);assert.equal(results.length,1);task.close();
});

test('HTTP auth failures are actionable, do not retry and never expose upstream credentials',async t=>{
  const u=await upstream(t,(_req,res)=>{res.writeHead(401);res.end('fixture-secret vendor credential detail');});const errors=[];
  const task=await factory(u)({track:'remote',onError:e=>errors.push(e)});await task.write(pcm(),0);await assert.rejects(task.finish(),e=>e.code==='ASR_AUTH_FAILED'&&!e.message.includes('fixture-secret'));assert.equal(errors.length,1);assert.equal(u.calls.length,1);task.close();
});

test('close cancels HTTP work and prevents late transcript callbacks',async t=>{
  let release;const u=await upstream(t,(_req,res)=>release=()=>res.end(JSON.stringify({text:'不得写入'})));const results=[];
  const task=await factory(u)({track:'remote',onResult:r=>results.push(r)});await task.write(pcm(),0);const flushing=task.flush();await waitFor(()=>release);task.close();release();await assert.rejects(flushing,/关闭/);assert.equal(results.length,0);
});

test('HTTP queue has a hard backlog limit and reports recoverable recording gaps',async t=>{
  const u=await upstream(t,()=>{}),errors=[];const task=await factory({...u,chunkSeconds:2,maxPendingChunks:1})({track:'remote',onError:e=>errors.push(e)});
  for(let i=0;i<20;i++)await task.write(pcm(),i*100);
  for(let i=20;i<39;i++)await task.write(pcm(),i*100);
  await assert.rejects(task.write(pcm(),3900),e=>e.code==='ASR_BACKPRESSURE');assert.equal(errors.length,1);await assert.rejects(task.finish(),e=>e.code==='ASR_BACKPRESSURE');task.close();
});

test('HTTP tail drain is bounded and invalid forced streaming models fail before networking',async t=>{
  const u=await upstream(t,()=>{});const task=await factory({...u,finishTimeoutMs:60})({track:'remote'});await task.write(pcm(),0);await assert.rejects(task.finish(),e=>e.code==='ASR_FINISH_TIMEOUT');task.close();
  await assert.rejects(factory(u)({track:'remote',model:'qwen-audio-3.1-asr-flash-streaming'}),e=>e.code==='ASR_INVALID_CONFIG');
});

test('Token Plan empty HTTP 400 records an unrecognized chunk and continues with later speech',async t=>{
  const u=await upstream(t,(_req,res,_body,count)=>{if(count===1){res.writeHead(400);res.end('{}');}else res.end(JSON.stringify({text:'后续有效讲话'}));});
  const warnings=[],errors=[],results=[],task=await factory(u)({track:'self',onWarning:w=>warnings.push(w),onError:e=>errors.push(e),onResult:r=>results.push(r)});
  await task.write(pcm(),1000);await task.flush();assert.equal(warnings.length,1);assert.equal(warnings[0].startMs,1000);assert.equal(warnings[0].endMs,1100);assert.equal(errors.length,0);
  const wav=Buffer.from(u.calls[0].body.input.messages[0].content[0].input_audio.data.split(',')[1],'base64');assert.equal(wav.length,16000+44);
  await task.write(pcm(),1100);await task.finish();assert.equal(results[0].text,'后续有效讲话');assert.equal(results[0].endMs,1200);assert.equal(u.calls.length,2);task.close();
});

test('structured HTTP 400 remains fatal and exposes a safe vendor code, never raw error text',async t=>{
  const u=await upstream(t,(_req,res)=>{res.writeHead(400);res.end(JSON.stringify({code:'InvalidParameter',message:'fixture-secret audio payload detail'}));});const warnings=[];
  const task=await factory(u)({track:'remote',onWarning:w=>warnings.push(w)});await task.write(pcm(),0);await assert.rejects(task.finish(),e=>e.code==='ASR_UPSTREAM_FAILED'&&e.message.includes('InvalidParameter')&&!e.message.includes('fixture-secret'));assert.equal(warnings.length,0);task.close();
});
