import { App, type HourInfo } from './app';

const root = document.documentElement;
const params = new URLSearchParams(location.search);
if (params.has('clean')) root.classList.add('is-clean');

const canvas = document.querySelector<HTMLCanvasElement>('.canvas')!;

function unsupported(reason?: unknown) {
  if (reason) console.error(reason);
  root.classList.remove('is-ready');
  root.classList.add('is-unsupported');
  const fallback = document.querySelector<HTMLElement>('.fallback');
  if (fallback) fallback.hidden = false;
}

function showHour(info: HourInfo) {
  const tide = document.querySelector('.chrome__tide');
  const time = document.querySelector('.chrome__time');
  if (tide) tide.textContent = info.tide;
  if (time) time.textContent = info.clock;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', info.background);
  root.style.setProperty('--bg', info.background);
}

async function start() {
  if (!navigator.gpu) return unsupported();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return unsupported();
  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') unsupported(info.message);
  });
  device.addEventListener('uncapturederror', (e) => console.error((e as GPUUncapturedErrorEvent).error.message));

  const context = canvas.getContext('webgpu');
  if (!context) return unsupported();
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const hourParam = Number(params.get('hour'));
  const startHour = params.has('hour') && Number.isFinite(hourParam) ? hourParam : 10;
  const seedParam = Number(params.get('seed'));
  const seed = params.has('seed') && Number.isFinite(seedParam) ? seedParam : Math.floor(Math.random() * 1e9);

  const app = new App(device, context, format, canvas, showHour, startHour);
  await app.init(seed);
  root.classList.add('is-ready');
  // tell a page embedding the pool (brandonlai.me/beta) that it's drawing, so
  // it can swap its still for the live frame; nothing else is shared
  if (window.parent !== window) window.parent.postMessage({ rockpool: 'ready' }, '*');
  Object.assign(window, { rockpool: app });

  const button = document.querySelector<HTMLButtonElement>('.chrome__sound');
  const toggle = async () => {
    const on = await app.sound.toggle();
    button?.setAttribute('aria-pressed', String(on));
    button?.setAttribute('aria-label', on ? 'Turn sound off' : 'Turn sound on');
  };
  button?.addEventListener('click', toggle);
  addEventListener('keydown', (e) => {
    if (e.key === 'm' || e.key === 'M') toggle();
  });
}

start().catch(unsupported);
