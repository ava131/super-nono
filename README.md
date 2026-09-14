# Super Nono

> A **pixel desktop pet** that lives on your macOS desktop — and a **skill-calling AI agent** underneath.

It breathes, blinks, and can be dragged anywhere. Click it and a chat bubble opens,
backed by DeepSeek. It ships with a permission-gated skill system: weather, stock quotes,
and a watchlist. It remembers what you talked about, and it says "I can't find that"
instead of making things up.

**English** · [中文](README.zh-CN.md)

**A personal project. Not affiliated with Taomee or *Seer* (赛尔号); no assets were used.**
See [NOTICE.md](NOTICE.md).

---

## Contents

- [What it looks like](#what-it-looks-like)
- [Quick start](#quick-start)
- [Things to try](#things-to-try)
- [Features](#features)
- [Privacy & security](#privacy--security)
- [Writing a skill](#writing-a-skill)
- [Project layout](#project-layout)
- [Development](#development)
- [Design docs](#design-docs)
- [Roadmap](#roadmap)

---

## What it looks like

> 📷 *(screenshot / GIF slot — contributions welcome)*

A 96×96 pixel robot: transparent background, always on top, no Dock icon.
You can only drag it by its actual pixels; clicks on the transparent area pass through
to whatever is behind, so it never gets in your way.

---

## Quick start

### Requirements

| Item | Requirement |
|---|---|
| OS | macOS (Apple Silicon; v0 does not support Windows / Linux) |
| Node.js | ≥ 22 (developed on 24.19) |
| Package manager | pnpm ≥ 10 (developed on 11.22) |

### Install

```bash
git clone https://github.com/ava131/super-nono.git
cd super-nono
pnpm install
```

**If the Electron binary fails to download** (no `node_modules/electron/path.txt`), run:

```bash
pnpm electron:install
```

This script bypasses `@electron/get`: it downloads from a mirror, verifies the sha256
against the official `checksums.json`, extracts into `node_modules/electron/dist`, and
writes `path.txt`. On mainland-China networks this is usually required.

<details>
<summary>Why is that script needed? (four pitfalls)</summary>

All four are documented in [SDD §8.5](docs/SDD-v0.md):

1. **pnpm 10+ blocks dependency `postinstall` scripts by default** — so the Electron
   binary was never downloaded. Fix: declare `onlyBuiltDependencies: [electron]` in
   `pnpm-workspace.yaml` (already configured).
2. **GitHub Releases times out** — point `electron_mirror` at npmmirror in `.npmrc`
   (already configured).
3. **`@electron/get@5` dropped `ELECTRON_CACHE`** and hardcodes `~/Library/Caches`,
   which fails with `EPERM` in restricted environments — hence `pnpm electron:install`.
4. **Electron 44 changed what `path.txt` means**: `index.js` appends `dist/`, so the
   file must **not** contain a `dist/` prefix.

</details>

### Run

```bash
pnpm start
```

### First-time setup

1. Click the pet → the bubble opens
2. Click **⚙** in the top-right
3. Enter your **DeepSeek API Key** → save

The key is encrypted with Electron's built-in `safeStorage` (backed by the macOS Keychain)
and stored in `~/Library/Application Support/Super Nono/config.json`; the plaintext only
ever lives in memory. If the system cannot provide secure encryption, it **fails loudly and
refuses to save** — it never silently falls back to plaintext.

---

## Things to try

| Say this | What happens |
|---|---|
| `你好，介绍一下你自己` | Streams a reply token by token |
| `上海今天天气怎么样` | Calls the `weather` skill, returns real data |
| `茅台现在什么状态` | Calls `market`, returns a factual "status report" |
| `把宁德时代加进自选` | Adds to watchlist **without a confirmation dialog** |
| `我自选股都怎么样了` | Batch-scans your whole watchlist |
| `宇树科技` | Resolves a newly-listed stock **by name** via search |
| `516350` | Works for ETFs too (code goes straight through) |
| `帮我查一下火星的天气` | Clearly says it cannot find it — **never makes it up** |
| `茅台能买吗` | **Refuses to give advice**; gives objective data only |
| *(click "Stop" mid-generation)* | Disconnects immediately rather than waiting for a timeout |

> The pet answers in Chinese. The **Chinese README** is at [README.zh-CN.md](README.zh-CN.md).

---

## Features

### Pet (Body)

- Transparent, frameless, always-on-top window with no Dock icon
- **10 fps** pixel animation: idle / dragging / thinking / speaking / error
- **Precise hit testing** against the alpha channel, so the transparent area passes clicks
  through; hysteresis on the edges keeps it from flickering
- **Dragging** polls the cursor from the main process (in a 160×160 window a fast drag
  leaves the window and the renderer loses the events)
- **Click vs. drag** is decided by a 4px / 250ms threshold, so a shaky hand doesn't misfire
- Position is stored as a **ratio of the screen work area**, so it never lands off-screen
  after changing displays or resolution

### Brain

- DeepSeek streaming chat, **interruptible**
- **Tool-calling loop**: model decides → skill runs → result is fed back → model narrates
- **Sessions**: new / list / switch / rename / delete, titles auto-generated from the first message
- **Memory**: sessions persisted to local SQLite
- **Cost visibility**: tokens and estimated cost recorded per call, with a daily cost cap
- The persona lives in [assets/persona.md](assets/persona.md) — edit it and restart

### Skills

v0 ships three:

| Skill | What it does | Risk level |
|---|---|---|
| `weather` | Open-Meteo (primary) + wttr.in (fallback), **no API key needed** | L1 read-only |
| `market` | A-share quotes, indicators, historical percentiles, watchlist scan | L1 read-only |
| `watchlist` | Add / remove / list your watchlist | **L1.5 — runs without a confirmation dialog** |

Each skill is a self-contained directory with a declarative manifest:

```
skills/market/
├── skill.json   ← description for the model, param schema, permissions, risk, host allowlist
├── index.js     ← executor: export async function run(args, ctx)
└── ...
```

**Execution gates** (order matters):

| Gate | Behaviour |
|---|---|
| Existence | Unknown skill → rejected |
| Permissions | Declares `network:` but no allowlist → **refused at load time** |
| **L3 red line** | `irreversible` skills are **hard-refused; not even a confirmation is offered** |
| L2 confirmation | Non-read-only operations need a user nod; **timeout = denial** |
| Arguments | Invalid args → nothing is executed |
| Timeout | A stuck skill can't hang the conversation |

### Market (the "status report", not a trading signal)

This is the part with the most design care behind it. It answers **"what state is this
stock in"** — and deliberately refuses to answer **"should I buy"**.

- **Daily bars only.** No intraday. That's what makes the request volume low enough
  (≈20/day) to stay well clear of rate limits.
- **Two sources, primary/fallback**: Eastmoney (primary) → Yahoo (fallback).
  The switch is **all-or-nothing per call** — you never get half the batch from one
  source and half from the other, because their price-adjustment baselines differ and
  the numbers wouldn't be comparable.
- **Historical percentiles instead of adjectives.** "RSI is 28" means nothing on its own;
  "RSI is 28 — only 12% of the last 250 trading days closed lower" is checkable.
- **Six categories of forbidden output** (buy/sell calls, price targets, timing calls,
  certainty claims, ratings, fabricated data), enforced in the prompt *and* regression-tested
  against a 20-item corpus.
- **Number provenance**: every number in an answer must be traceable to what the tool
  returned.
- **Sample-size honesty, in two tiers**: if it can't be computed, it isn't shown;
  if it can be computed but the sample is short, it's shown *with a warning*.

That last one matters for newly-listed stocks. Real output for a stock with 19 bars:

```
样本不足：MACD（需 ≥ 34 根，当前 19 根）；区间位置/分位（需 ≥ 250 根，当前 19 根）
样本偏短、数值相对不可靠：RSI（建议 ≥ 60 根，当前 19 根）
```

### Watchlist

- Up to 20 entries, persisted locally, survives restart
- Adding is **L1.5**: no confirmation dialog. The safety net is instead
  **"the result is visible, and every row can be deleted"** — a confirmation dialog
  you always click through trains you to click through the one that matters.
- The bubble shows a **name + code only** list with **zero network calls** — so it still
  works when a data source is down or you're in offline mode.

---

## Privacy & security

The privacy model is deliberately narrow:

- **The only cloud endpoint is DeepSeek** (conversation content goes there — that's the
  unavoidable cost of using a cloud API)
- **The API key is the highest-value secret in the project**: encrypted into the local
  Keychain, never in a plaintext config, never in logs, never echoed in the UI
- **All outbound traffic goes through one chokepoint** (`src/main/skills/egress.js`),
  which forces HTTPS, validates a domain allowlist, and logs every request
  (host and status only — never response bodies)
- **Skills never get a raw `fetch`** — only the `ctx.safeFetch` the runner injects.
  The allowlist is a structural guarantee, not a convention.
- **Skill storage is gated at runtime**: a `read_only` skill cannot write user data.
  Private cache is a separate capability (`db:cache`), because "can write" and
  "can write something others read" are different risks.
- **Offline mode**: one switch cuts all outbound traffic, local features keep working
- All data stays local: `~/Library/Application Support/Super Nono/`

`pnpm skill:list` audits "which domains will this pet talk to".

---

## Writing a skill

1. Create `skills/<name>/`
2. Write `skill.json`:

```json
{
  "name": "demo",
  "version": "0.1.0",
  "description": "Shown to the model: when to use this. Quality here decides routing accuracy.",
  "parameters": {
    "type": "object",
    "properties": {
      "city": { "type": "string", "description": "City name" }
    },
    "required": ["city"]
  },
  "permissions": ["network:demo"],
  "networkHosts": ["api.example.com"],
  "risk": "read_only",
  "requiresConfirmation": false,
  "timeoutMs": 10000
}
```

3. Write `index.js`:

```js
export async function run(args, ctx) {
  const res = await ctx.safeFetch('https://api.example.com/x');
  if (!res.ok) return { ok: false, code: 'INTERNAL', message: `HTTP ${res.status}` };
  return { ok: true, summary: 'Short result for the model (≤800 chars)', data: { /* raw, not in context */ } };
}
```

4. Debug it directly (**bypassing the model**, to tell "the skill is broken" apart from
   "the model didn't call it"):

```bash
pnpm skill:test demo '{"city":"Shanghai"}'
pnpm skill:list          # permission union, host allowlist, disabled skills
```

5. Restart the app; the model sees the new skill automatically.

> Convention: `summary` is for the model and must be short (800 **UTF-16 code units**,
> not bytes — Chinese is 3 bytes/char). Raw bulk data goes in `data` and **does not enter
> the context**.

---

## Project layout

```
super-nono/
├── src/
│   ├── main/                Electron main process — also the agent host
│   │   ├── main.js          lifecycle, tray, single-instance lock, smoke self-check
│   │   ├── window.js        pet window + bubble window: create/position/drag/click-through
│   │   ├── ipc.js           the single place IPC is registered
│   │   ├── brain/           model calls, session loop, memory, persona, cost, status
│   │   ├── skills/          registry, execution gates, egress allowlist, store, validator
│   │   └── store/           SQLite and settings
│   ├── preload/preload.cjs  the only bridge (semantic methods; never exposes ipcRenderer)
│   ├── renderer/            pet and bubble UI
│   └── shared/              channel constants + pure geometry, shared by both ends
├── skills/
│   ├── weather/             weather skill
│   ├── market/              quotes, indicators, sources, symbol resolution, guardrails
│   └── watchlist/           watchlist skill (L1.5)
├── shared/limits.js         single source of truth for cross-module contract constants
├── assets/persona.md        persona prompt (editable)
├── config/pricing.json      DeepSeek price table (for cost estimation)
├── test/                    455 unit + integration cases, plus fixtures and mocks
├── scripts/                 Electron installer, skill CLI, Eastmoney capture probe
└── docs/                    PRDs, SDDs, review records, retrospectives
```

**One app, two windows, zero backend services**: the Brain runs inside the main process —
it *is* the backend. The two renderer windows are the frontend. They talk over in-process
IPC: no ports, no extra processes.

### Runtime dependencies

```json
"dependencies": {}
```

**Nothing but Electron itself.** Storage uses Node's built-in `node:sqlite`, the model
client is hand-written (fetch + SSE), argument validation is hand-written, and the tray
icon and pixel art are generated in code.

---

## Development

### Scripts

| Command | Purpose |
|---|---|
| `pnpm start` | Start in development mode |
| `pnpm dev` | Start with Chromium logging |
| `pnpm smoke` | **Self-check and exit**: window/always-on-top/focus/`setPosition`/click-through/tray/Dock, prints PASS/FAIL |
| `pnpm check` | TypeScript static check (`checkJs`, no build output) |
| `pnpm test` | Unit + integration tests (**455 cases**) |
| `pnpm skill:list` | List skills, permission union, host allowlist (auditable) |
| `pnpm skill:test` | Call one skill directly, bypassing the model |
| `pnpm market:capture` | Capture one real Eastmoney response into a test fixture |
| `pnpm electron:install` | Install the Electron binary manually (see above) |

### Tests

```bash
pnpm test
```

The suite focuses on **edges and failures**, not just the happy path:

- alpha hysteresis oscillation, drag thresholds, position-ratio math
- the SSE parser (fed in 7-character chunks to simulate real network fragmentation)
- four session-deletion edge cases (current / last / missing / no cross-talk)
- the skill gates, `summary` truncation, timeouts, no side effects on invalid args
- **the agent loop against a mock provider**: 5-step loop abort, budget gate, cancellation,
  accounting on every round-trip — none of which costs real money
- **market**: indicator correctness, price-adjustment direction, source failover,
  cache hits, cancellation vs. timeout, summary budget, number provenance

**Development never hits real APIs.** Real responses are captured once into
`test/fixtures/` (with provenance recorded) and replayed; synthetic data covers cases the
real fixtures don't have.

---

## Design docs

This project documents itself heavily, because **the reasoning behind a decision is easier
to lose than the decision**:

| Doc | Contents |
|---|---|
| [PRD-Body](docs/PRD-Body-v0.md) | Window, animation, interaction, performance budget, leak checklist |
| [PRD-Brain](docs/PRD-Brain-v0.md) | Model calls, session loop, memory, privacy boundary, cost control |
| [PRD-Skill](docs/PRD-Skill-v0.md) | Skill contract, three-tier permissions, egress allowlist, weather skill |
| [SDD](docs/SDD-v0.md) | Tech choices, architecture, **which feature lives in which file**, build order |
| [Review record](docs/v0-review-20260911-1130.md) | A full doc review: contradictions found, claims retracted, decisions pending |

**Cross-cutting features** (spanning Body / Brain / Skill — splitting them by layer would
fall apart) get their own documents:

| Doc | Contents |
|---|---|
| [PRD · Market](docs/market/PRD-market-v0.md) | Capability boundary, data layer, indicator definitions, self-selected stocks |
| [SDD · Market](docs/market/SDD-market-v0.md) | Source selection, price adjustment, caching, degradation, module mapping |
| [Implementation status](docs/market/IMPLEMENTATION-STATUS.md) | Round-by-round record: decisions, measurements, corrections |
| [Retrospective](docs/market/RETROSPECTIVE-v0.md) | What was built, what broke, what I got wrong, what to do differently |

Market's value proposition is a **"status report", not a "trading signal"** — it explains
*what state something is in* (with objective percentiles) and **makes no predictions**.
Charts are explicitly deferred.

Some lessons that were **falsified by measurement** and then written down:

- The transparency hysteresis threshold was inverted → it became an oscillator (caught by a unit test)
- A "saved" toast was placed inside a hidden view → users thought saving had failed
- "Clear conversation" was placed in app-level settings → **an action in the wrong scope**
- The opening hint hardcoded "no skills connected" → it became a lie once skills existed
- "Eastmoney is geo-blocked for overseas IPs" → **wrong**; it's path-level anti-scraping
  triggered by request patterns. A retraction is on file.
- The MACD "minimum sample" said 60 in the docs and 34 in the code → the code silently
  produced values the docs called unreliable. Now split into two explicit tiers.

---

## Roadmap

- [x] **M0 Visible** — transparent always-on-top window, tray, procedural pixel art, idle animation
- [x] **M1 Touchable** — hit testing, click-through, dragging, click/drag threshold
- [x] **M2 Talkative** — bubble, DeepSeek streaming, interruption, memory, sessions
- [x] **M3 Capable** — skill registry, gates, weather skill, tool-calling loop
- [x] **M4 Market** — quotes, indicators, watchlist, guardrails, dual-source failover
- [ ] **M5 Durable** — debug panel (memory curve), enforced cost cap, `pnpm soak` leak run

v1+ ideas: more skills (reminders, email), charts, multi-monitor, cross-platform,
pet scaling, voice.

**Known unverified items** (honest list, see the retrospective §10):
UI rendering of the watchlist has not been eyeballed in a real window;
the corpus regression has only run its automated track;
market numbers have not been diffed against Eastmoney's own app.

---

## License

MIT — see [LICENSE](LICENSE).

This is a personal project, not affiliated with Taomee or *Seer* (赛尔号); no art, code,
or copy was used. The NONO character is an original pixel design. See [NOTICE.md](NOTICE.md).

---

*也许 nono 真的能帮我们寻找到无尽能源。*
