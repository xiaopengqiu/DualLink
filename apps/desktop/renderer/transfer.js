(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.DualTransfer=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const CHUNK=48*1024,MAX=12*1024*1024;
  async function sendCapture(channel,metadata,bytes,options={}){
    if(channel.readyState!=='open')throw new Error('直连连接尚未就绪');
    if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>MAX)throw new Error('直传截图大小无效');
    const ackTimeoutMs=options.ackTimeoutMs??12000;
    return new Promise((resolve,reject)=>{
      let done=false,ended=false;let timer;
      function finish(error,result){if(done)return;done=true;clearTimeout(timer);channel.removeEventListener('message',onMessage);channel.removeEventListener('close',onClose);error?reject(error):resolve(result);}
      function onMessage(event){if(!ended||typeof event.data!=='string')return;try{const m=JSON.parse(event.data);if(m.type==='capture.ack'&&m.captureId===metadata.captureId)finish(null,{cloudCaptureId:typeof m.cloudCaptureId==='string'&&m.cloudCaptureId.length<=100?m.cloudCaptureId:null});}catch{}}
      function onClose(){finish(new Error('直连连接已断开'));}
      channel.addEventListener('message',onMessage);channel.addEventListener('close',onClose);
      timer=setTimeout(()=>finish(new Error('未收到云端上传确认，已启用云端回退')),ackTimeoutMs);
      (async()=>{
        channel.send(JSON.stringify({...metadata,type:'capture.start',size:bytes.byteLength}));
        for(let offset=0;offset<bytes.byteLength&&!done;offset+=CHUNK){
          while(channel.bufferedAmount>256*1024&&!done){await new Promise(r=>setTimeout(r,12));if(channel.readyState!=='open')throw new Error('直连连接已断开');}
          if(!done)channel.send(bytes.slice(offset,offset+CHUNK).buffer);
        }
        if(!done){ended=true;channel.send(JSON.stringify({type:'capture.end',captureId:metadata.captureId}));}
      })().catch(finish);
    });
  }
  return {sendCapture,CHUNK,MAX};
});
