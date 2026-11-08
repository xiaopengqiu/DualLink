import test from 'node:test';
import assert from 'node:assert/strict';
test('pending screenshot draft survives refresh per account including idempotent analysis request',async()=>{
  const {readScreenshotDraft,writeScreenshotDraft}=await import('../src/screenshot-draft.mjs');
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  writeScreenshotDraft(storage,'a',{ids:['first','second'],sizes:{first:400,second:800},request:{signature:'request',requestId:'id'}});
  assert.deepEqual(readScreenshotDraft(storage,'a'),{ids:['first','second'],sizes:{first:400,second:800},request:{signature:'request',requestId:'id'}});
  assert.deepEqual(readScreenshotDraft(storage,'b').ids,[]);
  writeScreenshotDraft(storage,'a',{ids:[],sizes:{},request:null});
  assert.deepEqual(readScreenshotDraft(storage,'a').ids,[]);
});
test('invalid or inaccessible browser draft storage cannot break the screenshot workspace',async()=>{
  const {readScreenshotDraft,writeScreenshotDraft}=await import('../src/screenshot-draft.mjs');
  assert.deepEqual(readScreenshotDraft({getItem(){throw Error('denied');}},'a').ids,[]);
  assert.deepEqual(readScreenshotDraft({getItem:()=>'{broken'},'a').ids,[]);
  assert.doesNotThrow(()=>writeScreenshotDraft({setItem(){throw Error('denied');}},'a',{ids:[],sizes:{},request:null}));
});
