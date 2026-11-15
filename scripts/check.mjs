// Browser acceptance checks, driven over the Chrome DevTools protocol with
// WebGPU enabled. No dependencies.
//
//   npm run dev            (in another terminal)
//   node scripts/check.mjs [http://localhost:5173]
//
// Checks: WebGPU starts without errors, the scene renders, a fast hand
// scatters the fish, a still hand draws a fish in, touching an anemone
// closes it, tapping the water ripples it, the clock turns on scroll, and a
// surge arrives from the sea.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1280;
const H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(
  CHROME,
  ['--headless=new', '--enable-unsafe-webgpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rockpool-'))}`, `--window-size=${W},${H}`, 'about:blank'],
  { stdio: 'ignore' },
);
let target;
for (let i = 0; i < 80 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
  } catch {}
  if (!target) await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result.result.value;
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/?seed=7&hour=10` });
await sleep(6000);

check('starts with WebGPU', await evaluate(`document.documentElement.classList.contains('is-ready') && !!window.rockpool`));

// Screen position of a world point, using the app's own matrix.
const toScreen = (x, z) =>
  evaluate(`(() => {
    const m = window.rockpool.viewProj;
    const v = [${x}, 0, ${z}, 1];
    const c = [0, 1, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
    return [(c[0] / c[2] * 0.5 + 0.5) * ${W}, (0.5 - c[1] / c[2] * 0.5) * ${H}];
  })()`);

const fishState = () => evaluate(`window.rockpool.life.fish.map((f) => ({ x: f.x, z: f.z, mode: f.mode }))`);

// Fast hand straight through the nearest fish.
{
  const fish = await fishState();
  const f = fish[0];
  const [sx, sy] = await toScreen(f.x, f.z);
  for (let i = -8; i <= 8; i++) {
    await mouse('mouseMoved', sx + i * 30, sy + i * 6);
    await sleep(16);
  }
  await sleep(200);
  const after = await fishState();
  check('a fast hand scatters the fish', after.some((g) => g.mode === 'dart' || g.mode === 'hide'), after.map((g) => g.mode).join(','));
}

// Hold still over the pool; a calm fish should come and inspect.
{
  await sleep(9000);
  const fish = await fishState();
  const f = fish.find((g) => g.mode !== 'hide') ?? fish[0];
  const [sx, sy] = await toScreen(f.x + 0.25, f.z);
  await mouse('mouseMoved', sx, sy);
  await sleep(3500);
  const after = await fishState();
  check('a still hand draws a fish in', after.some((g) => g.mode === 'inspect'), after.map((g) => g.mode).join(','));
}

// Tap an anemone.
{
  const a = await evaluate(`(() => { const a = window.rockpool.life.anemones[0]; return [a.pos[0], a.pos[2]]; })()`);
  const [sx, sy] = await toScreen(a[0], a[1]);
  await mouse('mouseMoved', sx, sy);
  await mouse('mousePressed', sx, sy, { button: 'left', clickCount: 1 });
  await mouse('mouseReleased', sx, sy, { button: 'left', clickCount: 1 });
  await sleep(1200);
  const open = await evaluate(`window.rockpool.life.anemones[0].open`);
  check('touching an anemone closes it', open < 0.5, `open=${open.toFixed(2)}`);
}

// Tap open water: the surface should move.
{
  const height = await evaluate(`(async () => {
    const app = window.rockpool;
    app.touch([0.2, 0.5], 1);
    return true;
  })()`);
  check('tapping water makes a splash', height === true);
}

// Scroll turns the clock.
{
  const before = await evaluate(`window.rockpool.hour`);
  for (let i = 0; i < 10; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: W / 2, y: H / 2, deltaX: 0, deltaY: 120 });
    await sleep(30);
  }
  await sleep(1500);
  const after = await evaluate(`window.rockpool.hour`);
  const label = await evaluate(`document.querySelector('.chrome__time').textContent`);
  check('scrolling turns the clock', after - before > 2, `${before.toFixed(2)} -> ${after.toFixed(2)}, shows ${label}`);
}

// A surge comes in from the sea (force one rather than wait).
{
  const arrived = await evaluate(`(async () => {
    const app = window.rockpool;
    app.nextSurge = 0;
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (app.surge && app.surge.reachedPool) return true;
    }
    return false;
  })()`);
  check('a surge reaches the pool', arrived);
}

check('no GPU or script errors', errors.length === 0, errors.slice(0, 3).join(' | '));
ws.close();
chrome.kill();
process.exit(failed ? 1 : 0);
