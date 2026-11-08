const {test}=require('node:test');
const assert=require('node:assert/strict');
test('installation waits for capture, uploads, active interviews and audio replay but permits idle clients',()=>{
 const {updateBlockReason}=require('../lib/update-policy.cjs');
 assert.equal(updateBlockReason({}), '');
 assert.match(updateBlockReason({capturing:true}),/截图/);
 assert.match(updateBlockReason({uploading:true}),/上传/);
 assert.match(updateBlockReason({queueLength:1}),/上传/);
 for(const phase of ['connecting','ready','recording','stopping','paused'])assert.match(updateBlockReason({audio:{phase}}),/面试/);
 assert.match(updateBlockReason({audio:{phase:'ended',pending:1}}),/音频/);
 assert.match(updateBlockReason({audio:{phase:'idle',recoveringId:'s'}}),/音频/);
 assert.match(updateBlockReason({activeActions:1}),/任务/);
 assert.equal(updateBlockReason({audio:{phase:'ended',pending:0}}),'');
});
