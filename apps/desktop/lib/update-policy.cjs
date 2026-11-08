'use strict';
function updateBlockReason({capturing=false,uploading=false,queueLength=0,activeActions=0,audio={}}={}){
 if(capturing)return '正在截图，请完成截图后再安装更新';
 if(uploading||queueLength>0)return '还有截图等待上传，请完成上传后再安装更新';
 if(['connecting','ready','recording','stopping','paused'].includes(audio.phase))return '面试会话尚未结束，请结束并保存后再安装更新';
 if(audio.pending>0||audio.recoveringId)return '音频正在同步或回补，请完成后再安装更新';
 if(activeActions>0)return '客户端任务正在处理，请稍后再安装更新';
 return '';
}
module.exports={updateBlockReason};
