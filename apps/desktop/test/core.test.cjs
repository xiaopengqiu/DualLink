const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('cloud URL allows HTTPS and loopback development, rejects credentials and insecure hosts', () => {
  const {normalizeCloudUrl} = require('../lib/core.cjs');
  assert.equal(normalizeCloudUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeCloudUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeCloudUrl('http://[::1]:3000/'), 'http://[::1]:3000');
  for (const url of ['http://example.com','file:///x','https://a:b@example.com','https://example.com/?token=x','https://example.com/path','javascript:alert(1)']) {
    assert.throws(() => normalizeCloudUrl(url));
  }
});

test('queue survives restart, preserves review setting and removes successful images', async () => {
  const {CaptureQueue} = require('../lib/queue.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'dual-link-queue-'));
  try {
    const queue = new CaptureQueue(dir);
    await queue.load();
    const job=await queue.add(Buffer.from('image'),{analyze:false,provider:'claude',deviceId:'pc1',name:'截图.png'});
    const loaded=new CaptureQueue(dir);
    await loaded.load();
    assert.equal(loaded.items[0].captureId,job.captureId);
    assert.equal(loaded.items[0].analyze,false);
    assert.equal((await loaded.read(job.captureId)).toString(),'image');
    await loaded.complete(job.captureId);
    assert.equal(loaded.items.length,0);
    await assert.rejects(fs.access(path.join(dir,job.captureId+'.png')));
    await assert.rejects(loaded.read('../private'));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('queue rejects oversized images and bounds pending local captures', async () => {
  const {CaptureQueue} = require('../lib/queue.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'dual-link-queue-'));
  try {
    const queue = new CaptureQueue(dir,{maxItems:1,maxBytes:8});await queue.load();
    await assert.rejects(queue.add(Buffer.alloc(9),{}),/过大/);
    await queue.add(Buffer.from('one'),{analyze:true});
    await assert.rejects(queue.add(Buffer.from('two'),{}),/队列/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('settings constrain shortcuts and model, and crop bounds track actual screenshot resolution', () => {
  const {validateSettings,cropRect}=require('../lib/core.cjs');
  assert.equal(validateSettings({provider:'codex',fullShortcut:'Ctrl+Alt+S',regionShortcut:'Ctrl+Alt+R'}).provider,'codex');
  assert.throws(()=>validateSettings({provider:'other'}));
  assert.throws(()=>validateSettings({fullShortcut:'Ctrl+Alt+S',regionShortcut:'Ctrl+Alt+S'}));
  assert.deepEqual(cropRect({x:10,y:20,width:100,height:50}, {width:1000,height:500},{width:2000,height:1000}),{x:20,y:40,width:200,height:100});
  assert.throws(()=>cropRect({x:-1,y:0,width:1,height:1},{width:10,height:10},{width:10,height:10}));
});
