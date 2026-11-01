// Records marketing videos of the real interface. Nothing is generated: it is
// the actual app, driven by a storyboard and rendered frame by frame on a
// virtual clock (see vtime-preload.cjs), so there are no dropped frames and
// every frame is supersampled before it is encoded.
//
//   STORY=reel    FFMPEG=$(which ffmpeg) npx electron scripts/record.cjs marketing/reel.mp4
//   STORY=trailer FFMPEG=$(which ffmpeg) npx electron scripts/record.cjs marketing/trailer.mp4
//
// Needs a running floor (agent-floor start). Uses the in-browser demo agents.
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

process.on('uncaughtException', (e) => console.error('[record] uncaught', e));

const STORY = process.env.STORY || 'trailer';
const FORMATS = {
  // CSS size, render scale, delivery size. The render size is also kept as a master.
  reel: { cssW: 540, cssH: 960, scale: 4, outW: 1080, outH: 1920 },
  trailer: { cssW: 1920, cssH: 1080, scale: 2, outW: 1920, outH: 1080 },
};
const F = FORMATS[STORY];
if (!F) throw new Error(`Unknown STORY ${STORY}`);
// SCALE=2 (reel) or SCALE=1 (trailer) renders at delivery size with no supersampling:
// much faster on machines without a GPU, slightly softer edges.
if (process.env.SCALE) F.scale = Number(process.env.SCALE);
const FPS = Number(process.env.FPS) || 60;
const RW = F.cssW * F.scale;
const RH = F.cssH * F.scale;
const out = path.resolve(process.argv[2] || `marketing/${STORY}.mp4`);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const PORT = Number(process.env.AGENT_FLOOR_PORT) || 4317;

app.commandLine.appendSwitch('disable-renderer-backgrounding');

// ------------------------------------------------------------------ overlay

const OVERLAY_CSS = `
  .stats, .demo-note, .hint, .mode { display: none !important; }
  #rec { position: fixed; inset: 0; z-index: 50; pointer-events: none; font-family: 'Geist Variable', system-ui, sans-serif; }
  #rec .rc {
    position: absolute; inset: 0; display: grid; place-items: center; text-align: center;
    background: radial-gradient(ellipse at center, rgba(12,15,20,0.55), rgba(12,15,20,0.84));
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    color: #f4f6f8; opacity: 0; transition: opacity 550ms ease;
  }
  #rec .rc.on { opacity: 1; }
  #rec .rc .inner { padding: 0 24px; transform: translateY(14px) scale(0.985); transition: transform 900ms cubic-bezier(0.22,1,0.36,1); }
  #rec .rc.on .inner { transform: none; }
  #rec .mark { display: inline-grid; grid-template-columns: 34px 34px; gap: 7px; margin-bottom: 34px; }
  #rec .mark i { width: 34px; height: 34px; border-radius: 10px; background: #8a94a6; }
  #rec .mark i:first-child { background: #ff5f2e; }
  #rec h1 { margin: 0; font-size: min(112px, 13vw); line-height: 1.02; letter-spacing: -0.035em; font-weight: 750; }
  #rec .sub { margin-top: 18px; font-size: min(34px, 4.8vw); color: rgba(244,246,248,0.74); letter-spacing: -0.01em; font-weight: 500; line-height: 1.3; }
  #rec .cmd {
    display: inline-block; margin-top: 40px; padding: 18px 30px; border-radius: 999px;
    background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.16);
    font: 600 min(32px, 4.6vw)/1 'Geist Mono Variable', ui-monospace, monospace; color: #fff;
  }
  #rec .url { margin-top: 20px; font: 500 min(24px, 3.2vw)/1 'Geist Mono Variable', ui-monospace, monospace; color: rgba(244,246,248,0.6); }
  #rec .cap {
    position: absolute; left: 50%; bottom: 120px; transform: translate(-50%, 16px);
    padding: 22px 34px; border-radius: 26px; max-width: 1200px; text-align: center;
    background: rgba(255,255,255,0.9); color: #141821;
    backdrop-filter: blur(16px) saturate(160%); -webkit-backdrop-filter: blur(16px) saturate(160%);
    border: 1px solid rgba(255,255,255,0.8);
    box-shadow: 0 1px 0 rgba(255,255,255,0.6) inset, 0 24px 60px -18px rgba(20,28,44,0.45);
    font-size: 40px; font-weight: 680; letter-spacing: -0.02em; line-height: 1.15;
    opacity: 0; transition: opacity 320ms ease, transform 520ms cubic-bezier(0.22,1,0.36,1);
  }
  #rec .cap.on { opacity: 1; transform: translate(-50%, 0); }
  #rec .cap small { display: block; margin-top: 8px; font-size: 24px; font-weight: 500; color: #586172; letter-spacing: -0.005em; }
  :root[data-theme='dark'] #rec .cap { background: rgba(26,30,38,0.9); color: #eef1f5; border-color: rgba(255,255,255,0.1); }
  :root[data-theme='dark'] #rec .cap small { color: #a3acbb; }
  @media (orientation: portrait) {
    /* Reels / TikTok / Shorts safe zone, in CSS px of a 540x960 frame:
       top 150 (header + 4:5 feed crop), bottom 190 (caption, audio),
       right 70 (like / comment buttons), left 30. */
    .topbar, .teams, .hint { display: none !important; }
    #rec .cap { bottom: auto; top: 168px; left: 30px; right: 70px; width: auto; max-width: none; transform: translateY(-12px);
      padding: 14px 16px; border-radius: 18px; font-size: 22px; }
    #rec .cap.on { transform: none; }
    #rec .rc .inner { max-width: 400px; margin-right: 40px; }
    #rec h1 { font-size: 62px; }
    #rec .sub { font-size: 19px; }
    /* The agent card: compact, centred in the safe area, above the caption zone. */
    .card { left: 30px !important; right: 70px !important; top: auto !important; bottom: 196px !important;
      max-height: 232px !important; width: auto !important; padding: 12px !important; font-size: 13px; }
    .card .history li:nth-child(n+3) { display: none; } .card .links { display: none; }
    #rec .cap small { font-size: 14px; margin-top: 5px; }
    #rec .mark { grid-template-columns: 20px 20px; gap: 5px; margin-bottom: 20px; }
    #rec .mark i { width: 20px; height: 20px; border-radius: 6px; }
    #rec .cmd { padding: 11px 18px; margin-top: 24px; font-size: 17px; }
    #rec .url { font-size: 12px; }
    /* Replay bar: inside the safe area, just above the caption/audio zone. */
    .timeline { left: 30px !important; right: 70px !important; width: auto !important; bottom: 196px !important;
      transform: none !important; }
  }
`;

