export type Status = 'idle' | 'thinking' | 'working' | 'waiting' | 'done' | 'error' | 'offline';
export type EventType = 'join' | 'status' | 'tool' | 'message' | 'task' | 'leave' | 'reset';

/** What clients POST to /events. Only `type` and `agent` are required. */
export interface InboundEvent {
  type: EventType;
  agent: string | { id: string; name?: string; role?: string; source?: string };
  name?: string;
  role?: string;
  source?: string;
  team?: string | { id?: string; name: string };
  parent?: string;
  status?: Status;
  activity?: string;
  tool?: string;
  text?: string;
  task?: string;
  to?: string | string[];
  subagent?: { key?: string; type?: string };
  ts?: number;
}

export interface FloorEvent {
  type: EventType;
  ts: number;
  agent: string;
  name?: string;
  role?: string;
  source?: string;
  parent?: string;
  team?: string;
  teamName?: string;
  status?: Status;
  activity?: string;
  tool?: string;
  text?: string;
  task?: string;
  to?: string[];
}

export interface HistoryEntry {
  ts: number;
  kind: 'join' | 'status' | 'tool' | 'message' | 'task' | 'leave';
  text: string;
  tool?: string;
  status?: Status;
  to?: string[];
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  team: string;
  source: string;
  parent?: string;
  status: Status;
  activity?: string;
  tool?: string;
  joinedAt: number;
  lastSeen: number;
  history: HistoryEntry[];
  boundKey?: string;
}

export interface Team {
  id: string;
  name: string;
  hue: number;
  order: number;
  task?: string;
  createdAt: number;
}

export interface WorldState {
  teams: Record<string, Team>;
  agents: Record<string, Agent>;
  seq: number;
  updatedAt: number;
}

export type Effect =
  | { kind: 'reset' }
  | { kind: 'arrive'; agent: string }
  | { kind: 'leave'; agent: string }
  | { kind: 'message'; from: string; to: string; text: string };

export const PROTOCOL_VERSION: number;
export const STATUSES: Status[];
export const EVENT_TYPES: EventType[];
export function createState(): WorldState;
export function slug(value: unknown): string;
export function normalizeEvent(raw: unknown, now?: number): FloorEvent | null;
export function applyEvent(state: WorldState, ev: FloorEvent | null): { state: WorldState; effects: Effect[] };
export function removeAgents(state: WorldState, ids: string[]): string[];
export function sweep(state: WorldState, now?: number, opts?: { offlineMs?: number; doneHelperMs?: number; staleMs?: number }): string[];
