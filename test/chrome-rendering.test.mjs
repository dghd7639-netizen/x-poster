import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { Page } from '../server/chrome.mjs';

async function renderingFixture(t, { rates = [60], visibility = 'visible', error, evaluateError = false, hang = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const calls = [];
  let measurement = 0;
  const page = new Page({
    async send(method, params, session, timeout) {
      calls.push({ method, params, session, timeout });
      if (hang) return new Promise(() => {});
      if (method !== 'Runtime.evaluate') {
        if (error) throw new Error('private CDP details');
        return {};
      }
      if (evaluateError) throw new Error('Execution context was destroyed');
      const fps = rates[Math.min(measurement++, rates.length - 1)];
      let nextFrame = Date.now() + 500 / fps;
      const value = await runInNewContext(params.expression, {
        document: { visibilityState: visibility }, setTimeout, clearTimeout,
        requestAnimationFrame: callback => {
          if (!fps) return 0;
          const wait = nextFrame - Date.now();
          nextFrame += 1000 / fps;
          return setTimeout(callback, wait);
        },
        cancelAnimationFrame: clearTimeout,
      });
      return { result: { value } };
    },
  }, 'target', 'session');
  let outcome;
  page.ensureRendering().then(value => { outcome = { value }; }, error => { outcome = { error }; });
  for (let elapsed = 0; !outcome && elapsed <= 6100; elapsed += 10) {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    if (!outcome) t.mock.timers.tick(10);
  }
  assert.ok(outcome, 'rendering recovery must settle within 6.1 seconds');
  if (outcome.error) throw outcome.error;
  assert.equal(page.rendering, outcome.value);
  return { result: outcome.value, calls, elapsed: Date.now() - 1000,
    remedies: calls.filter(call => call.method !== 'Runtime.evaluate').map(call => call.method) };
}

test('ensureRendering leaves a healthy 60 fps page and its focus untouched', async t => {
  const f = await renderingFixture(t);
  assert.equal(f.result.stalled, false);
  assert.equal(f.result.frames, 30);
  assert.equal(f.result.remedy, null);
  assert.deepEqual(f.remedies, []);
  assert.equal(f.calls.length, 1);
});

test('ensureRendering recovers with focus emulation before considering foreground', async t => {
  const f = await renderingFixture(t, { rates: [0, 60], visibility: 'hidden' });
  assert.equal(f.result.stalled, false);
  assert.equal(f.result.initial_frames, 0);
  assert.equal(f.result.final_frames, 30);
  assert.equal(f.result.remedy, 'focus_emulation');
  assert.equal(f.result.visibility, 'hidden');
  assert.deepEqual(f.remedies, ['Emulation.setFocusEmulationEnabled']);
  assert.deepEqual(f.calls[1].params, { enabled: true });
  assert.equal(f.calls[1].session, 'session');
});

test('ensureRendering brings the page forward only if focus emulation did not recover frames', async t => {
  const f = await renderingFixture(t, { rates: [0, 0, 60] });
  assert.equal(f.result.stalled, false);
  assert.equal(f.result.remedy, 'bring_to_front');
  assert.deepEqual(f.remedies, ['Emulation.setFocusEmulationEnabled', 'Page.bringToFront']);
});

test('ensureRendering reports a page that never draws without throwing', async t => {
  const f = await renderingFixture(t, { rates: [0], visibility: 'hidden' });
  assert.equal(f.result.stalled, true);
  assert.equal(f.result.final_frames, 0);
  assert.equal(f.result.remedy, 'bring_to_front');
  assert.ok(f.elapsed <= 6000);
});

test('ensureRendering bounds even hanging evaluations and remedies with fake timers', async t => {
  const f = await renderingFixture(t, { hang: true });
  assert.equal(f.result.stalled, true);
  assert.equal(f.result.initial_frames, null);
  assert.equal(f.result.final_frames, null);
  assert.equal(f.result.remedy, 'bring_to_front');
  assert.ok(f.elapsed <= 6000);
  assert.ok(f.calls.every(call => call.timeout > 0 && call.timeout <= 1500));
});

test('ensureRendering tolerates CDP errors during remedies', async t => {
  const f = await renderingFixture(t, { rates: [0], error: true });
  assert.equal(f.result.stalled, true);
  assert.equal(f.result.remedy, 'bring_to_front');
  assert.deepEqual(f.remedies, ['Emulation.setFocusEmulationEnabled', 'Page.bringToFront']);
  assert.doesNotMatch(JSON.stringify(f.result), /private/);
});

test('ensureRendering treats failed navigation contexts as unknown measurements without throwing', async t => {
  const f = await renderingFixture(t, { evaluateError: true });
  assert.equal(f.result.stalled, true);
  assert.equal(f.result.initial_frames, null);
  assert.equal(f.result.final_frames, null);
  assert.equal(f.result.visibility, null);
  assert.deepEqual(f.remedies, ['Emulation.setFocusEmulationEnabled', 'Page.bringToFront']);
});

test('ensureRendering leaves a hidden page alone when frames are healthy', async t => {
  const f = await renderingFixture(t, { visibility: 'hidden' });
  assert.equal(f.result.stalled, false);
  assert.equal(f.result.visibility, 'hidden');
  assert.deepEqual(f.remedies, []);
});

for (const [fps, stalled] of [[4, true], [6, false]]) {
  test(`ensureRendering uses fewer than 5 fps as its threshold: ${fps} fps`, async t => {
    const f = await renderingFixture(t, { rates: [fps] });
    assert.equal(f.result.stalled, stalled);
    assert.equal(f.result.initial_frames, fps / 2);
    assert.equal(f.remedies.length, stalled ? 2 : 0);
  });
}
