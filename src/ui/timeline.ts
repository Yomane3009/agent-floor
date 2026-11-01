import { store, type LogEntry } from '../core/store';
import { icon } from './icons';

const SPEEDS = [1, 4, 16];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function clock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function behind(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')} ago`;
}

/** What a tick on the track means, so the eye can find the interesting moments. */
function tickKind(e: LogEntry): 'message' | 'attention' | 'join' | 'leave' | 'plain' {
  const ev = e.event;
  if (!ev) return 'leave';
  if (ev.type === 'message' || (ev.type === 'join' && ev.parent)) return 'message';
  if (ev.status === 'waiting' || ev.status === 'error') return 'attention';
  if (ev.type === 'join') return 'join';
  if (ev.type === 'leave') return 'leave';
  return 'plain';
}

/**
 * Replay: scrub back through everything the floor has seen since it opened
 * (up to 30 minutes), or play it back fast with the paper planes flying again.
 */
export class Timeline {
  private root = el('div', 'timeline glass');
  private playBtn = el('button', 'icon-btn', icon('pause')) as HTMLButtonElement;
  private speedBtn = el('button', 'speed', '4×') as HTMLButtonElement;
  private track = el('div', 'track');
  private canvas = el('canvas');
  private fill = el('div', 'fill');
  private head = el('div', 'head');
  private label = el('div', 'when');
  private liveBtn = el('button', 'live-btn', `${icon('broadcast')}<span>Live</span>`) as HTMLButtonElement;
  private dragging = false;
  private wasPlaying = false;
  private last = 0;
  private drawnKey = '';
  private pendingSeek: number | null = null;

  constructor(container: HTMLElement) {
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Replay');
    for (const b of [this.playBtn, this.speedBtn, this.liveBtn]) b.type = 'button';
    this.playBtn.setAttribute('aria-label', 'Play or pause (Space)');
    this.playBtn.title = 'Play or pause (Space)';
    this.speedBtn.title = 'Playback speed';
    this.liveBtn.title = 'Back to live (R)';
    this.track.setAttribute('role', 'slider');
    this.track.setAttribute('aria-label', 'Replay position');
    this.track.tabIndex = 0;
    this.track.append(this.canvas, this.fill, this.head);
    this.root.append(this.playBtn, this.speedBtn, this.track, this.label, this.liveBtn);
    container.append(this.root);

    this.playBtn.addEventListener('click', () => store.setPlaying(!store.replay?.playing));
    this.speedBtn.addEventListener('click', () => {
      const s = store.replay?.speed ?? 4;
      store.setSpeed(SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]);
    });
    this.liveBtn.addEventListener('click', () => store.stopReplay());
    this.bindTrack();
    this.bindKeys();
    store.subscribe(() => this.render());
    new ResizeObserver(() => (this.drawnKey = '')).observe(this.track);
    requestAnimationFrame(this.tick);
  }

  toggle() {
    if (store.replay) store.stopReplay();
    else store.startReplay();
  }

  // ---------------------------------------------------------------- playback

  private tick = (now: number) => {
    const dt = this.last ? Math.min(now - this.last, 100) : 0;
    this.last = now;
    const r = store.replay;
    if (r) {
      if (this.pendingSeek != null) {
        store.seek(this.pendingSeek);
        this.pendingSeek = null;
      } else if (r.playing && !this.dragging) {
        store.advance(r.t + dt * r.speed);
      } else {
        // Paused: the live edge keeps moving, so keep the track honest.
        this.render();
      }
    }
    requestAnimationFrame(this.tick);
  };

  // ---------------------------------------------------------------- input

  private timeAt(clientX: number) {
    const box = this.track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return store.start + f * (Date.now() - store.start);
  }

  private bindTrack() {
    this.track.addEventListener('pointerdown', (e) => {
      if (!store.replay) return;
      this.dragging = true;
      this.wasPlaying = store.replay.playing;
      this.track.setPointerCapture(e.pointerId);
      this.pendingSeek = this.timeAt(e.clientX);
    });
    this.track.addEventListener('pointermove', (e) => {
      if (this.dragging) this.pendingSeek = this.timeAt(e.clientX);
    });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      if (store.replay) store.setPlaying(this.wasPlaying);
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
  }

  private nudge(ms: number) {
    const r = store.replay;
    if (r) store.seek(r.t + ms);
  }

  private bindKeys() {
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'r' || e.key === 'R') return this.toggle();
      if (!store.replay) return;
      if (e.key === ' ') {
        e.preventDefault();
        store.setPlaying(!store.replay.playing);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.nudge(-10_000);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.nudge(10_000);
      }
    });
  }

  // ---------------------------------------------------------------- render

  private render() {
    const r = store.replay;
    this.root.classList.toggle('show', Boolean(r));
    document.documentElement.classList.toggle('replaying', Boolean(r));
    if (!r) return;
    const now = Date.now();
    const span = Math.max(1, now - store.start);
    const f = Math.min(1, Math.max(0, (r.t - store.start) / span));
    this.fill.style.transform = `scaleX(${f})`;
    this.head.style.left = `${f * 100}%`;
    this.playBtn.innerHTML = icon(r.playing ? 'pause' : 'play');
    this.speedBtn.textContent = `${r.speed}×`;
    this.label.innerHTML = `<b>${clock(r.t)}</b><span>${behind(now - r.t)}</span>`;
    this.track.setAttribute('aria-valuetext', `${clock(r.t)}, ${behind(now - r.t)}`);
    this.drawTicks(now);
  }

  /** Redraw the event ticks about twice a second (the live edge moves them left). */
  private drawTicks(now: number) {
    const entries = store.entries;
    const key = `${entries.length}:${store.start}:${Math.floor(now / 500)}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    const w = this.track.clientWidth;
    const h = this.track.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.root);
    const colors = {
      message: css.getPropertyValue('--accent').trim() || '#ff5f2e',
      attention: '#f5a524',
      join: '#22c55e',
      leave: css.getPropertyValue('--text-3').trim() || '#8a93a3',
      plain: css.getPropertyValue('--text-3').trim() || '#8a93a3',
    };
    const heights = { message: 0.8, attention: 0.8, join: 0.6, leave: 0.45, plain: 0.32 };
    const span = Math.max(1, now - store.start);
    // One tick per pixel column, keeping the most interesting kind.
    const rank = { plain: 0, leave: 1, join: 2, attention: 3, message: 4 };
    const cols = new Map<number, keyof typeof rank>();
    for (const e of entries) {
      const x = Math.round(((e.at - store.start) / span) * (w - 2)) + 1;
      const k = tickKind(e);
      const prev = cols.get(x);
      if (!prev || rank[k] > rank[prev]) cols.set(x, k);
    }
    for (const [x, k] of cols) {
      const th = h * heights[k];
      ctx.globalAlpha = k === 'plain' ? 0.55 : 0.95;
      ctx.fillStyle = colors[k];
      ctx.fillRect(x - 0.75, (h - th) / 2, 1.5, th);
    }
    ctx.globalAlpha = 1;
  }
}
