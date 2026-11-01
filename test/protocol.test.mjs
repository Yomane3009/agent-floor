import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createState, normalizeEvent, removeAgents, sweep } from '../shared/protocol.js';
import { fromClaude } from '../adapters/claude.mjs';
import { fromCodex } from '../adapters/codex.mjs';
import { fromCursor, cursorResponse } from '../adapters/cursor.mjs';

const run = (state, raw) => applyEvent(state, normalizeEvent(raw));

test('any event creates its agent and team', () => {
  const s = createState();
  run(s, { type: 'status', agent: 'a1', team: 'Checkout', status: 'working', activity: 'Editing' });
  assert.equal(s.agents.a1.team, 'checkout');
  assert.equal(s.teams.checkout.name, 'Checkout');
  assert.equal(s.agents.a1.status, 'working');
});

test('rejects junk', () => {
  assert.equal(normalizeEvent({ type: 'nope', agent: 'x' }), null);
  assert.equal(normalizeEvent({ type: 'status' }), null);
  assert.equal(normalizeEvent('hi'), null);
});

test('message emits an effect and creates unknown recipients in the same team', () => {
  const s = createState();
  run(s, { type: 'join', agent: 'lead', team: 't' });
  const { effects } = run(s, { type: 'message', agent: 'lead', to: 'helper', text: 'hi' });
  assert.ok(effects.some((e) => e.kind === 'message' && e.from === 'lead' && e.to === 'helper'));
  assert.equal(s.agents.helper.team, 't');
});

test('helpers inherit their parent team', () => {
  const s = createState();
  run(s, { type: 'join', agent: 'lead', team: 'auth' });
  run(s, { type: 'join', agent: 'kid', parent: 'lead' });
  assert.equal(s.agents.kid.team, 'auth');
});

test('subagent hints bind to the spawned desk', () => {
  const s = createState();
  for (const ev of fromClaude({ hook_event_name: 'PreToolUse', session_id: 'sess1234', cwd: '/x/shop', tool_name: 'Task', tool_use_id: 'tu_1', tool_input: { subagent_type: 'code-reviewer', description: 'Review diff' } }))
    run(s, ev);
  const ids = Object.keys(s.agents);
  assert.equal(ids.length, 2);
  for (const ev of fromClaude({ hook_event_name: 'PreToolUse', session_id: 'sess1234', cwd: '/x/shop', agent_id: 'ag_9', agent_type: 'code-reviewer', tool_name: 'Read', tool_input: { file_path: '/x/shop/a.ts' } }))
    run(s, ev);
  assert.equal(Object.keys(s.agents).length, 2, 'no extra desk');
  const child = Object.values(s.agents).find((a) => a.parent);
  assert.equal(child.activity, 'Reading a.ts');
  assert.equal(child.boundKey, 'ag_9');
});

test('claude adapter maps the main lifecycle', () => {
  const base = { session_id: 'abcdef123', cwd: '/home/me/storefront' };
  assert.equal(fromClaude({ ...base, hook_event_name: 'SessionStart' })[0].type, 'join');
  const tool = fromClaude({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } })[0];
  assert.equal(tool.activity, 'Running npm test');
  assert.equal(tool.team, 'storefront');
  const todo = fromClaude({ ...base, hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Fix cart', activeForm: 'Fixing cart', status: 'in_progress' }] } });
  assert.equal(todo[1].task, 'Fixing cart');
  assert.equal(fromClaude({ ...base, hook_event_name: 'Stop' })[0].status, 'idle');
  assert.deepEqual(fromClaude(null), []);
});

test('codex notify payload', () => {
  const evs = fromCodex({ type: 'agent-turn-complete', 'thread-id': 't-1', cwd: '/a/api', 'input-messages': ['fix it'], 'last-assistant-message': 'Fixed' });
  assert.equal(evs.at(-1).status, 'idle');
  assert.equal(evs[0].team, 'api');
});

test('cursor adapter only answers beforeSubmitPrompt', () => {
  const evs = fromCursor({ hook_event_name: 'afterFileEdit', conversation_id: 'c1', workspace_roots: ['/w/site'], file_path: '/w/site/a.md' });
  assert.equal(evs[0].activity, 'Edited a.md');
  assert.equal(cursorResponse('afterFileEdit'), '');
  assert.deepEqual(JSON.parse(cursorResponse('beforeSubmitPrompt')), { continue: true });
});

test('sweep removes departed agents and empty teams', () => {
  const s = createState();
  run(s, { type: 'join', agent: 'a', team: 'x', ts: 1000 });
  run(s, { type: 'leave', agent: 'a', ts: 1000 });
  assert.deepEqual(sweep(s, 1000 + 60_000), ['a']);
  assert.equal(Object.keys(s.teams).length, 0);
});

test('removeAgents drops agents and empty teams, and reports what it removed', () => {
  const s = createState();
  run(s, { type: 'join', agent: 'a', team: 'One' });
  run(s, { type: 'join', agent: 'b', team: 'Two' });
  assert.deepEqual(removeAgents(s, ['b', 'ghost']), ['b']);
  assert.ok(s.agents.a && !s.agents.b);
  assert.deepEqual(Object.keys(s.teams), ['one']);
});

test('replaying the recorded events onto the starting state rebuilds the floor exactly', () => {
  const live = createState();
  run(live, { type: 'join', agent: 'lead', team: 'Core', ts: 1 });
  const base = structuredClone(live);
  const log = [
    { type: 'tool', agent: 'lead', tool: 'Bash', activity: 'Tests', ts: 2 },
    { type: 'join', agent: 'helper', parent: 'lead', role: 'Explore', ts: 3 },
    { type: 'message', agent: 'helper', text: 'Found it', status: 'done', ts: 4 },
    { type: 'task', agent: 'lead', task: 'Ship replay', ts: 5 },
  ].map((raw) => normalizeEvent(raw));
  for (const ev of log) applyEvent(live, ev);
  const replayed = structuredClone(base);
  for (const ev of log) applyEvent(replayed, ev);
  replayed.seq = live.seq;
  assert.deepEqual(replayed, live);
  // Part way through: the helper has not arrived yet.
  const early = structuredClone(base);
  applyEvent(early, log[0]);
  assert.equal(early.agents.lead.tool, 'Bash');
  assert.equal(early.agents.helper, undefined);
});

// ---------------------------------------------------------------- pipelines (stage labels, crew mode)

const spawn = (type, id, description, extra = {}) => ({
  hook_event_name: 'PreToolUse',
  session_id: 'sess1234',
  cwd: '/x/linkedin-video',
  tool_name: 'Task',
  tool_use_id: id,
  tool_input: { subagent_type: type, description, prompt: 'Do the work' },
  ...extra,
});
const finish = (type, id) => ({ ...spawn(type, id, ''), hook_event_name: 'PostToolUse' });

function withCrew(fn) {
  const prev = process.env.AGENT_FLOOR_CREW;
  process.env.AGENT_FLOOR_CREW = '1';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AGENT_FLOOR_CREW;
    else process.env.AGENT_FLOOR_CREW = prev;
  }
}

