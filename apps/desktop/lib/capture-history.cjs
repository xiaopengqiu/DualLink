'use strict';
const values=input=>new Set(Array.isArray(input)?input.slice(0,200).filter(x=>typeof x==='string'&&x.length<=100):[]);
function affectedCaptureBatches(queue,event,deviceId){
 if(!deviceId||event?.kind!=='captures')return [];
 const ids=values(event.deletedIds),keys=values(event.captureKeys),requests=values(event.requestIds);
 return queue.batches.filter(batch=>batch.deviceId===deviceId&&(requests.has(batch.id)||batch.captureIds.some(id=>keys.has(id))||queue.items.some(item=>item.batchId===batch.id&&ids.has(item.uploadedId)))).map(batch=>batch.id);
}
function intentionalCaptureDeletion(error){return error?.status===410&&error?.code==='HISTORY_DELETED';}
module.exports={affectedCaptureBatches,intentionalCaptureDeletion};