const card = (id, sub, extra = '') => `
  <div class="rc" id="${id}"><div class="inner">
    <div class="mark"><i></i><i></i><i></i><i></i></div>
    <h1>Agent Floor</h1>
    <div class="sub">${sub}</div>${extra}
  </div></div>`;

// ------------------------------------------------------------------ storyboards
// Each beat runs when the video clock reaches `at` seconds. The string runs in the page.

const say = (text, sub = '') =>
  `(() => { const c = document.getElementById('cap'); c.classList.remove('on'); setTimeout(() => { c.innerHTML = ${JSON.stringify(text)} + (${JSON.stringify(sub)} ? '<small>' + ${JSON.stringify(sub)} + '</small>' : ''); c.classList.add('on'); }, ${text ? 300 : 0}); })()`;
const hush = `document.getElementById('cap').classList.remove('on')`;
const ev = (o) => `__store.applyLocal(Object.assign(${JSON.stringify(o)}, { ts: Date.now() }))`;
const on = (id) => `document.getElementById('${id}').classList.add('on')`;
// Shown instantly (no fade) for the very first frame.
const show = (id) =>
  `(() => { const c = document.getElementById('${id}'); const els = [c, c.querySelector('.inner')]; els.forEach(e => e.style.transition = 'none'); c.classList.add('on'); c.offsetWidth; els.forEach(e => e.style.transition = ''); })()`;
