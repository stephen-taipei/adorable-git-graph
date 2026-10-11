// Exercise the actual Viewer and panel, not a hook-only substitute.
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const filename = 'viewer-scope-probe.mjs';
export function prepareViewerScope(root) {
  writeFileSync(
    resolve(root, 'apps/web/e2e/.artifacts/diagnostics', filename),
    `
import React, { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildLayout } from '@adorable/graph-core';
import { GitGraphViewer } from '/@fs/${root}/libs/graph-ui/src/viewer/GitGraphViewer.tsx';
const now=Date.now(), coverage={status:'complete',reasons:[],loaded:1,total:1};
const shas={a:'a'.repeat(40),b:'b'.repeat(40)};
const calls=[],frames=[],pending=[];
function layout(scope){return buildLayout({repo:{owner:scope,name:'fixture',defaultBranch:'main'},refs:[{name:'main',sha:shas[scope],kind:'branch',isDefault:true}],commits:[{sha:shas[scope],parents:[],message:'fixture '+scope,authorName:'Fixture',date:'2026-01-01T00:00:00Z'}],coverage:{source:'local',observedAt:now,refs:coverage,commits:coverage}});}
const layouts={a:layout('a'),b:layout('b')};
const file=(scope)=>({path:scope+'-only.txt',status:'added',additions:1,deletions:0,binary:false});
function adapter(scope,generation){return {
 changes:async(sha)=>{calls.push({scope,generation,kind:'changes',sha});return {sha,parents:[],parentSha:null,files:[file(scope)],filesCoverage:coverage,observedAt:now};},
 compare:async()=>{calls.push({scope,generation,kind:'compare'});return {base:{name:'main',sha:shas[scope]},head:{name:'main',sha:shas[scope]},mergeBase:shas[scope],ancestor:'yes',ahead:0,behind:0,headCommits:[],baseCommits:[],commitsCoverage:coverage,files:[file(scope)],filesCoverage:coverage,semantics:'merge-base-to-head',observedAt:now};},
 patch:async(base,head,path)=>{calls.push({scope,generation,kind:'patch',sha:head});const result={baseSha:base,headSha:head,path,patch:'PATCH-'+scope+'-'+generation,binary:false,coverage,observedAt:now};if(window.__aggViewerScope.deferPatch)return new Promise(resolve=>pending.push(()=>resolve({...result,patch:'LATE-'+scope})));return result;}
};}
const adapters={a:adapter('a',1),b:adapter('b',1),b2:adapter('b',2)};
const host=document.createElement('div');host.id='actual-viewer-probe';host.style.cssText='position:fixed;inset:0;z-index:2147483647;background:white';document.body.append(host);
let setScope,latest={scope:'a',generation:1};const root=createRoot(host);
function Probe(){const [value,set]=useState(latest);setScope=set;latest=value;const scope=value.scope;return React.createElement(Profiler,{id:'actual-viewer',onRender(){frames.push({scope,generation:value.generation,text:host.textContent,open:host.querySelector('.agg-diag-toggle')?.getAttribute('aria-expanded'),selected:host.querySelector('.agg-commit[data-selected="true"]')?.dataset.sha});}},React.createElement(GitGraphViewer,{title:scope+'/fixture',sourceKey:'local:'+scope,state:{kind:'ready',layout:layouts[scope]},diagnostics:value.generation===2?adapters.b2:adapters[scope],locale:'en-US',onClose(){}}));}
window.__aggViewerScope={calls,frames,shas,deferPatch:false,switch(scope,generation=1){setScope({scope,generation});},release(){pending.splice(0).forEach(resolve=>resolve());},close(){root.unmount();host.remove();}};root.render(React.createElement(Probe));
`,
  );
}
export function cleanupViewerScope(root) {
  rmSync(resolve(root, 'apps/web/e2e/.artifacts/diagnostics', filename), { force: true });
}
export async function verifyViewerScope(page) {
  const host = page.locator('#actual-viewer-probe');
  const wait = async (fn, label) => {
    const deadline = Date.now() + 15_000;
    while (!(await fn())) {
      if (Date.now() > deadline) throw Error('Timeout: ' + label);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    await page.evaluate(() => import('/e2e/.artifacts/diagnostics/viewer-scope-probe.mjs'));
    await host.locator('.agg-commit').waitFor();
    await host.locator('.agg-diag-toggle').click();
    await host.locator('.agg-commit').click();
    await host.locator('.agg-diag-files button').first().waitFor();
    await host.locator('.agg-diag-files button').first().click();
    await wait(
      () =>
        host
          .locator('.agg-diag-patch')
          .innerText()
          .then((s) => s.includes('PATCH-a')),
      'warm A patch',
    );
    await host.locator('.agg-diag-compare button').click();
    await wait(
      () =>
        host
          .locator('.agg-root')
          .innerText()
          .then((s) => s.includes('Head-only count')),
      'warm A comparison',
    );
    // Leave a provider that ignores abort pending, then synchronously replace ready A with cached ready B.
    await page.evaluate(() => {
      window.__aggViewerScope.deferPatch = true;
    });
    await host.locator('.agg-diag-files button').first().click();
    await wait(
      () =>
        page.evaluate(
          () => window.__aggViewerScope.calls.filter((c) => c.kind === 'patch').length >= 2,
        ),
      'late A started',
    );
    await page.evaluate(() => window.__aggViewerScope.switch('b'));
    await host.locator('.agg-title-text').filter({ hasText: 'b/fixture' }).waitFor();
    await page.evaluate(() => {
      window.__aggViewerScope.release();
      window.__aggViewerScope.deferPatch = false;
    });
    const switched = await page.evaluate(() => ({
      frames: window.__aggViewerScope.frames.filter((f) => f.scope === 'b'),
      calls: window.__aggViewerScope.calls.filter((c) => c.scope === 'b'),
      a: window.__aggViewerScope.shas.a,
    }));
    assert(switched.frames.length > 0);
    assert(
      switched.frames.every(
        (f) =>
          !f.text.includes('a-only.txt') &&
          !f.text.includes('PATCH-a') &&
          !f.text.includes('LATE-a') &&
          !f.text.includes(switched.a),
      ),
      'every committed cached-B frame must isolate A results and SHA',
    );
    assert(
      switched.calls.every((c) => c.sha !== switched.a),
      'new B adapter must never receive A selection',
    );
    assert.equal(
      await host.locator('.agg-diag-toggle').getAttribute('aria-expanded'),
      'true',
      'open diagnostics survives source changes',
    );
    await host.locator('.agg-commit').click();
    await host.locator('.agg-diag-files button').first().waitFor();
    await host.locator('.agg-diag-files button').first().click();
    await wait(
      () =>
        host
          .locator('.agg-diag-patch')
          .innerText()
          .then((s) => s.includes('PATCH-b-1')),
      'warm B patch',
    );
    await host.locator('.agg-diag-compare input[aria-label="Base"]').fill('manual-base');
    await page.evaluate(() => window.__aggViewerScope.switch('b', 2));
    await wait(
      () => page.evaluate(() => window.__aggViewerScope.frames.some((f) => f.generation === 2)),
      'same repo adapter rotation',
    );
    const rotated = await page.evaluate(() => ({
      frames: window.__aggViewerScope.frames.filter((f) => f.generation === 2),
      calls: window.__aggViewerScope.calls.filter((c) => c.generation === 2),
    }));
    assert(
      rotated.frames.every(
        (f) => !f.text.includes('PATCH-b-1') && !f.text.includes('b-only.txt') && !f.selected,
      ),
      'first rotation frame cannot expose old selection or diagnostic results',
    );
    assert.deepEqual(
      rotated.calls,
      [],
      'same-repo new adapter must await a new explicit selection/query',
    );
    assert.equal(
      await host.locator('.agg-diag-compare input[aria-label="Base"]').inputValue(),
      'main',
    );
    assert.equal(await host.locator('.agg-diag-toggle').getAttribute('aria-expanded'), 'true');
    console.log(
      'PASS actual Viewer: cached A to B first committed frame, query isolation, late response, adapter rotation, open panel',
    );
  } finally {
    await page.evaluate(() => window.__aggViewerScope?.close()).catch(() => {});
  }
}
