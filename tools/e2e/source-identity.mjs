// Real React render regression for graph/diagnostic source pairing, in an isolated test browser.
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
export function prepareWebSourceIdentity(root) {
  const modulePath = resolve(root, 'apps/web/e2e/.artifacts/diagnostics/source-identity-probe.mjs');
  writeFileSync(
    modulePath,
    `
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useGraphSource } from '/src/useGraphSource.ts';
const records=[];
let setRequest, latest;
const host=document.createElement('div'); host.hidden=true; document.body.append(host);
const root=createRoot(host);
function Probe(){
  const [request,set]=useState({owner:'source-a',token:'fixture-source-scope-a',commit:'1'.repeat(40)});
  setRequest=set;
  const source={kind:'github',owner:request.owner,repo:'fixture',commit:request.commit};
  const result=useGraphSource(source,request.token); latest=result;
  const sha=result.state.kind==='ready'?result.state.layout.nodes[0]?.sha:null;
  records.push({owner:request.owner,scope:request.token.endsWith('-b')?'b':'a',kind:result.state.kind,graphOwner:result.repoName?.owner,sha,contextCommit:result.diagnostics?.context?.commit});
  useLayoutEffect(()=>{
    if(result.state.kind!=='ready'||!sha||!result.diagnostics)return;
    const ctrl=new AbortController();
    void result.diagnostics.changes(sha,undefined,ctrl.signal).catch(()=>{});
    return()=>ctrl.abort();
  },[result.state.kind,sha,result.diagnostics]);
  return null;
}
root.render(React.createElement(Probe));
window.__aggIdentityProbe={records,switch(owner,token,commit){setRequest({owner,token,commit});},refresh(){latest.refresh?.();},close(){root.unmount();host.remove();}};
`,
  );
}
export function cleanupWebSourceIdentity(root) {
  rmSync(resolve(root, 'apps/web/e2e/.artifacts/diagnostics/source-identity-probe.mjs'), {
    force: true,
  });
}
export async function verifyWebSourceIdentity({ page, ctx, api }) {
  const tokenA = 'fixture-source-scope-a',
    tokenB = 'fixture-source-scope-b';
  const expected = (owner, token) =>
    (owner === 'source-a' ? (token === tokenB ? '4' : '1') : token === tokenB ? '3' : '2').repeat(
      40,
    );
  const calls = [];
  const routePattern = api + '/repos/source-*/fixture**';
  await ctx.route(routePattern, async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      parts = url.pathname.split('/'),
      owner = parts[2];
    const token = (req.headers().authorization ?? '').replace(/^Bearer /, ''),
      sha = expected(owner, token);
    const commit = {
      sha,
      parents: [],
      commit: {
        message: 'identity fixture',
        author: { name: 'Fixture', date: '2026-01-01T00:00:00Z' },
      },
      author: { login: 'fixture' },
      files: [],
    };
    let body;
    if (/\/commits\/[^/]+$/.test(url.pathname)) {
      calls.push({
        owner,
        scope: token === tokenB ? 'b' : 'a',
        requested: parts.at(-1),
        expected: sha,
      });
      body = { ...commit, sha: parts.at(-1) };
    } else if (url.pathname.endsWith('/commits')) body = [commit];
    else if (url.pathname.endsWith('/branches')) body = [{ name: 'main', commit: { sha } }];
    else if (url.pathname.endsWith('/tags') || url.pathname.endsWith('/pulls')) body = [];
    else
      body = {
        name: 'fixture',
        default_branch: 'main',
        html_url: 'https://github.com/' + owner + '/fixture',
      };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  const wait = async (condition, label) => {
    const deadline = Date.now() + 15000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw Error('Timeout: ' + label);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    await page.evaluate(() => import('/e2e/.artifacts/diagnostics/source-identity-probe.mjs'));
    const ready = (owner, scope, sha) =>
      page.evaluate(
        ({ owner, scope, sha }) =>
          window.__aggIdentityProbe?.records.some(
            (r) => r.owner === owner && r.scope === scope && r.kind === 'ready' && r.sha === sha,
          ),
        { owner, scope, sha },
      );
    await wait(() => ready('source-a', 'a', expected('source-a', tokenA)), 'initial A');
    await page.evaluate(
      ({ token, sha }) => window.__aggIdentityProbe.switch('source-b', token, sha),
      { token: tokenA, sha: expected('source-b', tokenA) },
    );
    await wait(() => ready('source-b', 'a', expected('source-b', tokenA)), 'repo B');
    const repoRecords = await page.evaluate(() => window.__aggIdentityProbe.records);
    assert.deepEqual(
      repoRecords.filter((r) => r.kind === 'ready' && r.graphOwner !== r.owner),
      [],
      'repo switch must not expose even one mismatched ready render',
    );
    await page.evaluate(
      ({ token, sha }) => window.__aggIdentityProbe.switch('source-b', token, sha),
      { token: tokenB, sha: expected('source-b', tokenB) },
    );
    await wait(
      () => ready('source-b', 'b', expected('source-b', tokenB)),
      'token B without parent cache clearing',
    );
    await page.evaluate(
      ({ token, sha }) => {
        window.__aggIdentityProbe.refresh();
        window.__aggIdentityProbe.switch('source-a', token, sha);
      },
      { token: tokenB, sha: expected('source-a', tokenB) },
    );
    await wait(
      () => ready('source-a', 'b', expected('source-a', tokenB)),
      'forced refresh then repo switch',
    );
    const records = await page.evaluate(() => window.__aggIdentityProbe.records);
    const mismatches = records.filter(
      (r) =>
        r.kind === 'ready' &&
        (r.graphOwner !== r.owner ||
          r.sha !== expected(r.owner, r.scope === 'b' ? tokenB : tokenA) ||
          r.contextCommit !== r.sha),
    );
    assert.deepEqual(
      mismatches,
      [],
      'every ready render must pair the requested repo/auth scope, graph and diagnostics',
    );
    assert.deepEqual(
      calls.filter((c) => c.requested !== c.expected),
      [],
      'diagnostic requests must never use a previous source SHA',
    );
    assert(calls.length >= 2, 'probe must issue real lazy diagnostic queries');
    console.log(
      'PASS web source identity: every render, repo/token transitions, warm auth cache, forced refresh transition',
    );
  } finally {
    await page.evaluate(() => window.__aggIdentityProbe?.close()).catch(() => {});
    await ctx.unroute(routePattern);
  }
}
