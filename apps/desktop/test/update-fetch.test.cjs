'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
let createUpdateFetch;try{({createUpdateFetch}=require('../lib/update-fetch.cjs'));}catch{}
function fixture(run){
 assert.equal(typeof createUpdateFetch,'function','Chromium update fetch adapter must exist');
 const calls=[];let request;
 const net={request(options){calls.push(options);request=new EventEmitter();request.abortCount=0;request.abort=()=>{request.abortCount++;request.emit('abort');request.emit('error',new Error('Request was cancelled'));};request.end=()=>queueMicrotask(()=>run(request));request.followRedirect=()=>{throw Error('Adapter must never follow redirects');};return request;}};
 return {fetch:createUpdateFetch(net),calls,get request(){return request;}};
}
function incoming(status=200,headers={}){const stream=new PassThrough();stream.statusCode=status;stream.statusMessage='Fixture';stream.headers=headers;return stream;}

test('Chromium adapter streams a fetch Response and normalizes Electron header arrays',async()=>{
 const f=fixture(req=>{const response=incoming(200,{'content-type':['application/octet-stream'],'x-test':['a','b']});req.emit('response',response);response.write(Buffer.from('first'));setImmediate(()=>response.end(Buffer.from('second')));});
 const response=await f.fetch('https://github.com/x/y',{headers:{'User-Agent':'DualLink/1.4.1'},redirect:'manual'});
 assert.equal(response.status,200);assert.equal(response.headers.get('x-test'),'a, b');assert.equal(await response.text(),'firstsecond');
 assert.deepEqual(f.calls[0],{url:'https://github.com/x/y',method:'GET',headers:{'user-agent':'DualLink/1.4.1'},redirect:'manual',credentials:'omit'});
});

test('manual redirect returns status and Location without following and suppresses expected cancellation',async()=>{
 const f=fixture(req=>req.emit('redirect',302,'GET','https://release-assets.githubusercontent.com/asset?signature=fixture',{'x-test':['one']}));
 const response=await f.fetch('https://github.com/x/release',{redirect:'manual'});
 assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://release-assets.githubusercontent.com/asset?signature=fixture');assert.equal(response.body,null);assert.equal(f.request.abortCount,1);assert.equal(f.calls.length,1);
});

test('pre-aborted signals do not start a network request',async()=>{
 const f=fixture(()=>{}),abort=new AbortController();abort.abort(new Error('cancelled before start'));
 await assert.rejects(f.fetch('https://github.com/x',{signal:abort.signal}),/cancelled before start/);assert.equal(f.calls.length,0);
});

test('abort before headers rejects and cancels the Chromium request',async()=>{
 const f=fixture(()=>{}),abort=new AbortController();const pending=f.fetch('https://github.com/x',{signal:abort.signal});abort.abort(new Error('cancelled before headers'));
 await assert.rejects(pending,/cancelled before headers/);assert.equal(f.request.abortCount,1);
});

test('abort after headers rejects the pending body and cancels the request',async()=>{
 const f=fixture(req=>{const response=incoming();req.emit('response',response);response.write('start');}),abort=new AbortController();
 const response=await f.fetch('https://github.com/x',{signal:abort.signal});const pending=response.text();abort.abort(new Error('cancelled stream'));
 await assert.rejects(pending,/cancelled stream/);assert.equal(f.request.abortCount,1);
});

test('request errors and truncated response streams cannot become successful downloads',async()=>{
 const failed=fixture(req=>req.emit('error',new Error('connection failed')));await assert.rejects(failed.fetch('https://github.com/x'),/connection failed/);
 const truncated=fixture(req=>{const response=incoming();req.emit('response',response);response.write('partial');setImmediate(()=>response.destroy());});
 const response=await truncated.fetch('https://github.com/x');await assert.rejects(response.text());
});

test('cancelling response consumption aborts the underlying network request',async()=>{
 const f=fixture(req=>{const response=incoming();req.emit('response',response);response.write('partial');});
 const response=await f.fetch('https://github.com/x');await response.body.cancel();assert.equal(f.request.abortCount,1);
});