const off = (id) => `document.getElementById('${id}').classList.remove('on')`;
const night = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))`;
// Rewind to the start of the recording and play it back at `speed`; it returns to live by itself.
const rewind = (speed) => `(() => { __store.select(null); __store.startReplay(${speed}); __floor.frameAll(); })()`;
const betweenOffices = (dx, dy, dz) =>
  `(() => { __store.select(null); const a = __floor.rooms.get('checkout-redesign').center, b = __floor.rooms.get('auth-service').center; const t = a.clone().add(b).multiplyScalar(0.5); t.y = 0.8; const p = t.clone(); p.x += ${dx}; p.y += ${dy}; p.z += ${dz}; __floor.flyTo(t, p, null); })()`;
const outro = (sub) =>
  card('outro', sub, '<div class="cmd">npm i -g agent-floor</div><div class="url">github.com/Yomane3009/agent-floor</div>');

const STORIES = {
  // 25 seconds, vertical, fast cuts.
  reel: {
    warmup: 9,
    length: 25,
    overlay: card('title', 'Watch your AI agents work.') + '<div class="cap" id="cap"></div>' + outro('Open source. Works with Claude Code, Codex and Cursor.'),
    beats: [
      [0, show('title')],
      [1.5, off('title')],
      [1.6, ev({ type: 'join', agent: 'nova', name: 'Nova', role: 'Lead', team: 'Payments', status: 'thinking', activity: 'Reading the brief' })],
      [1.9, say('Every agent gets a character and a desk.')],
      [2.2, ev({ type: 'join', agent: 'flux', name: 'Flux', role: 'Backend', parent: 'nova', team: 'Payments', status: 'thinking', activity: 'Getting briefed', text: 'Take the refunds API' })],
      [2.8, ev({ type: 'join', agent: 'iris', name: 'Iris', role: 'Tests', parent: 'nova', team: 'Payments', status: 'thinking', activity: 'Getting briefed', text: 'Cover partial refunds' })],
      [5.4, `__floor.focusTeam('checkout-redesign')`],
      [5.5, say('Every team gets its own office.')],
      [6.4, ev({ type: 'message', agent: 'atlas', to: 'probe', text: 'Cover the declined-card path' })],
      [9.0, `__floor.focusAgent('ledger')`],
      [9.0, ev({ type: 'tool', agent: 'ledger', tool: 'Edit', activity: 'Editing orders/service.py' })],
      [9.1, say('See exactly what each one is doing.')],
      [12.6, ev({ type: 'tool', agent: 'pixel', tool: 'Edit', activity: 'Editing CheckoutForm.tsx' })],
      [12.6, `__store.select('pixel')`],
      [12.7, say('Tap anyone for live status.')],
      [15.4, betweenOffices(2, 24, 13)],
      [15.5, say('Watch work fly between teams.')],
      [15.9, ev({ type: 'message', agent: 'relay', to: 'ledger', text: 'New token format is live' })],
      [16.6, ev({ type: 'message', agent: 'warden', to: 'atlas', text: 'Auth is ready for checkout' })],
      [17.3, ev({ type: 'message', agent: 'ledger', to: 'cipher', text: 'Thanks, wiring it up' })],
      [18.2, rewind(10)],
      [18.3, say('Missed something? Rewind it.')],
      [21.2, `${night}; __store.stopReplay(); __floor.focusTeam('checkout-redesign')`],
      [21.3, say('Day shift. Night shift.')],
      [21.9, `__floor.controls.autoRotate = true; __floor.controls.autoRotateSpeed = 1.4`],
      [22.6, hush],
      [22.7, on('outro')],
    ],
  },

  // 81 seconds, landscape, the full walkthrough.
  trailer: {
    warmup: 0.5,
    length: 80.7,
    overlay: card('title', 'A live 3D office for your coding agents') + '<div class="cap" id="cap"></div>' + outro('Open source. Runs on your machine.'),
    beats: [
      [0, show('title')],
      [4.2, off('title')],
      [5.2, say('Every coding agent gets a character and a desk.', 'They walk in the moment a session starts.')],
      [12.7, `__floor.focusTeam('checkout-redesign')`],
      [12.7, say('Each team works in its own office.', 'Helpers get briefed with a paper plane and report back the same way.')],
      [20.7, `__floor.focusAgent('ledger')`],
      [20.7, ev({ type: 'tool', agent: 'ledger', tool: 'Edit', activity: 'Editing orders/service.py' })],
      [20.7, say('Their screens show exactly what they are doing.', 'Every tool call, live: edits, tests, searches, shell commands.')],
      [27.7, ev({ type: 'tool', agent: 'pixel', tool: 'Edit', activity: 'Editing CheckoutForm.tsx' })],
      [27.7, `__store.select('pixel')`],
      [27.7, say('Click anyone for live status and history.')],
      [34.7, betweenOffices(9, 17, 15)],
      [34.7, say('Watch work move between teams.', 'Messages fly as paper planes, coloured by the sender’s team.')],
      [35.9, ev({ type: 'message', agent: 'relay', to: 'ledger', text: 'New token format is live' })],
      [38.1, ev({ type: 'message', agent: 'ledger', to: 'probe', text: 'Price includes tax now' })],
      [40.3, ev({ type: 'message', agent: 'warden', to: 'atlas', text: 'Auth is ready for checkout' })],
      [42.9, `__floor.focusTeam('auth-service')`],
      [42.9, ev({ type: 'status', agent: 'warden', status: 'waiting', activity: 'Needs your approval to push' })],
      [42.9, say('And they raise a hand when they need you.')],
      [49.9, rewind(8)],
      [49.9, say('Missed something? Press R to rewind.', 'Replay the last 30 minutes, paper planes and all. Drag to jump to any moment.')],
      [56.9, `${night}; __store.stopReplay(); __floor.frameAll()`],
      [56.9, say('Day shift. Night shift.', 'Desk lamps and monitors glow after dark.')],
      [60.4, `__floor.controls.autoRotate = true; __floor.controls.autoRotateSpeed = 0.6`],
      [64.4, `__floor.controls.autoRotate = false`],
      [64.4, `${hush}; __hud.openSheet()`],
      [64.4, say('Works with Claude Code, Codex, Cursor, or anything that speaks HTTP.')],
      [67.0, `document.querySelector('.tab[data-tab="codex"]').click()`],
      [69.2, `document.querySelector('.tab[data-tab="cursor"]').click()`],
      [71.4, `document.querySelector('.tab[data-tab="http"]').click()`],
      [73.6, `${hush}; __hud.closeSheet()`],
      [74.2, on('outro')],
    ],
  },
};

// ------------------------------------------------------------------ recording

app.whenReady().then(async () => {
  const story = STORIES[STORY];
  nativeTheme.themeSource = 'light';
  fs.mkdirSync(path.dirname(out), { recursive: true });

  // Off-screen windows ignore the display scale factor, so render at full size and
  // zoom the page: the layout sees a cssW x cssH screen, every device pixel is real.
  const win = new BrowserWindow({
    width: RW,
    height: RH,
    enableLargerThanScreen: true,
    show: false,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      partition: `rec-${Date.now()}`,
      zoomFactor: F.scale,
      // The virtual clock has to replace the page's own timers.
      preload: path.join(__dirname, 'vtime-preload.cjs'),
      contextIsolation: false,
      sandbox: false,
    },
  });
  win.webContents.setFrameRate(60);

  // Every frame carries a marker: a 2x2 CSS-px block in the top-left corner whose
  // colour encodes the frame number. A capture is accepted only when the marker
  // matches, so a stale frame can never be encoded. The marker is painted over
  // with its neighbours before encoding.
  let waiter = null;
  win.webContents.on('paint', (_e, _dirty, image) => {
    if (waiter) waiter(image);
  });
  const markerOf = (image) => {
    const px = image.crop({ x: F.scale, y: F.scale, width: 1, height: 1 }).toBitmap(); // BGRA
    return { r: px[2], g: px[1] };
  };
  const want = (n) => ({ r: (n % 64) * 4 + 2, g: (Math.floor(n / 64) % 64) * 4 + 2 });
  const captureFrame = (n) =>
    new Promise((resolve, reject) => {
      const goal = want(n);
      const timer = setTimeout(() => reject(new Error(`frame ${n} never painted`)), 60000);
      waiter = (image) => {
        const m = markerOf(image);
        if (Math.abs(m.r - goal.r) <= 1 && Math.abs(m.g - goal.g) <= 1) {
          waiter = null;
          clearTimeout(timer);
          resolve(image);
        } else {
          if (process.env.DEBUG_MARKER) console.log('[record] marker', n, 'want', goal, 'got', m, image.getSize());
          win.webContents.invalidate();
        }
      };
      win.webContents.invalidate();
    });
  const MARK = 2 * F.scale; // marker size in device pixels
  const hideMarker = (buf) => {
    // Copy the pixels just right of the marker over it, row by row.
    for (let y = 0; y < MARK; y++) {
      const row = y * RW * 4;
      buf.copy(buf, row, row + MARK * 4, row + MARK * 8);
    }
    return buf;
  };

  // One pass, two files: the delivery cut (Lanczos-downscaled, supersampled) and,
  // when the render is bigger, a full-resolution master.
  const master = out.replace(/\.mp4$/, '-master.mp4');
  const x264 = ['-c:v', 'libx264', '-tune', 'animation', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  const hasMaster = RW > F.outW;
  // SNAP=2.5,11,14: render the timeline but only save stills at those times (layout checks).
  const SNAP = (process.env.SNAP || '').split(',').filter(Boolean).map(Number);
  const ff = SNAP.length ? null : spawn(FFMPEG, [
    '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${RW}x${RH}`, '-r', String(FPS), '-i', '-',
    '-filter_complex', hasMaster ? `[0:v]split=2[m][d];[d]scale=${F.outW}:${F.outH}:flags=lanczos[o]` : `[0:v]scale=${F.outW}:${F.outH}:flags=lanczos[o]`,
    '-map', '[o]', ...x264, '-preset', 'veryslow', '-crf', '10', out,
    ...(hasMaster ? ['-map', '[m]', ...x264, '-preset', 'slow', '-crf', '14', master] : []),
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff?.stderr.on('data', (d) => (ffErr = (ffErr + d).slice(-2000)));
  const done = ff ? new Promise((r) => ff.on('close', r)) : Promise.resolve(0);
  const write = (buf) => new Promise((r) => (ff.stdin.write(buf) ? r() : ff.stdin.once('drain', r)));

  await win.loadURL(`http://127.0.0.1:${PORT}/?demo&stats&rec`);
  const js = (code) => win.webContents.executeJavaScript(code);
  await win.webContents.insertCSS(OVERLAY_CSS);
  await js(`(() => { const d = document.createElement('div'); d.id = 'rec'; d.innerHTML = ${JSON.stringify(story.overlay)}; document.body.append(d);
    const m = document.createElement('div'); m.id = 'frame-marker';
    m.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;z-index:2147483647;pointer-events:none;background:rgb(2,2,2)';
    document.body.append(m); })()`);

  // Let the demo settle (agents walk in and sit down) before the video starts.
  if (STORY === 'reel') await js(`__floor.safeArea = { x: 0.8, y: 0.6 }`);
  const dt = 1000 / FPS;
  const beats = [...story.beats];
  const warm = Math.round(story.warmup * FPS);
  for (let i = 0; i < warm; i++) {
    // Beats at t=0 (the title card) go in a few frames early so frame 0 already shows them.
    if (i === warm - 3) while (beats.length && beats[0][0] <= 0) await js(beats.shift()[1]);
    await js(`__vt.step(${dt})`);
  }

  const frames = Math.round((Number(process.env.SECONDS) || story.length) * FPS);
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    while (beats.length && beats[0][0] <= t + 1e-6) await js(beats.shift()[1]);
    const g = want(f);
    await js(`__vt.step(${dt}); document.getElementById('frame-marker').style.background = 'rgb(${g.r},${g.g},2)'`);
    if (SNAP.length) {
      const hit = SNAP.find((s) => Math.round(s * FPS) === f);
      if (hit === undefined) continue;
      const still = await captureFrame(f);
      const file = out.replace(/\.mp4$/, `-${hit}s.png`);
      fs.writeFileSync(file, still.resize({ width: F.outW, height: F.outH, quality: 'best' }).toPNG());
      console.log('[record] still', file);
      continue;
    }
    const image = await captureFrame(f);
    const size = image.getSize();
    if (size.width !== RW || size.height !== RH) throw new Error(`paint is ${size.width}x${size.height}, expected ${RW}x${RH}`);
    await write(hideMarker(image.toBitmap()));
    if (f % (FPS * 5) === 0) console.log(`[record] ${STORY} ${t.toFixed(1)}s / ${story.length}s`);
  }

  ff?.stdin.end();
  const code = await done;
  if (code !== 0) console.error(ffErr);
  console.log(`[record] wrote ${frames} frames (${story.length}s at ${FPS} fps) to ${out}${hasMaster ? ` and ${master}` : ''}`);
  app.quit();
});
