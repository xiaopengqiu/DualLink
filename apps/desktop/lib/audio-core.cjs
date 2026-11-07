'use strict';
const TRACKS = Object.freeze({remote:0,self:1});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function encodeAudioFrame({track,seq,startMs,samples,replay=false}) {
  if (!(track in TRACKS) || !Number.isInteger(seq) || seq < 0 || seq > 0xffffffff || !Number.isFinite(startMs) || startMs < 0 || startMs > 0xffffffff) throw new Error('音频分块参数无效');
  const pcm = Buffer.isBuffer(samples) ? samples : samples instanceof ArrayBuffer ? Buffer.from(samples) : ArrayBuffer.isView(samples) ? Buffer.from(samples.buffer,samples.byteOffset,samples.byteLength) : null;
  if (!pcm || pcm.length < 2 || pcm.length > 6400 || pcm.length % 2) throw new Error('音频分块大小无效');
  const frame = Buffer.allocUnsafe(16 + pcm.length);
  frame[0]=1;frame[1]=TRACKS[track];frame.writeUInt16BE(replay?1:0,2);frame.writeUInt32BE(seq,4);frame.writeUInt32BE(Math.round(startMs),8);frame.writeUInt32BE(pcm.length/2,12);pcm.copy(frame,16);
  return frame;
}
function validateSessionId(id) { if(typeof id!=='string'||!UUID.test(id))throw new Error('录音会话编号无效');return id; }
module.exports={encodeAudioFrame,validateSessionId,TRACKS};
