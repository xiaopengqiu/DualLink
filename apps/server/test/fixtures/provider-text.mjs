const [kind, ...args] = process.argv.slice(2);
let stdin = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', p => { stdin += p; });
process.stdin.on('end', () => {
 const emit = v => process.stdout.write(JSON.stringify(v) + '\n');
 if (kind === 'codex') {
   if (args.includes('--image')) { process.exitCode = 9; return; }
   emit({type:'item.completed',item:{type:'agent_message',text:stdin}}); emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}});
 } else {
   const content = JSON.parse(stdin.trim()).message.content;
   if (content.length !== 1 || content[0].type !== 'text') { process.exitCode = 10; return; }
   emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:content[0].text}}});
   emit({type:'result',subtype:'success',result:content[0].text});
 }
});
