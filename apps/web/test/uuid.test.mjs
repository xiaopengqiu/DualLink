import test from 'node:test';
import assert from 'node:assert/strict';
import {captureId} from '../src/uuid.mjs';
test('HTTP browser without secure-context randomUUID still generates distinct valid upload ids',()=>{
 const c={getRandomValues:array=>globalThis.crypto.getRandomValues(array)};
 const ids=Array.from({length:100},()=>captureId(c));
 assert.equal(new Set(ids).size,100);
 for(const id of ids)assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
