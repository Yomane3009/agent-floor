import type { FloorEvent, WorldState } from '../../shared/protocol';
import { store, type LogEntry } from '../core/store';
import { icon } from './icons';

const OPEN_KEY = 'agent-floor:log-open';
const MAX_ROWS = 400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function clock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

function tidy(id: string) {
  return (id.split(/[:/]/).pop() || id).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface LogLine {
  at: number;
  team?: string;
  stage?: string;
  kind: 'handoff' | 'tool' | 'attention' | 'done' | 'you' | 'board' | 'move';
  who: string;
  text: string;
}

/**
 * Turn one floor event into a plain sentence, or nothing when it is noise
 * (the "thinking again" status that follows every tool call, for example).
 */
export function describe(ev: FloorEvent, nameOf: (id: string) => string, teamOf: (id: string) => string | undefined): LogLine | null {
  const who = nameOf(ev.agent);
  const base = { at: ev.ts, team: ev.team || teamOf(ev.agent), stage: ev.stage || undefined };
  switch (ev.type) {
    case 'join':
      if (ev.parent) return { ...base, team: base.team || teamOf(ev.parent), kind: 'handoff', who: `${nameOf(ev.parent)} → ${who}`, text: ev.text || ev.activity || 'New task' };
      return { ...base, kind: 'move', who, text: 'Arrived' };
    case 'message': {
      const to = ev.to?.length ? ev.to.map(nameOf).join(', ') : 'their lead';
      return { ...base, kind: 'handoff', who: `${who} → ${to}`, text: ev.text || 'Sent a message' };
    }
    case 'tool':
      // Spawning a helper already reads as a handoff line.
      if (ev.tool === 'Task' || ev.tool === 'Agent') return null;
      return { ...base, kind: 'tool', who, text: ev.activity || (ev.tool ? `Using ${ev.tool}` : 'Working') };
    case 'task':
      return ev.task ? { ...base, kind: 'board', who: 'Whiteboard', text: ev.task } : null;
    case 'leave':
      return { ...base, kind: 'move', who, text: 'Left' };
    case 'status': {
      if (ev.status === 'waiting') return { ...base, kind: 'attention', who, text: `Needs you: ${ev.activity || 'waiting for your reply'}` };
      if (ev.status === 'error') return { ...base, kind: 'attention', who, text: `Hit a problem: ${ev.activity || 'error'}` };
      if (ev.status === 'done') return { ...base, kind: 'done', who, text: ev.activity || 'Finished' };
      if (ev.activity?.startsWith('Asked: ')) return { ...base, kind: 'you', who: `You → ${who}`, text: ev.activity.slice(7) || '(empty prompt)' };
      return null;
    }
    default:
      return null;
  }
}

/**
 * The office log: a running, plain-language account of who did what and who
 * handed what to whom, built from the same events the floor animates.
 * Follows the selected agent's room (or shows every room), and follows replay.
 */
export class OfficeLog {
  private root = el('aside', 'office-log glass');
  private title = el('div', 'log-title');
  private list = el('ol', 'log-list');
  private emptyNote = el('p', 'log-empty', 'Nothing has happened yet. Every handoff, tool call and question for you will show up here.');
  private copyBtn = el('button', 'icon-btn', icon('copy')) as HTMLButtonElement;
  private renderedKey = '';
  private lines: LogLine[] = [];
  open = false;
  onToggle: (open: boolean) => void = () => {};

  constructor(container: HTMLElement) {
    this.root.setAttribute('aria-label', 'Office log');
    const head = el('div', 'log-head');
    const close = el('button', 'icon-btn close', icon('x')) as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the office log');
    close.addEventListener('click', () => this.setOpen(false));
    this.copyBtn.type = 'button';
    this.copyBtn.title = 'Copy the log as text';
    this.copyBtn.setAttribute('aria-label', 'Copy the log as text');
    this.copyBtn.addEventListener('click', () => this.copy());
    head.append(this.title, this.copyBtn, close);
    this.list.setAttribute('aria-live', 'polite');
    this.root.append(head, this.list, this.emptyNote);
    container.append(this.root);
    store.subscribe(() => this.render());
    try {
      if (localStorage.getItem(OPEN_KEY) === '1') this.setOpen(true);
    } catch {
      /* storage unavailable: starts closed */
    }
  }

  toggle() {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean) {
    this.open = open;
    this.root.classList.toggle('show', open);
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* fine: only remembers the panel between visits */
    }
    this.renderedKey = '';
    this.render();
    this.onToggle(open);
  }

  private render() {
    if (!this.open) return;
    const state = store.state;
    const until = store.replay?.t ?? Infinity;
    const selected = store.selected ? state.agents[store.selected] : undefined;
    const team = selected?.team;
    const entries = store.entries;
    const key = `${store.backlog.length}:${entries.length}:${entries.at(-1)?.at}:${team}:${Math.floor(until / 1000)}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    this.lines = buildLines(store.backlog, entries, state, until).filter((l) => !team || l.team === team);
    if (this.lines.length > MAX_ROWS) this.lines = this.lines.slice(-MAX_ROWS);
    const teamName = team ? state.teams[team]?.name || team : 'All rooms';
    this.title.innerHTML = `<b>Office log</b><span>${esc(teamName)}</span>`;

    const stick = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    this.list.innerHTML = this.lines
      .map(
        (l) =>
          `<li class="lk-${l.kind}"><time>${clock(l.at)}</time><span class="log-who">${l.stage ? `<span class="log-stage">${esc(l.stage)}</span>` : ''}${esc(l.who)}</span><span class="log-text">${esc(l.text)}</span></li>`,
      )
      .join('');
    this.emptyNote.hidden = this.lines.length > 0;
    if (stick) this.list.scrollTop = this.list.scrollHeight;
  }

  private async copy() {
    const text = this.lines.map((l) => `${clock(l.at)}  ${l.stage ? `[${l.stage}] ` : ''}${l.who}: ${l.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.copyBtn.innerHTML = icon('check');
      setTimeout(() => (this.copyBtn.innerHTML = icon('copy')), 1400);
    } catch {
      /* clipboard blocked: the log is still selectable */
    }
  }
}

