let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (line === 'compile') console.log('Found 0 errors. Watching for file changes.');
  }
});
setInterval(() => {}, 1000);
