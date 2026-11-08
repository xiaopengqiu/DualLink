const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
let core={},spools={};try{core=require('../lib/audio-core.cjs');}catch{}try{spools=require('../lib/audio-spool.cjs');}catch{}

test('audio resampling is continuous across irregular render blocks and preserves amplitude',async()=>{
  const {PcmResampler}=await import('../renderer/audio-pcm.mjs').catch(()=>({}));
  assert.equal(typeof PcmResampler,'function','streaming resampler is implemented');
  const whole=new Float32Array(48000).fill(.25);
  const a=new PcmResampler(48000),b=new PcmResampler(48000);let x=[],y=[];
  x.push(...a.push(whole));
  for(let at=0;at<whole.length;at+=127)y.push(...b.push(whole.subarray(at,at+127)));
  assert.equal(x.length,10);assert.equal(y.length,10);
  assert.deepEqual(Buffer.concat(x.map(v=>Buffer.from(v.buffer))),Buffer.concat(y.map(v=>Buffer.from(v.buffer))));
  assert.ok(x.every(frame=>frame.length===1600&&Math.abs(frame[40]-8192)<=1));
});

test('audio frame protocol validates sample counts and keeps tracks/sequences/timestamps',()=>{
  assert.equal(typeof core.encodeAudioFrame,'function','audio frame encoder is implemented');
  const frame=core.encodeAudioFrame({track:'self',seq:17,startMs:12345,samples:Buffer.from([0,0,255,127]),replay:true});
  assert.equal(frame.length,20);assert.equal(frame[0],1);assert.equal(frame[1],1);
  assert.equal(frame.readUInt16BE(2),1);assert.equal(frame.readUInt32BE(4),17);assert.equal(frame.readUInt32BE(8),12345);assert.equal(frame.readUInt32BE(12),2);
  assert.throws(()=>core.encodeAudioFrame({track:'other',seq:0,startMs:0,samples:Buffer.alloc(2)}));
  assert.throws(()=>core.encodeAudioFrame({track:'remote',seq:0,startMs:0,samples:Buffer.alloc(6402)}));
});

test('append-only audio spool survives restart, deduplicates ACKs and preserves timestamped replay',async t=>{
  assert.equal(typeof spools.AudioSpool,'function','audio spool is implemented');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dual-audio-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sessionId=randomUUID();let spool=await spools.AudioSpool.create(root,{sessionId,deviceId:'device-A',cloudUrl:'https://example.com',startedAt:Date.now()});
  await spool.append({track:'remote',startMs:123,samples:Buffer.alloc(3200)});
  await spool.append({track:'self',startMs:130,samples:Buffer.alloc(3200,1)});
  await spool.ack('remote',0);await spool.ack('remote',0);
  spool=await spools.AudioSpool.open(root,sessionId);
  assert.equal(spool.pendingRecords().length,1);assert.equal(spool.nextSequence('remote'),1);
  const frame=await spool.read(spool.pendingRecords()[0],true);assert.equal(frame.readUInt32BE(8),130);assert.equal(frame.readUInt16BE(2),1);
  assert.equal((await fs.readdir(path.join(root,sessionId))).filter(n=>n.endsWith('.bin')).length,1,'one file per session, not per frame');
});

test('audio spool rejects overrun and foreign owner recovery without writing into other paths',async t=>{
  assert.equal(typeof spools.AudioSpool,'function');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dual-audio-bound-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sessionId=randomUUID();const spool=await spools.AudioSpool.create(root,{sessionId,deviceId:'device-A',cloudUrl:'https://example.com',startedAt:Date.now()},{maxBytes:4000});
  await spool.append({track:'remote',startMs:0,samples:Buffer.alloc(3200)});
  await assert.rejects(spool.append({track:'self',startMs:0,samples:Buffer.alloc(3200)}),/空间|上限/);
  assert.equal(spool.matchesOwner({deviceId:'device-B',cloudUrl:'https://example.com'}),false);
  await assert.rejects(spools.AudioSpool.open(root,'../outside'),/编号/);
});

test('audio spool trims an uncommitted tail after a crash before appending recovery frames',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dual-audio-tail-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const sessionId=randomUUID();
  let spool=await spools.AudioSpool.create(root,{sessionId,deviceId:'A',cloudUrl:'https://example.com',startedAt:Date.now()});await spool.append({track:'remote',startMs:0,samples:Buffer.alloc(2)});
  await fs.appendFile(path.join(root,sessionId,'frames.bin'),Buffer.alloc(70,7));
  spool=await spools.AudioSpool.open(root,sessionId);const appended=await spool.append({track:'self',startMs:10,samples:Buffer.from([1,2])});const frame=await spool.read(appended);
  assert.equal(frame[0],1);assert.equal(frame[1],1);assert.equal(frame[16],1);assert.equal(frame[17],2);
});

test('listing caches never truncates an in-flight audio write',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dual-audio-list-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const sessionId=randomUUID();
  const owner={deviceId:'A',cloudUrl:'https://example.com'};const spool=await spools.AudioSpool.create(root,{sessionId,...owner,startedAt:Date.now()});
  await fs.writeFile(path.join(spool.dir,'frames.bin'),Buffer.alloc(18));await spools.AudioSpool.list(root,owner);
  assert.equal((await fs.stat(path.join(spool.dir,'frames.bin'))).size,18);
});

test('long-session status and frame reads use constant-time indexes instead of scanning history',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dual-audio-index-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const sessionId=randomUUID();
  const spool=await spools.AudioSpool.create(root,{sessionId,deviceId:'A',cloudUrl:'https://example.com',startedAt:Date.now()});const record=await spool.append({track:'remote',startMs:0,samples:Buffer.alloc(2)});
  spool.records.filter=()=>{throw new Error('status scanned full history');};spool.records.some=()=>{throw new Error('read scanned full history');};
  assert.equal(spool.view().pending,1);assert.equal((await spool.read(record)).length,18);await spool.ack('remote',0);assert.equal(spool.view().pending,0);
});

test('ended cache expiry is measured from completion rather than the first recording day',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'dual-audio-expiry-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const owner={deviceId:'A',cloudUrl:'https://example.com'};
 const spool=await spools.AudioSpool.create(root,{sessionId:randomUUID(),...owner,startedAt:Date.now()-40*86400000});await spool.status('ended');
 assert.ok(spool.meta.endedAt>Date.now()-1000);assert.deepEqual(await spools.AudioSpool.cleanup(root,owner),[]);await fs.access(spool.dir);
});
