import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
const module=await import('../src/native-audio-providers.mjs').catch(()=>({}));
async function upstream(t,options={}){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
 const seen={events:[],audio:[],closed:0};
 server.on('connection',(ws,req)=>{seen.auth=req.headers.authorization;seen.url=req.url;ws.send(JSON.stringify({type:'session.created',session:{id:'native-test'}}));
  ws.on('close',()=>seen.closed++);ws.on('message',bytes=>{const event=JSON.parse(bytes.toString());seen.events.push(event);
   if(event.type==='session.update'&&!options.noReady)ws.send(JSON.stringify({type:'session.updated',session:event.session}));
   if(event.type==='input_audio_buffer.append')seen.audio.push(Buffer.from(event.audio,'base64'));
   if(event.type==='input_audio_buffer.commit')ws.send(JSON.stringify({type:'input_audio_buffer.committed',item_id:'audio-'+seen.events.length}));
   if(event.type==='response.create'){
    if(options.hang)return;
    if(options.error){ws.send(JSON.stringify({type:'error',error:{code:'invalid_api_key',message:'private-secret never expose'}}));return;}
    ws.send(JSON.stringify({type:'response.created',response:{id:'answer-1'}}));
    ws.send(JSON.stringify({type:'response.audio.delta',delta:'private audio'}));
    for(const delta of ['结论：','按照实际使用的本地缓存说明取舍。'])ws.send(JSON.stringify({type:'response.text.delta',response_id:'answer-1',delta}));
    if(options.disconnect){ws.close();return;}
    ws.send(JSON.stringify({type:'response.text.done',response_id:'answer-1',text:'结论：按照实际使用的本地缓存说明取舍。'}));
    ws.send(JSON.stringify({type:'response.done',response:{id:'answer-1',status:'completed',usage:{input_tokens:120,output_tokens:20}}}));
   }
  });
 });
 t.after(async()=>{for(const ws of server.clients)ws.terminate();await new Promise(r=>server.close(r));});
 return {seen,url:`ws://127.0.0.1:${server.address().port}/realtime`};
}
const turns=()=>[{track:'self',startMs:0,endMs:100,pcm:Buffer.alloc(3200,1)},{track:'remote',startMs:200,endMs:300,pcm:Buffer.alloc(3200,2),currentQuestion:true}];
test('native audio uses manual PCM input without ASR and returns only streamed text',async t=>{
 assert.equal(typeof module.createNativeAudioRunner,'function','native audio adapter must exist');
 const {seen,url}=await upstream(t);const run=module.createNativeAudioRunner({apiKey:'private-secret',wsUrl:url,model:'qwen3.8-omni-flash-realtime'}),deltas=[];
 const result=await run({prompt:'实际说过：本地缓存；回答风格：简洁。',audioTurns:turns(),onDelta:d=>deltas.push(d)});
 assert.equal(result.answer,'结论：按照实际使用的本地缓存说明取舍。');assert.deepEqual(deltas,['结论：','按照实际使用的本地缓存说明取舍。']);assert.equal(result.usage.input_tokens,120);
 assert.equal(seen.auth,'Bearer private-secret');assert.match(seen.url,/model=qwen3.8-omni-flash-realtime/);
 const config=seen.events.find(e=>e.type==='session.update').session;assert.equal(config.turn_detection,null);assert.equal(config.input_audio_transcription,null);assert.deepEqual(config.modalities,['text']);assert.equal(config.audio.input.format.sample_rate,16000);
 assert.equal(seen.events.filter(e=>e.type==='input_audio_buffer.commit').length,2);assert.equal(seen.events.filter(e=>e.type==='response.create').length,1);
 assert.equal(Buffer.concat(seen.audio).length,6400);assert.match(JSON.stringify(seen.events.filter(e=>e.type==='conversation.item.create')),/本人|self/);assert.match(JSON.stringify(seen.events),/当前问题/);
 assert.equal(seen.events.at(-1).type,'response.create');
});
test('native response abort and timeout terminate the upstream session',async t=>{
 assert.equal(typeof module.createNativeAudioRunner,'function');
 const {url,seen}=await upstream(t,{hang:true});const run=module.createNativeAudioRunner({apiKey:'key',wsUrl:url,timeoutMs:120,startTimeoutMs:1000});
 await assert.rejects(run({prompt:'测试',audioTurns:turns()}),e=>e.code==='AI_TIMEOUT');
 const abort=new AbortController();const promise=module.createNativeAudioRunner({apiKey:'key',wsUrl:url,timeoutMs:3000})({prompt:'测试',audioTurns:turns(),signal:abort.signal});setTimeout(()=>abort.abort(),50);
 await assert.rejects(promise,e=>e.code==='AI_CANCELLED');
 for(let i=0;i<50&&seen.closed<2;i++)await new Promise(r=>setTimeout(r,10));assert.equal(seen.closed,2,'upstream sockets must close after both timeout and cancellation');
});
test('native startup is bounded and provider failures never expose upstream secrets',async t=>{
 assert.equal(typeof module.createNativeAudioRunner,'function');
 const stalled=await upstream(t,{noReady:true});await assert.rejects(module.createNativeAudioRunner({apiKey:'key',wsUrl:stalled.url,startTimeoutMs:50})({prompt:'测试',audioTurns:turns()}),e=>e.code==='AI_TIMEOUT');
 const failed=await upstream(t,{error:true});await assert.rejects(module.createNativeAudioRunner({apiKey:'private-secret',wsUrl:failed.url})({prompt:'测试',audioTurns:turns()}),e=>!e.message.includes('private-secret')&&!e.message.includes('never expose'));
});
test('native early disconnect cannot turn partial text into a completed answer',async t=>{
 assert.equal(typeof module.createNativeAudioRunner,'function');const {url}=await upstream(t,{disconnect:true});
 await assert.rejects(module.createNativeAudioRunner({apiKey:'key',wsUrl:url})({prompt:'测试',audioTurns:turns()}),e=>e.code==='AI_PROCESS_FAILED');
});
test('native configuration and audio limits fail before connecting',async()=>{
 assert.equal(typeof module.createNativeAudioRunner,'function');
 await assert.rejects(module.createNativeAudioRunner({apiKey:'',wsUrl:'wss://example.com/realtime'})({prompt:'测试',audioTurns:turns()}),e=>e.code==='AI_NOT_CONFIGURED');
 await assert.rejects(module.createNativeAudioRunner({apiKey:'key',wsUrl:'ws://example.com'})({prompt:'测试',audioTurns:turns()}),e=>e.code==='AI_NOT_CONFIGURED');
 await assert.rejects(module.createNativeAudioRunner({apiKey:'key',wsUrl:'ws://localhost',maxAudioBytes:100})({prompt:'测试',audioTurns:turns()}),e=>e.code==='AI_AUDIO_LIMIT');
 assert.equal(module.nativeAudioConfiguration({apiKey:'key',workspaceId:'workspace'}).configured,true);
});
test('configured Qwen3.5 audio model omits the Qwen3.8-only channel fields',async t=>{
 const {url,seen}=await upstream(t);const model='qwen3.5-omni-flash-realtime';
 await module.createNativeAudioRunner({apiKey:'key',wsUrl:url,model})({prompt:'测试',audioTurns:turns()});
 const format=seen.events.find(e=>e.type==='session.update').session.audio.input.format;
 assert.deepEqual(format,{type:'pcm',sample_rate:16000});
});

test('custom audio model reaches upstream unless an explicit server allowlist forbids it',async t=>{
 const {url,seen}=await upstream(t);const model='qwen3.5-omni-flash-realtime';
 assert.equal(module.nativeAudioConfiguration({apiKey:'key',wsUrl:url}).customModelsAllowed,true);
 await module.createNativeAudioRunner({apiKey:'key',wsUrl:url})({prompt:'测试',model,audioTurns:turns()});
 assert.equal(new URL(seen.url,'http://localhost').searchParams.get('model'),model);
 await assert.rejects(module.createNativeAudioRunner({apiKey:'key',wsUrl:url,models:['qwen3.8-omni-flash-realtime']})({prompt:'测试',model,audioTurns:turns()}),e=>e.code==='AI_NOT_CONFIGURED');
 await assert.rejects(module.createNativeAudioRunner({apiKey:'key',wsUrl:url})({prompt:'测试',model:'x --key secret',audioTurns:turns()}),e=>e.code==='AI_NOT_CONFIGURED');
});
