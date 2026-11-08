'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
test('history deletion finds only matching batches of the paired device, including completed task acknowledgements',()=>{
 const {affectedCaptureBatches}=require('../lib/capture-history.cjs');
 const queue={batches:[{id:'pending',deviceId:'pc',captureIds:['local-a']},{id:'done',deviceId:'pc',captureIds:['local-b'],status:'submitted'},{id:'other',deviceId:'foreign',captureIds:['local-a']}],items:[{captureId:'local-a',batchId:'pending',uploadedId:'cloud-a'}]};
 assert.deepEqual(affectedCaptureBatches(queue,{kind:'captures',deletedIds:['cloud-a']},'pc'),['pending']);
 assert.deepEqual(affectedCaptureBatches(queue,{kind:'captures',captureKeys:['local-b']},'pc'),['done']);
 assert.deepEqual(affectedCaptureBatches(queue,{kind:'captures',requestIds:['pending']},'pc'),['pending']);
 assert.deepEqual(affectedCaptureBatches(queue,{kind:'interviews',deletedIds:['cloud-a']},'pc'),[]);
 assert.deepEqual(affectedCaptureBatches(queue,{kind:'captures',deletedIds:['cloud-a']},'new-pc'),[]);
});
test('only an intentional history deletion is terminal; file damage continues using repair retries',()=>{
 const {intentionalCaptureDeletion}=require('../lib/capture-history.cjs');
 assert.equal(intentionalCaptureDeletion({status:410,code:'HISTORY_DELETED'}),true);
 for(const error of [{status:404,code:'CAPTURE_NOT_FOUND'},{status:409,code:'CAPTURE_FILE_MISSING'},{status:410},{status:401,code:'HISTORY_DELETED'},null])assert.equal(intentionalCaptureDeletion(error),false);
});
