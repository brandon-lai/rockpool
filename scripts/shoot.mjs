// Drives headless Chrome (WebGPU on) over the DevTools protocol: loads a URL,
// waits, optionally runs JS steps, saves screenshots and prints console
// errors. No dependencies.
//
//   node scripts/shoot.mjs <url> <out.png> [--wait 4000] [--size 1440x900]
//     [--eval "js"] [--shots 3 --every 1000]

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const wait = Number(opt('wait', 4000));
const [W, H] = opt('size', '1440x900').split('x').map(Number);
const evalJs = opt('eval', '');
const shots = Number(opt('shots', 1));
const every = Number(opt('every', 1000));
const scale = Number(opt('dpr', 1));
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9300 + Math.floor(Math.random() * 600);
const profile = mkdtempSync(join(tmpdir(), 'shoot-'));
const chrome = spawn(CHROME, ['--headless=new', '--enable-unsafe-webgpu', '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 80 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: scale, mobile: false });
await send('Page.navigate', { url });
await sleep(wait);
if (evalJs) {
  const r = await send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true });
  if (r.result?.result?.value !== undefined) console.log('eval:', JSON.stringify(r.result.result.value));
  if (r.result?.exceptionDetails) console.log('eval error:', r.result.exceptionDetails.exception?.description);
}
// --mouse "x,y;x,y;..." moves the mouse through screen fractions, one point
// per 50 ms; a point ending in "c" clicks there.
const mouse = opt('mouse', '');
if (mouse) {
  for (const step of mouse.split(';')) {
    const click = step.endsWith('c');
    const [fx, fy] = step.replace('c', '').split(',').map(Number);
    const x = fx * W;
    const y = fy * H;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    if (click) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    await sleep(50);
  }
}
for (let s = 0; s < shots; s++) {
  if (s > 0) await sleep(every);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = shots > 1 ? out.replace(/\.png$/, `-${s}.png`) : out;
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
}
console.log([...new Set(logs)].slice(0, 30).join('\n') || '(no console output)');
ws.close();
chrome.kill();
