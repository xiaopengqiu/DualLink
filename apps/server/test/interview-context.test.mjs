import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../src/interview-context.mjs').catch(() => ({}));
test('bounded interview context preserves recent actual speech and retrieves earlier matching facts', () => {
  assert.equal(typeof module.assembleInterviewContext, 'function', 'context assembler must exist');
  const segments = Array.from({ length: 100 }, (_, i) => ({ id: String(i), track: i % 2 ? 'self' : 'remote', text: i === 3 ? '青竹项目使用消息队列实现了可靠重试。' : `${i} 普通问答记录。`, startMs: i * 1000, endMs: (i+1)*1000, final: true }));
  const result = module.assembleInterviewContext({ style: '中文简洁', question: '青竹项目的消息队列为什么这样设计？', segments, files: [{ name: 'project.md', text: '青竹项目中队列负责异步解耦。' }], budget: 8000 });
  assert.ok(result.prompt.length <= 8000);
  assert.match(result.prompt, /可靠重试/);
  assert.match(result.prompt, /99 普通问答/);
  assert.match(result.prompt, /异步解耦/);
  assert.match(result.prompt, /本人实际发言/);
  assert.ok(result.watermark);
});
test('small context budgets reserve the question, label truncation and only report included speech',()=>{
  const result=module.assembleInterviewContext({question:'Q'.repeat(8000)+'QUESTION_END',style:'S'.repeat(30000),segments:[{id:'large',track:'self',text:'R'.repeat(16000),startMs:0,endMs:100,final:true}],files:[{name:'source.md',text:'F'.repeat(30000)}],budget:4000});
  assert.ok(result.prompt.length<=4000);assert.ok(result.prompt.endsWith('</当前问题>'));assert.equal(result.questionTruncated,true);assert.match(result.prompt,/问题过长.*截断/);
  for(const source of result.sources)assert.ok(result.prompt.includes(source.excerpt));
});
