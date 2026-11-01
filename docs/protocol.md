# Event protocol (v1)

Agents talk to the floor by posting JSON to `POST /events`. Send one object or an array of up to 200. The request must have `Content-Type: application/json`.

Only `type` and `agent` are required. Any event creates the agent and its team if they do not exist yet, so the smallest useful integration is a single `status` call.

```json
{ "type": "status", "agent": "bot-1", "team": "Payments", "status": "working", "activity": "Reconciling invoices" }
```

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `join` `status` `tool` `message` `task` `leave` `reset` | What happened. |
| `agent` | string, or `{ id, name?, role?, source? }` | Stable id for this agent. Reuse it for every event. |
| `name` | string | Display name. Defaults to a tidied version of the id. |
| `role` | string | Shown under the name and decides shirt colour. `Lead` gets the head desk and a headset. |
| `team` | string, or `{ id?, name }` | The room. Agents with the same team share a square. Defaults to the parent's team, then `default`. |
| `parent` | agent id | Who spawned this agent. Joining with a parent plays a briefing paper plane. |
| `source` | string | `claude-code`, `codex`, `cursor`, `cli` or anything you like. Shown on the agent card. |
| `status` | `idle` `thinking` `working` `waiting` `done` `error` `offline` | Drives the character's pose, badge, screen and floor ring. |
| `activity` | string, up to 280 chars | One line about what it is doing right now. Shown on the monitor and the name tag. |
| `tool` | string | Tool name for `tool` events. Shown in the monitor's title bar. |
| `to` | agent id or array | Recipients of a `message`. Unknown recipients are created in the sender's team. |
| `text` | string | Message text, shown in a speech bubble over the sender. |
| `task` | string | For `task` events: written on the team whiteboard. |
| `subagent` | `{ key?, type? }` | For adapters that only know "a subagent of type X". See below. |
| `stage` | string, up to 24 chars | A pipeline label shown on the name tag and card, e.g. `Stage 2`. Send `""` to clear it. |
| `stay` | boolean | On `join` with a `parent`: keep this helper at its desk after it finishes, until its parent leaves. A later `join` from the same parent with the same `role` reuses that desk. |
| `ts` | number (ms) | Optional timestamp. Defaults to now. |

## Event types

- **join**: an agent arrives. It walks in from the door and sits down. With `parent`, the parent briefs it.
- **status**: change `status` and/or `activity`.
- **tool**: the agent is using a tool. Sets `status` to `working` unless you pass another.
- **message**: a paper plane flies from `agent` to each `to`. Without `to`, it goes to the parent.
- **task**: update the team whiteboard.
- **leave**: the agent stands up and walks out. It is removed a few seconds later.
- **reset**: clear the whole floor.

## Lifetime

The server forgets agents that have left after 6 seconds, helpers (agents with a `parent`) 45 seconds after they finish with `done` (unless they joined with `stay`, in which case they leave with their parent), and anything silent for 2 hours. Empty rooms disappear with their last agent.

## Subagent hints

Some tools tell you a tool call happened inside "a subagent of type `code-reviewer`" with an opaque id, but not which spawn it belongs to. Send the event as the parent with a hint:

```json
{ "type": "tool", "agent": "lead-1", "subagent": { "key": "ag_9", "type": "code-reviewer" }, "tool": "Read", "activity": "Reading cart.ts" }
```

The floor binds the hint to the oldest unbound helper of that `role` under `lead-1`, and remembers the key so later events land on the same desk. If there is no such helper, it opens a new desk.

## Reading state

- `GET /stream`: Server-Sent Events. First a `snapshot` with the full state and `recent` (the last 30 minutes of events, for the office log), then `event` frames (`{ event, effects }`) and `removed` frames (`{ agents: [...] }`).
- `GET /state`: the current world as JSON.
- `GET /health`: `{ ok, version, agents }`.
- `POST /reset`: clear the floor.

The reducer that turns events into state is `shared/protocol.js`. It has no dependencies, so you can import it to build other views on the same stream.
