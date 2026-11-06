'use strict';

// Cost stays 12. This thread exists so bcrypt does not run on the API event loop.
const { parentPort } = require('node:worker_threads');
const { hash, compare } = require('bcryptjs');

const COST = 12;

if (!parentPort) throw new Error('Password worker requires a parent port.');

parentPort.on('message', (message) => {
  const id = message && message.id;
  const op = message && message.op;
  const password = typeof message?.password === 'string' ? message.password : '';
  const passwordHash = typeof message?.passwordHash === 'string' ? message.passwordHash : '';
  if (message) {
    message.password = '';
    message.passwordHash = '';
  }
  const finish = (ok, value) => parentPort.postMessage({ id, ok, value });
  if (op === 'hash') {
    hash(password, COST).then(
      (value) => finish(true, value),
      () => finish(false),
    );
    return;
  }
  if (op === 'compare') {
    compare(password, passwordHash).then(
      (value) => finish(true, value),
      () => finish(false),
    );
    return;
  }
  finish(false);
});
