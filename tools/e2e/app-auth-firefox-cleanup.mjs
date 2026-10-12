// Cleanup regression for verifyFirefoxApp: each case fails one stage on
// purpose in a child process, which must reject with the original failure and
// then exit on its own. The parent checks the real resources afterwards: the
// listener refuses connections, the owned Firefox process is gone and the
// owned profile directory no longer exists.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
const CASES = {
  build: { expect: 'fixture: bundle build failed', launches: false },
  // A real process that starts and exits at once, so the launch really fails:
  // Node rejects the Firefox flags (portable across Linux, macOS, Windows).
  launch: { expect: 'Failed to launch the browser process', launches: false },
  // Writing the failure record throws (missing artifacts directory).
  record: {
    expect: 'fixture: verification failed after launch',
    launches: true,
    cleanupErrors: 1,
    cleanupError: 'failure record',
  },
  verify: { expect: 'fixture: verification failed after launch', launches: true },
  cleanup: {
    expect: 'fixture: verification failed after launch',
    launches: true,
    cleanupErrors: 1,
  },
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const refused = (port) =>
  new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', (e) => done(e.code === 'ECONNREFUSED'));
  });

async function child(name, root, firefox, repoDir, outDir) {
  const { verifyFirefoxApp } = await import(
    pathToFileURL(resolve(dirname(self), 'app-auth-firefox.mjs')).href
  );
  const resources = {};
  const faults =
    name === 'build'
      ? {
          build: () => {
            throw new Error('fixture: bundle build failed');
          },
        }
      : name === 'launch'
        ? { firefox: process.execPath }
        : name === 'verify' || name === 'record'
          ? { verify: true }
          : { verify: true, cleanup: true };
  let outcome;
  try {
    await verifyFirefoxApp({
      root,
      repoDir,
      outDir,
      // A directory that does not exist, so writing the failure record throws.
      artifacts:
        name === 'record'
          ? resolve(tmpdir(), 'agg-missing-artifacts', String(process.pid))
          : undefined,
      firefox,
      display: process.env.DISPLAY,
      faults,
      onResources: (r) => Object.assign(resources, r),
    });
    outcome = { rejected: false };
  } catch (error) {
    outcome = {
      rejected: true,
      message: String(error.message),
      cleanupErrors: (error.cleanupErrors ?? []).map((e) => e.message),
    };
  }
  // No process.exit: the parent requires this process to end by itself.
  process.stdout.write(JSON.stringify({ ...outcome, resources }) + '\n');
}

/** Runs every case; throws on the first leaked resource or wrong outcome. */
export async function verifyFirefoxCleanup({ root, firefox, display, artifacts }) {
  const work = mkdtempSync(resolve(tmpdir(), 'agg-ff-cleanup-'));
  const results = [];
  try {
    const repoDir = resolve(work, 'repo');
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: repoDir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
    // Three commits: the helper's first check expects the default repo's graph.
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(resolve(repoDir, `${name}.txt`), `${name}\n`);
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-q', '-m', name);
    }
    for (const [name, spec] of Object.entries(CASES)) {
      const outDir = resolve(work, `dist-${name}`);
      const proc = spawn(
        process.execPath,
        [self, '--child', name, root, firefox, repoDir, outDir],
        {
          env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '',
        err = '';
      proc.stdout.on('data', (d) => (out += d));
      proc.stderr.on('data', (d) => (err += d));
      const code = await new Promise((done) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          done('timeout');
        }, 120_000);
        proc.once('exit', (c) => {
          clearTimeout(timer);
          done(c);
        });
      });
      assert.equal(code, 0, `${name}: helper process exits by itself (stderr: ${err.slice(-600)})`);
      const report = JSON.parse(out.trim().split('\n').at(-1));
      const { port, pid, profile } = report.resources;
      assert(report.rejected, `${name}: helper rejects`);
      assert.match(report.message, new RegExp(spec.expect), `${name}: original failure kept`);
      assert.equal(report.cleanupErrors.length, spec.cleanupErrors ?? 0, `${name}: cleanup errors`);
      if (spec.cleanupError)
        assert(
          report.cleanupErrors.every((e) => e.startsWith(spec.cleanupError)),
          `${name}: cleanup error names the failing step`,
        );
      assert(typeof port === 'number', `${name}: listener was started`);
      assert(await refused(port), `${name}: listener closed`);
      if (spec.launches) assert(typeof pid === 'number', `${name}: Firefox was launched`);
      if (pid) assert(!alive(pid), `${name}: owned Firefox process released`);
      if (profile) assert(!existsSync(profile), `${name}: owned profile removed`);
      if (name !== 'build') assert(profile, `${name}: profile was created`);
      results.push({ case: name, exitCode: code, ...report });
    }
    if (artifacts)
      writeFileSync(
        resolve(artifacts, 'firefox-app-cleanup-results.json'),
        JSON.stringify({ results }, null, 2) + '\n',
      );
    console.log(
      `PASS Firefox helper cleanup: ${results.length} failure cases release listener, browser and profile`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') await child(...process.argv.slice(3));
