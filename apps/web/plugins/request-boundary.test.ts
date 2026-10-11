import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { gitSnapshot } from './git-snapshot.ts';

describe('local endpoint request boundary on a real Vite server', () => {
  it.each([{ allowedHosts: true }, { allowedHosts: ['rd.example', '.rd.test'] }] as const)(
    'checks Host and complete Origin independently of allowedHosts=%j',
    async ({ allowedHosts }) => {
      const dir = mkdtempSync(join(tmpdir(), 'agg-boundary-'));
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: dir,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_OPTIONAL_LOCKS: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      let server: Awaited<ReturnType<typeof createServer>> | undefined;
      const flag = process.env['VITEST'];
      try {
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'Fixture');
        git('config', 'user.email', 'fixture@example.test');
        git('config', 'commit.gpgSign', 'false');
        writeFileSync(join(dir, 'fixture.txt'), 'boundary fixture\n');
        git('add', '.');
        git('commit', '-q', '-m', 'fixture');
        delete process.env['VITEST'];
        server = await createServer({
          configFile: false,
          envFile: false,
          root: dir,
          plugins: [gitSnapshot({ repoDir: dir, repoRoots: [dir], stateFile: false })],
          server: {
            host: '127.0.0.1',
            port: 0,
            allowedHosts: allowedHosts === true ? true : [...allowedHosts],
          },
        });
        await server.listen();
        process.env['VITEST'] = flag;
        const port = (server.httpServer!.address() as AddressInfo).port;
        const send = (path: string, host: string, origin?: string) =>
          new Promise<number>((resolve, reject) => {
            const diagnostic = path.endsWith('/diagnostics');
            const req = request(
              {
                hostname: '127.0.0.1',
                port,
                path,
                method: diagnostic ? 'POST' : 'GET',
                headers: {
                  host,
                  'sec-fetch-site': 'same-origin',
                  ...(origin ? { origin } : {}),
                  ...(diagnostic ? { 'content-type': 'application/json' } : {}),
                },
              },
              (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode!));
              },
            );
            req.on('error', reject);
            req.end(
              diagnostic
                ? JSON.stringify({ operation: 'compare', base: 'main', head: 'main' })
                : undefined,
            );
          });
        for (const path of ['/__agg/diagnostics', '/__agg/git-snapshot', '/__agg/repos']) {
          expect(
            await send(path, `untrusted.example:${port}`, `http://untrusted.example:${port}`),
          ).toBe(403);
          expect(await send(path, `localhost:${port}`, `https://localhost:${port}`)).toBe(403);
          expect(await send(path, `localhost:${port}`, `http://localhost:${port + 1}`)).toBe(403);
          expect(await send(path, `localhost:${port}`, `http://localhost:${port}`)).toBe(200);
          expect(await send(path, `127.0.0.1:${port}`, `http://127.0.0.1:${port}`)).toBe(200);
          expect(await send(path, `[::1]:${port}`, `http://[::1]:${port}`)).toBe(200);
          if (allowedHosts !== true) {
            expect(await send(path, `rd.example:${port}`, `http://rd.example:${port}`)).toBe(200);
            expect(
              await send(path, `nested.rd.test:${port}`, `http://nested.rd.test:${port}`),
            ).toBe(200);
            expect(await send(path, `notrd.test:${port}`, `http://notrd.test:${port}`)).toBe(403);
          }
        }
      } finally {
        if (flag === undefined) delete process.env['VITEST'];
        else process.env['VITEST'] = flag;
        await server?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
