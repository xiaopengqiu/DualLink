import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
appendFileSync(process.env.FIXTURE_JOURNAL, `${process.pid}\n`);
let count=0, turn;const subscribed=new Set();
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
readline.createInterface({input:process.stdin}).on('line',raw=>{
 const msg=JSON.parse(raw);
 if(msg.method==='initialize') emit({id:msg.id,result:{userAgent:'fixture'}});
 else if(msg.method==='thread/start') {
   if(process.env.FIXTURE_MODELS_JOURNAL)appendFileSync(process.env.FIXTURE_MODELS_JOURNAL,JSON.stringify(msg.params.model||null)+'\n');
   if(subscribed.size){emit({id:msg.id,error:{message:'previous ephemeral thread not released'}});return;}
   if(!msg.params.ephemeral || msg.params.sandbox!=='read-only') {emit({id:msg.id,error:{message:'unsafe thread'}});return;}
   const id=`thread-${++count}`;subscribed.add(id);emit({id:msg.id,result:{thread:{id}}});
 } else if(msg.method==='thread/unsubscribe') {
   subscribed.delete(msg.params.threadId);emit({id:msg.id,result:{status:'unsubscribed'}});
 } else if(msg.method==='turn/start') {
   if(msg.params.effort!=='low') {emit({id:msg.id,error:{message:'interview must request low effort'}});return;}
   turn={id:`turn-${count}`,threadId:msg.params.threadId};
   emit({id:msg.id,result:{turn}});
   const text=msg.params.input[0].text;
   emit({method:'item/started',params:{threadId:turn.threadId,turnId:turn.id,item:{id:'tool',type:'commandExecution',command:'private-tool-output'}}});
   if(text==='HANG') return;
   for(const delta of [text.slice(0,2),text.slice(2)]) if(delta)emit({method:'item/agentMessage/delta',params:{threadId:turn.threadId,turnId:turn.id,itemId:'answer',delta}});
   emit({method:'item/completed',params:{threadId:turn.threadId,turnId:turn.id,item:{id:'answer',type:'agentMessage',text,phase:'final_answer'}}});
   emit({method:'turn/completed',params:{threadId:turn.threadId,turn:{...turn,status:'completed'}}});
 } else if(msg.method==='turn/interrupt') {
   emit({id:msg.id,result:{}}); if(turn)emit({method:'turn/completed',params:{threadId:turn.threadId,turn:{...turn,status:'interrupted'}}});
 } else if(msg.id!==undefined)emit({id:msg.id,result:{}});
});
