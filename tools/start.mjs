#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let repo = process.env.AGG_REPO_DIR ?? root,
  port = '4200';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--') continue;
  if (arg === '--help') {
    console.log(
      'pnpm start [--repo /absolute/path/or/~/repo] [--port 4200]\nRead-only local Git diagnostics; bound to localhost.',
    );
    process.exit(0);
  }
  if (arg === '--repo' && args[i + 1]) {
    const value = args[++i];
    repo = resolve(value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value);
  } else if (arg === '--port' && args[i + 1]) {
    port = args[++i];
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error('Invalid --port');
  } else throw new Error(`Unknown or incomplete option: ${arg}`);
}
const app = resolve(root, 'apps/web');
const require = createRequire(resolve(app, 'package.json'));
const cli = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const child = spawn(
  process.execPath,
  [cli, '--host', 'localhost', '--port', port, '--strictPort'],
  {
    cwd: app,
    env: { ...process.env, AGG_REPO_DIR: repo },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  },
);
console.log(`Adorable Git Graph · http://localhost:${port} · server PID ${child.pid}`);
let timer;
const stop = (signal) => {
  if (child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
  timer = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 5000);
  timer.unref();
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
child.once('error', (err) => {
  console.error(err.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  clearTimeout(timer);
  process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
});
