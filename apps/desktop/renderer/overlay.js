'use strict';
let start=null,background='';const selection=document.getElementById('selection');
window.dualLink.onOverlay(({dataUrl})=>{background=dataUrl;document.getElementById('screen').src=dataUrl;});
function rect(event){const x=Math.min(Math.max(0,event.clientX),window.innerWidth),y=Math.min(Math.max(0,event.clientY),window.innerHeight);return {x:Math.min(start.x,x),y:Math.min(start.y,y),width:Math.abs(start.x-x),height:Math.abs(start.y-y)};}
document.addEventListener('pointerdown',event=>{if(event.button!==0)return;start={x:event.clientX,y:event.clientY};selection.hidden=false;});
document.addEventListener('pointermove',event=>{if(!start)return;const area=rect(event);selection.style.left=area.x+'px';selection.style.top=area.y+'px';selection.style.width=area.width+'px';selection.style.height=area.height+'px';selection.style.backgroundImage=`url("${background}")`;selection.style.backgroundSize=`${window.innerWidth}px ${window.innerHeight}px`;selection.style.backgroundPosition=`-${area.x}px -${area.y}px`;document.getElementById('dimensions').textContent=`${Math.round(area.width)} × ${Math.round(area.height)}`;});
document.addEventListener('pointerup',event=>{if(!start)return;const area=rect(event);start=null;if(area.width>=4&&area.height>=4)window.dualLink.overlayResult(area);else selection.hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape')window.dualLink.overlayResult(null);});
document.addEventListener('contextmenu',event=>{event.preventDefault();window.dualLink.overlayResult(null);});
