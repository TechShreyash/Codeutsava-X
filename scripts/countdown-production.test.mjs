import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync } from 'node:fs';

const ceremonyPath = '/' + readdirSync(new URL('../src/app/', import.meta.url)).find((name) => name.startsWith('launch-'));

const base = new URL(process.env.COUNTDOWN_PREVIEW_URL ?? 'http://localhost:3000');
if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Production preview tests require localhost.');
const read = async () => {
  const response = await fetch(new URL('/api/countdown', base));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
};

test('release serves assets and matches legacy row creation, duplicate detection and deletion reset', async (t) => {
  const marker = await fetch(new URL('/_preview/status', base));
  assert.equal(marker.status, 200);
  assert.equal((await marker.json()).mode, 'isolated-production-preview', 'Never write unless the isolated preview identifies itself.');
  const deleteCounters = () => fetch(new URL('/_preview/delete-counters', base), { method: 'POST' });
  assert.equal((await deleteCounters()).status, 200);
  t.after(async () => { assert.equal((await deleteCounters()).status, 200); });
  const page = await fetch(new URL('/timer?demo=1', base));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('https://codeutsava.nitrr.ac.in/timer'));
  assert.ok(!html.includes('RESET DEMO'));
  assert.ok(!html.includes('Local rehearsal ·'));
  assert.ok(!html.includes('BACK TO CODEUTSAVA'));
  assert.ok(!html.includes('OPEN LOCAL REHEARSAL'));
  const ceremony = await fetch(new URL(ceremonyPath, base));
  assert.equal(ceremony.status, 200);
  const ceremonyHtml = await ceremony.text();
  assert.match(ceremonyHtml, /name="robots" content="[^\"]*noindex[^\"]*nofollow/);
  assert.ok(ceremonyHtml.includes('name="referrer" content="no-referrer"'));
  const sitemap = await (await fetch(new URL('/sitemap.xml', base))).text();
  assert.ok(!sitemap.includes(ceremonyPath));
  const homepage = await fetch(new URL('/', base));
  assert.equal(homepage.status, 200);
  const homeHtml = await homepage.text();
  assert.ok(!homeHtml.includes('href="/timer"'));
  assert.ok(!homeHtml.includes('Hackathon countdown'));
  assert.ok(!homeHtml.includes(ceremonyPath));
  const css = html.match(/href="([^\"]+\.css(?:\?[^\"]*)?)"/);
  assert.ok(css, 'Release has a stylesheet.');
  assert.equal((await fetch(new URL(css[1].replaceAll('&amp;', '&'), base))).status, 200);
  assert.equal((await fetch(new URL('/favicon.svg', base))).status, 200);
  for (const method of ['GET', 'POST']) {
    assert.equal((await fetch(new URL('/api/countdown/demo', base), { method })).status, 404);
  }
  const ready = await read();
  assert.equal(ready.counter.flag, false);
  const startTime = ready.serverTime;
  const payload = { flag: true, startTime, endTime: startTime + 28 * 3600000 };
  const start = (counter) => fetch(new URL('/server/setcounter/', base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(counter),
  });
  const firstStart = await start(payload);
  assert.equal(firstStart.status, 200);
  assert.deepEqual(await firstStart.json(), {}, 'Legacy POST returns an empty object after inserting.');
  const rawRead = async () => (await (await fetch(new URL('/server/getcounter/', base))).json()).data;
  assert.deepEqual(await rawRead(), [payload]);
  assert.deepEqual((await read()).counter, payload);
  assert.deepEqual((await read()).counter, payload);
  const reset = await fetch(new URL('/_preview/reset-flag', base), { method: 'POST' });
  assert.equal(reset.status, 200);
  assert.deepEqual((await reset.json()).data[0], { ...payload, flag: false }, 'Unchecking Flag retains the row and timestamps.');
  const initial = await read();
  assert.deepEqual(initial.counter, { flag: false, startTime: 0, endTime: 0 });
  const restartedAt = Math.max(Date.now(), payload.startTime + 1);
  const restarted = { flag: true, startTime: restartedAt, endTime: restartedAt + 28 * 3600000 };
  assert.equal((await start(restarted)).status, 200);
  assert.deepEqual(await rawRead(), [{ ...payload, flag: false }, restarted], 'Flag-only reset followed by Start appends a second row.');
  const duplicates = await fetch(new URL('/api/countdown', base));
  assert.equal(duplicates.status, 409);
  assert.equal(duplicates.headers.get('cache-control'), 'no-store');
  assert.match((await duplicates.json()).error, /Multiple counter records/);
  assert.equal((await deleteCounters()).status, 200);
  assert.deepEqual(await rawRead(), { flag: false, startTime: 0, endTime: 0 });
  assert.deepEqual((await read()).counter, { flag: false, startTime: 0, endTime: 0 });
  assert.equal((await start(restarted)).status, 200);
  assert.deepEqual(await rawRead(), [restarted], 'Deletion reset followed by Start leaves exactly one fresh row.');
  assert.deepEqual((await read()).counter, restarted);
  assert.equal((await fetch(new URL('/', base))).status, 200);
});
