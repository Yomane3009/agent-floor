import { applyEvent, createState, normalizeEvent, removeAgents, sweep } from '../../shared/protocol.js';
import type { Effect, FloorEvent, InboundEvent, WorldState } from '../../shared/protocol';

export type ConnectionMode = 'connecting' | 'live' | 'demo' | 'offline';

/** What the scene animates. `jump` means "the view moved in time: place everyone instantly". */
export type ViewEffect = Effect | { kind: 'jump' };

type Listener = () => void;
type EffectListener = (effect: ViewEffect) => void;

/** One recorded change. `at` is when this browser saw it, which is what the timeline plots. */
export interface LogEntry {
  at: number;
  event?: FloorEvent;
  removed?: string[];
}

export interface ReplayState {
  /** The moment the view shows, on the same clock as LogEntry.at. */
  t: number;
  playing: boolean;
  speed: number;
}

/** How much the timeline keeps. Older changes are folded into the starting state. */
const KEEP_MS = 30 * 60_000;
const KEEP_ENTRIES = 5000;

const clone = <T>(v: T): T => structuredClone(v);

/**
 * Single source of truth for the browser. The same reducer runs on the server,
 * so a snapshot plus the event stream reproduces the server state exactly.
 *
 * Every change is also kept in a short log, which is what replay plays back:
 * the reducer is deterministic, so the starting state plus the log up to any
 * moment rebuilds exactly what the floor looked like then.
 */
class Store {
  mode: ConnectionMode = 'connecting';
  selected: string | null = null;
  replay: ReplayState | null = null;

  private live: WorldState = createState();
  private view: WorldState | null = null;
  private base: WorldState = createState();
  private baseAt = Date.now();
  private log: LogEntry[] = [];
  /** Index of the first log entry not yet applied to `view`. */
  private cursor = 0;
  private listeners = new Set<Listener>();
  private effectListeners = new Set<EffectListener>();

  /** What the scene and HUD show: the live floor, or the replayed moment. */
  get state(): WorldState {
    return this.view ?? this.live;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEffect(fn: EffectListener) {
    this.effectListeners.add(fn);
    return () => this.effectListeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private emitEffects(effects: ViewEffect[]) {
    for (const e of effects) for (const fn of this.effectListeners) fn(e);
  }

  setMode(mode: ConnectionMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit();
  }

  select(id: string | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.emit();
  }

  replace(state: WorldState) {
    this.live = state;
    this.base = clone(state);
    this.baseAt = Date.now();
    this.log = [];
    this.cursor = 0;
    this.view = null;
    this.replay = null;
    this.emitEffects([{ kind: 'reset' }]);
    this.emit();
  }

  /** Apply an event that the server already normalised, with the effects it computed. */
  applyRemote(event: FloorEvent, effects: Effect[]) {
    applyEvent(this.live, event);
    this.record({ at: Date.now(), event: clone(event) });
    if (this.view) return this.emit();
    // State first so the scene has every character before effects animate them.
    this.emit();
    this.emitEffects(effects);
  }

  /** Apply a raw event locally (demo mode). */
  applyLocal(raw: InboundEvent) {
    const ev = normalizeEvent(raw);
    if (!ev) return;
    const { effects } = applyEvent(this.live, ev);
    this.record({ at: Date.now(), event: clone(ev) });
    if (this.view) return this.emit();
    this.emit();
    this.emitEffects(effects);
  }

  remove(ids: string[]) {
    const removed = removeAgents(this.live, ids);
    if (!removed.length) return;
    this.record({ at: Date.now(), removed });
    if (!this.view && this.selected && !this.live.agents[this.selected]) this.selected = null;
    this.emit();
  }

  sweepLocal() {
    const removed = sweep(this.live);
    if (!removed.length) return;
    this.record({ at: Date.now(), removed });
    if (!this.view && this.selected && removed.includes(this.selected)) this.selected = null;
    this.emit();
  }

  // ---------------------------------------------------------------- timeline

  private record(entry: LogEntry) {
    this.log.push(entry);
    const cutoff = entry.at - KEEP_MS;
    let drop = 0;
    while (drop < this.log.length && (this.log.length - drop > KEEP_ENTRIES || this.log[drop].at < cutoff)) {
      // Keep entries the replayed view still needs to reach.
      if (this.view && drop >= this.cursor) break;
      applyEntry(this.base, this.log[drop]);
      this.baseAt = this.log[drop].at;
      drop++;
    }
    if (drop) {
      this.log.splice(0, drop);
      this.cursor = Math.max(0, this.cursor - drop);
    }
  }

  /** Earliest moment the timeline can show. */
  get start() {
    return this.baseAt;
  }

  /** The recorded changes, oldest first. Read only. */
  get entries(): readonly LogEntry[] {
    return this.log;
  }

  /** Go back in time. Starts at the beginning of the timeline and plays. */
  startReplay(speed = 4) {
    this.replay = { t: this.baseAt, playing: true, speed };
    this.seek(this.baseAt);
  }

  /** Back to the live floor. */
  stopReplay() {
    if (!this.replay) return;
    this.replay = null;
    this.view = null;
    this.cursor = 0;
    if (this.selected && !this.live.agents[this.selected]) this.selected = null;
    this.emitEffects([{ kind: 'jump' }]);
    this.emit();
  }

  setPlaying(playing: boolean) {
    if (!this.replay || this.replay.playing === playing) return;
    this.replay.playing = playing;
    this.emit();
  }

  setSpeed(speed: number) {
    if (!this.replay) return;
    this.replay.speed = speed;
    this.emit();
  }

  /** Jump to a moment: rebuild it from the starting state and place everyone instantly. */
  seek(t: number) {
    if (!this.replay) return;
    const now = Date.now();
    if (t >= now) return this.stopReplay();
    t = Math.max(this.baseAt, t);
    const view = clone(this.base);
    let i = 0;
    while (i < this.log.length && this.log[i].at <= t) applyEntry(view, this.log[i++]);
    this.view = view;
    this.cursor = i;
    this.replay.t = t;
    if (this.selected && !view.agents[this.selected]) this.selected = null;
    this.emitEffects([{ kind: 'jump' }]);
    this.emit();
  }

  /** Play forward to `t`, animating what happened on the way (paper planes, arrivals). */
  advance(t: number) {
    if (!this.replay || !this.view) return;
    if (t >= Date.now()) return this.stopReplay();
    const effects: ViewEffect[] = [];
    let changed = false;
    while (this.cursor < this.log.length && this.log[this.cursor].at <= t) {
      effects.push(...applyEntry(this.view, this.log[this.cursor++]));
      changed = true;
    }
    this.replay.t = t;
    if (this.selected && !this.view.agents[this.selected]) this.selected = null;
    this.emit();
    if (changed) this.emitEffects(effects);
  }
}

function applyEntry(state: WorldState, entry: LogEntry): Effect[] {
  if (entry.event) return applyEvent(state, entry.event).effects;
  if (entry.removed) removeAgents(state, entry.removed);
  return [];
}

export const store = new Store();