test('spawns that name a stage label the helper desk', () => {
  const s = createState();
  for (const ev of fromClaude(spawn('Trend Researcher', 'tu_1', 'Stage 1 - find trending topics'))) run(s, ev);
  const kid = Object.values(s.agents).find((a) => a.parent);
  assert.equal(kid.stage, 'Stage 1');
  assert.equal(kid.name, 'Trend Researcher');
  for (const ev of fromClaude(spawn('helper', 'tu_2', 'Look around'))) run(s, ev);
  assert.equal(Object.values(s.agents).filter((a) => a.parent && a.stage).length, 1, 'no stage when none is named');
});

test('a stage label can be cleared with an empty string', () => {
  const s = createState();
  run(s, { type: 'status', agent: 'a', stage: 'Stage 3' });
  assert.equal(s.agents.a.stage, 'Stage 3');
  run(s, { type: 'status', agent: 'a', stage: '' });
  assert.equal(s.agents.a.stage, undefined);
});

test('without crew mode, finished helpers leave and Stop is idle', () => {
  const s = createState();
  for (const ev of fromClaude(spawn('Trend Researcher', 'tu_1', 'Stage 1'))) run(s, ev);
  for (const ev of fromClaude(finish('Trend Researcher', 'tu_1'))) run(s, ev);
  const kid = Object.values(s.agents).find((a) => a.parent);
  assert.equal(kid.stay, undefined);
  assert.deepEqual(sweep(s, kid.lastSeen + 60_000), [kid.id]);
  const stop = fromClaude({ hook_event_name: 'Stop', session_id: 'sess1234', cwd: '/x/linkedin-video' })[0];
  assert.equal(stop.status, 'idle');
});

test('crew mode keeps helpers at their desks until the lead leaves', () => {
  const s = createState();
  withCrew(() => {
    for (const ev of fromClaude({ hook_event_name: 'SessionStart', session_id: 'sess1234', cwd: '/x/linkedin-video' })) run(s, ev);
    for (const ev of fromClaude(spawn('Trend Researcher', 'tu_1', 'Stage 1'))) run(s, ev);
    for (const ev of fromClaude(finish('Trend Researcher', 'tu_1'))) run(s, ev);
    const stop = fromClaude({ hook_event_name: 'Stop', session_id: 'sess1234', cwd: '/x/linkedin-video' })[0];
    assert.equal(stop.status, 'waiting', 'the lead needs you as soon as it stops');
  });
  const kid = Object.values(s.agents).find((a) => a.parent);
  assert.equal(kid.status, 'done');
  assert.deepEqual(sweep(s, kid.lastSeen + 10 * 60_000), [], 'still at its desk');
  const { effects } = run(s, fromClaude({ hook_event_name: 'SessionEnd', session_id: 'sess1234', cwd: '/x/linkedin-video' })[0]);
  assert.ok(effects.some((e) => e.kind === 'leave' && e.agent === kid.id), 'walks out with the lead');
  assert.equal(s.agents[kid.id].status, 'offline');
});

test('crew mode reuses the same desk when a role is spawned again', () => {
  const s = createState();
  withCrew(() => {
    for (const ev of fromClaude(spawn('Frontend Developer', 'tu_a', 'Stage 4 - build the video'))) run(s, ev);
    for (const ev of fromClaude(finish('Frontend Developer', 'tu_a'))) run(s, ev);
    const first = Object.values(s.agents).find((a) => a.parent);
    const out = [];
    for (const ev of fromClaude(spawn('Frontend Developer', 'tu_b', 'Stage 4 - fix captions'))) out.push(...run(s, ev).effects);
    assert.equal(Object.values(s.agents).filter((a) => a.parent).length, 1, 'no second desk');
    assert.equal(first.status, 'thinking');
    assert.ok(out.some((e) => e.kind === 'message' && e.to === first.id), 'briefed again');
    // Work inside the second run lands on the same desk.
    for (const ev of fromClaude({ hook_event_name: 'PreToolUse', session_id: 'sess1234', cwd: '/x/linkedin-video', agent_id: 'ag_2', agent_type: 'Frontend Developer', tool_name: 'Bash', tool_input: { command: 'npx remotion render' } }))
      run(s, ev);
    assert.equal(first.activity, 'Running npx remotion render');
    for (const ev of fromClaude(finish('Frontend Developer', 'tu_b'))) run(s, ev);
    assert.equal(first.status, 'done');
  });
});
