export function readSecret(label, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('当前终端不支持隐藏输入，请通过标准输入提供密码');
  return new Promise((resolve, reject) => {
    const previousRaw = !!input.isRaw; let value = ''; let done = false;
    output.write(label); input.setRawMode(true); input.resume();
    function finish(error) {
      if (done) return; done = true;
      input.off('data', onData); input.off('error', onError); input.setRawMode(previousRaw); input.pause(); output.write('\n');
      error ? reject(error) : resolve(value);
    }
    function onError(error) { finish(error); }
    function onData(chunk) {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('已取消密码输入'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('');
        else if (character >= ' ' && value.length < 256) value += character;
      }
    }
    input.on('data', onData); input.on('error', onError);
  });
}
