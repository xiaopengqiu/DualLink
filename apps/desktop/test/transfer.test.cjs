const {test}=require('node:test');
const assert=require('node:assert/strict');
test('RTC sender chunks below 48KiB, sends manual review metadata and only resolves on matching ack',async()=>{
  const {sendCapture}=require('../renderer/transfer.js');
  const listeners=new Map(); const frames=[];
  const channel={readyState:'open',bufferedAmount:0,send(frame){frames.push(frame);if(typeof frame==='string'&&JSON.parse(frame).type==='capture.end'){queueMicrotask(()=>{for(const fn of listeners.get('message')||[])fn({data:JSON.stringify({type:'capture.ack',captureId:'cap1'})});});}},addEventListener(n,f){if(!listeners.has(n))listeners.set(n,new Set());listeners.get(n).add(f);},removeEventListener(n,f){listeners.get(n)?.delete(f);}};
  const bytes=new Uint8Array(130000);
  await sendCapture(channel,{captureId:'cap1',analyze:false,provider:'claude',mime:'image/png',deviceId:'pc1'},bytes,{ackTimeoutMs:1000});
  assert.equal(JSON.parse(frames[0]).analyze,false);
  const chunks=frames.filter(f=>typeof f!=='string');
  assert.ok(chunks.every(f=>f.byteLength<=48*1024));
  assert.equal(chunks.reduce((n,f)=>n+f.byteLength,0),bytes.byteLength);
  assert.equal(listeners.get('message').size,0);
});
test('RTC sender rejects closed channel and missing cloud ack',async()=>{
  const {sendCapture}=require('../renderer/transfer.js');
  await assert.rejects(sendCapture({readyState:'closed'},{},new Uint8Array(1)),/连接/);
  const channel={readyState:'open',bufferedAmount:0,send(){},addEventListener(){},removeEventListener(){}};
  await assert.rejects(sendCapture(channel,{captureId:'cap2'},new Uint8Array(1),{ackTimeoutMs:15}),/确认/);
});
test('RTC sender ignores an acknowledgement received before transfer end',async()=>{
  const {sendCapture}=require('../renderer/transfer.js');const listeners=new Set();
  const channel={readyState:'open',bufferedAmount:0,send(frame){if(typeof frame==='string'&&JSON.parse(frame).type==='capture.start'){for(const fn of listeners)fn({data:JSON.stringify({type:'capture.ack',captureId:'early'})});}},addEventListener(name,fn){if(name==='message')listeners.add(fn);},removeEventListener(name,fn){if(name==='message')listeners.delete(fn);}};
  await assert.rejects(sendCapture(channel,{captureId:'early'},new Uint8Array(1),{ackTimeoutMs:15}),/确认/);
});
