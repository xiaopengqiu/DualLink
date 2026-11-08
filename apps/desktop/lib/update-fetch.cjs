'use strict';
function normalizeHeaders(values){
 const headers=new Headers();
 for(const [name,value]of Object.entries(values||{})){
  if(Array.isArray(value)){for(const item of value)headers.append(name,String(item));}
  else if(value!==undefined)headers.append(name,String(value));
 }
 return headers;
}
function abortError(signal){return signal?.reason instanceof Error?signal.reason:new DOMException(signal?.reason?String(signal.reason):'The update request was aborted','AbortError');}

// Chromium uses the operating system's proxy settings. Redirects stay manual so
// UpdateController can validate each hop before sending another request.
function createUpdateFetch(net){
 if(!net||typeof net.request!=='function')throw new TypeError('Electron net.request is required');
 return function updateFetch(input,options={}){
  return new Promise((resolve,reject)=>{
   const signal=options.signal;
   if(signal?.aborted){reject(abortError(signal));return;}
   let request,incoming,settled=false,ended=false,cancelled=false,bodyError;
   const cleanup=()=>signal?.removeEventListener('abort',onAbort);
   const stopRequest=()=>{if(cancelled)return;cancelled=true;try{request?.abort();}catch{}};
   const fail=error=>{
    if(cancelled||ended)return;
    const reason=error instanceof Error?error:new Error(String(error||'Update connection failed'));
    if(!settled){settled=true;cleanup();reject(reason);}
    bodyError?.(reason);
    if(incoming&&!incoming.destroyed)incoming.destroy(reason);
    stopRequest();
   };
   const onAbort=()=>{
    const reason=abortError(signal);
    if(!settled){settled=true;reject(reason);}
    cleanup();stopRequest();if(incoming&&!incoming.destroyed)incoming.destroy(reason);
    bodyError?.(reason);
   };
   try{
    if(options.method&&options.method.toUpperCase()!=='GET')throw new TypeError('Update transport only supports GET');
    if(options.redirect&&options.redirect!=='manual')throw new TypeError('Update transport requires manual redirects');
    const headers=Object.fromEntries(new Headers(options.headers||{}));
    request=net.request({url:String(input),method:'GET',headers,redirect:'manual',credentials:'omit'});
    request.on('error',fail);
    request.on('abort',()=>{if(!cancelled)fail(new DOMException('The update request was aborted','AbortError'));});
    request.on('close',()=>{
     // Writable finish/close can precede Chromium's response events. A genuinely
     // interrupted response is also observed on IncomingMessage below.
     if(!settled&&!cancelled&&!request.writableFinished)fail(new Error('Update connection closed before response headers'));
    });
    request.on('redirect',(statusCode,_method,redirectUrl,responseHeaders)=>{
     if(settled||cancelled)return;
     try{
      const headers=normalizeHeaders(responseHeaders);headers.set('location',String(redirectUrl));
      const response=new Response(null,{status:statusCode,headers});
      settled=true;cleanup();resolve(response);
      // Do not invoke followRedirect. Abort synchronously to avoid Electron's
      // expected "Redirect was cancelled" error becoming an unhandled error.
      stopRequest();
     }catch(error){fail(error);stopRequest();}
    });
    request.on('response',response=>{
     if(settled||cancelled){response.on?.('error',()=>{});response.destroy?.();return;}
     incoming=response;
     try{
      const status=response.statusCode,headers=normalizeHeaders(response.headers);
      let body=null,finished=false,streamController;
      const detach=()=>response.removeListener('data',onData);
      bodyError=error=>{if(finished)return;finished=true;detach();cleanup();streamController?.error(error);};
      const onData=chunk=>{
       if(finished)return;
       try{streamController.enqueue(chunk);if(streamController.desiredSize<=0)response.pause();}
       catch(error){bodyError(error);stopRequest();}
      };
      response.once('end',()=>{ended=true;cleanup();if(!finished){finished=true;detach();streamController?.close();}});
      response.once('close',()=>{cleanup();if(!ended){bodyError(new Error('Update response closed before completion'));stopRequest();}});
      response.on('error',error=>{bodyError(error);stopRequest();if(!response.destroyed)response.destroy();});
      response.once('aborted',()=>fail(new Error('Update response was interrupted')));
      if(![204,205,304].includes(status)){
       response.pause();
       body=new ReadableStream({
        start(controller){streamController=controller;},
        pull(){if(!finished)response.resume();},
        cancel(){finished=true;detach();cleanup();stopRequest();response.destroy();}
       },{highWaterMark:64*1024,size:chunk=>chunk.byteLength});
       response.on('data',onData);
      }
      const result=new Response(body,{status,headers});
      settled=true;resolve(result);
      if(body===null){ended=true;cleanup();stopRequest();}
     }catch(error){fail(error);stopRequest();}
    });
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted){onAbort();return;}
    request.end();
   }catch(error){fail(error);stopRequest();}
  });
 };
}
module.exports={createUpdateFetch};
