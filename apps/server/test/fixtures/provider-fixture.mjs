import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [mode, ...args] = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => { stdin += part; });
process.stdin.on('end', async () => {
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'tree') {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync('child-process.pid', String(child.pid));
    setInterval(() => {}, 1000); return;
  }
  if (mode === 'overflow') { process.stdout.write('X'.repeat(100000)); return; }
  if (mode === 'failure') { process.stderr.write(`Authentication failed: ${process.env.ANTHROPIC_API_KEY}`); process.exitCode = 1; return; }
  const emit = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
  if (mode === 'codex') {
    const file = args[args.indexOf('--image') + 1];
    if (!args.includes('--json') || !args.includes('read-only') || readFileSync(file, 'utf8') !== 'image-fixture') process.exit(3);
    emit({ type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } });
    emit({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'never show this' } });
    const line = `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: stdin } })}\n`;
    const bytes = Buffer.from(line);
    process.stdout.write(bytes.subarray(0, 67));
    await new Promise(r => setTimeout(r, 5));
    process.stdout.write(bytes.subarray(67));
    emit({ type: 'turn.completed', usage: { input_tokens: 13, output_tokens: 7 } });
  } else if (mode === 'claude') {
    const message = JSON.parse(stdin.trim()).message;
    if (!args.includes('stream-json') || message.content[1].source.data !== Buffer.from('image-fixture').toString('base64') || message.content[0].text !== '看图回答') process.exit(4);
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } } });
    for (const text of ['你好', '世界']) emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: '你好世界' }] } });
    emit({ type: 'result', subtype: 'success', result: '你好世界', usage: { output_tokens: 4 } });
  }
});