/** Every recorded change up to `until`, as sentences, with names as the floor knew them. */
function buildLines(backlog: readonly (FloorEvent & { actor?: string })[], entries: readonly LogEntry[], state: WorldState, until: number): LogLine[] {
  const names = new Map<string, string>();
  const teams = new Map<string, string>();
  const stages = new Map<string, string>();
  const aliases = state.aliases || {};
  const real = (id: string) => aliases[id] || id;
  const nameOf = (id: string) => names.get(real(id)) || state.agents[real(id)]?.name || tidy(real(id));
  const teamOf = (id: string) => teams.get(real(id)) || state.agents[real(id)]?.team;
  const out: LogLine[] = [];
  // Replay only reaches back to when this browser connected, so earlier lines show only when live.
  const all: { at: number; event?: FloorEvent; actor?: string }[] = [
    ...(until === Infinity ? backlog.map((event) => ({ at: event.ts, event, actor: event.actor })) : []),
    ...entries,
  ];
  for (const e of all) {
    if (e.at > until) break;
    const ev = e.event;
    if (!ev || ev.type === 'reset') continue;
    const id = real(e.actor || ev.agent);
    // Learn names and rooms as they appear, so lines about agents that have since left still read well.
    if (ev.name && !(ev.type !== 'join' && names.has(id))) names.set(id, ev.name);
    if (ev.team) teams.set(id, ev.team);
    else if (ev.parent && !teams.has(id)) {
      const t = teamOf(ev.parent);
      if (t) teams.set(id, t);
    }
    if (ev.stage !== undefined) {
      if (ev.stage) stages.set(id, ev.stage);
      else stages.delete(id);
    }
    const line = describe(e.actor ? { ...ev, agent: e.actor } : ev, nameOf, teamOf);
    if (!line) continue;
    // "Report ready" followed by "Handed back results" is one moment: keep the handoff.
    const prev = out.at(-1);
    if (line.kind === 'done' && prev?.kind === 'handoff' && prev.who.startsWith(`${line.who} →`) && e.at - prev.at < 3000) continue;
    line.at = e.at;
    line.stage = ev.stage || stages.get(id);
    out.push(line);
  }
  return out;
}
