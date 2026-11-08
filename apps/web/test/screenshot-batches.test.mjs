import test from 'node:test';
import assert from 'node:assert/strict';

test('all batch members show the same latest task while legacy tasks still match',async()=>{
  const {taskCaptureIds,latestCaptureTask}=await import('../src/screenshot-batches.mjs');
  const group={id:'g',captureId:'a',captureIds:['a','b','c'],createdAt:'2026-11-08T10:00:00Z'};
  const legacy={id:'l',captureId:'c',createdAt:'2026-11-08T09:00:00Z'};
  assert.deepEqual(taskCaptureIds(group),['a','b','c']);
  assert.deepEqual(taskCaptureIds(legacy),['c']);
  for(const id of ['a','b','c'])assert.equal(latestCaptureTask([group,legacy],id),group);
  assert.equal(latestCaptureTask([group,legacy],'missing'),undefined);
});

test('batch reanalysis preserves complete image order including images outside recent history',async()=>{
  const {taskCaptureIds,taskCaptures}=await import('../src/screenshot-batches.mjs');
  const full={id:'full',imageUrl:'/full.png'},other={id:'other',imageUrl:'/other.png'};
  const task={captureId:'full',captureIds:['full','missing','other'],captures:[full,other]};
  assert.deepEqual(taskCaptureIds(task),['full','missing','other']);
  assert.deepEqual(taskCaptures(task,[other]),[full,other]);
  assert.deepEqual(taskCaptureIds(null),[]);
});
