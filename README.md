# Browser Control Agent

A text-driven agent that controls a **real browser** to accomplish natural-language
tasks. You type a command — *"Book me a table for 2 tonight at 7pm at Nobu in SF"* —
and the agent navigates, fills forms, operates date pickers and custom dropdowns,
recovers from errors, and reports what it found.

The core design problem is grounding: how do you get a language model to act reliably
on a visual, stateful, unpredictable medium like a web page? The answer here is a
**hybrid perception layer** that gives the model both a visual representation
(annotated screenshot) and a structured text map (numbered element list), wrapped in a
ReAct-style **observe → think → act** loop with a separate verification gate to prevent
hallucinated success.

---

## Setup

**Requirements:** Node 20+, an Anthropic API key.

```bash
# 1. Install dependencies
npm install

# 2. Install the Playwright Chromium build
npm run playwright:install

# 3. Add your API key (this file is gitignored — the key never enters the repo)
cp .env.local.example .env.local
# then edit .env.local and replace "your_anthropic_api_key_here" with your key
```

### Run — two ways

**Web chat UI** (the primary interface):

```bash
npm run dev          # → http://localhost:3000
```

Type a command in the left panel. The right panel shows the live annotated browser
screenshot, updating at every step. If the agent needs information from you (contact
details for a booking, a CAPTCHA answer), an amber reply box appears above the input —
type your answer and press Reply to resume.

**CLI harness** (same agent core, no UI — useful for watching raw step output):

```bash
npm run agent -- "your command here"
```

Screenshots from each step are written to `./screenshots/`.

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | — | **Required** (or provide via UI — see below). |
| `BROWSER_HEADLESS` | `false` | Set `true` to hide the browser window. |
| `AGENT_MAX_STEPS` | `40` | Loop budget before giving up. |
| `AGENT_MODEL` | `claude-sonnet-4-6` | Main loop model (per-step decisions). |
| `PLANNER_MODEL` | `claude-sonnet-4-6` | One upfront plan call. |
| `VERIFIER_MODEL` | `claude-sonnet-4-6` | Pre-`done()` verification call. |

### API key — two ways to provide it

**Option A — `.env.local` (recommended for local use)**
```bash
cp .env.local.example .env.local
# edit .env.local and set ANTHROPIC_API_KEY=sk-ant-...
```
The key lives only on your machine, never leaves the server process. This is the
safest option.

**Option B — UI key input (for shared/deployed use)**

Click the **`🔓 add key`** button in the top-right of the log panel. A panel
drops in where you can paste your `sk-ant-...` key.

> ⚠️ **Security notice — read before using Option B:**
>
> - **Stored in `localStorage`** — not encrypted, readable by any JavaScript
>   running on the page and by browser extensions.
> - **Transmitted to the server** over HTTPS on every run. The raw key is visible
>   in plain text in your browser's DevTools → Network tab.
> - **Never persisted server-side** — used only for the duration of a single run,
>   then discarded from memory.
> - **Visible in memory** on the server process while the run is active. A memory
>   dump or misconfigured request logger could expose it.
>
> **Clear the key when you're done testing** — click the `Clear` button in the
> UI key panel. This removes it from `localStorage`. Don't leave a live API key
> sitting in your browser if you're sharing the machine or the browser profile.
>
> **For a deployed app** (e.g. Railway): set `ANTHROPIC_API_KEY` as a server
> environment variable instead. The key then never leaves the server at all, and
> the UI key input becomes an optional per-user override. This is the correct
> production pattern.
>
> **For local use on your own machine**: either option is fine — the "server" is
> your own machine and there is no network to intercept.

The two options work together: if a user provides a key in the UI it takes
precedence over the server's env var, so you can run the app with your own key
while letting others bring theirs.

---

## Verified demo scenarios

These three scenarios have been tested end-to-end. Run them in this order.

### 1. Weekend weather forecast (~$0.10, ~5 steps)

```bash
npm run agent -- "Look up the weekend weather forecast for San Francisco and summarize it"
```

**What to expect:** Navigates to weather.gov, reads the SF forecast for Saturday and
Sunday, reports temperatures and conditions. Fast, clean, always works.

---

### 2. One-way flights search (~$0.60, ~25 steps)

```bash
npm run agent -- "Search for one-way flights from SFO to JFK next Friday under \$300 on Google Flights"
```

**What to expect:** Sets trip type to One Way, fills origin (SFO) and destination (JFK)
via autocomplete, opens the date picker and selects next Friday, submits the search.
If prices appear in local currency (AED), the agent autonomously corrects to USD by
modifying the search URL. Reports cheapest flight with airline, price, times, and stops.

---

### 3. Restaurant reservation (~$0.40, ~15 steps)

```bash
# Option A — provide details upfront (agent never pauses):
npm run agent -- "Book a table for 2 tonight at 7pm at Nobu in San Francisco on Tock (exploretock.com). Name: Demo User, email: demo@example.com, phone: 415-555-0100. Stop at the review screen, do not confirm."

# Option B — natural command (agent pauses and asks for your details):
npm run agent -- "Book me a table for 2 tonight at 7pm at Nobu in San Francisco"
```

**Option B is the better demo** — the agent runs as far as it can, then pauses with:
> *"I've found a 7:00 PM table. To proceed I need your name, email, and phone number."*

Reply in the UI with something like `"Jane Smith, jane@gmail.com, 415-555-1234"` and
the loop resumes. The agent fills the guest form and stops at the review screen.

**What to expect:** Navigates to Tock, searches for Nobu San Francisco, selects date
and time, fills guest details, reaches the confirmation/review screen. Does **not**
click "Complete Reservation" — stops and reports the booking details.

> **Note on site choice:** StreetEasy, Zillow, and Apartments.com are all blocked by
> Cloudflare bot detection and will immediately give_up with a clear explanation.
> Tock and Resy load cleanly. OpenTable blocks the initial HTTP request entirely.

---

## How it works

### The perception problem

LLMs can't reliably click raw pixel coordinates, and a full DOM dump is enormous,
noisy, and full of selectors that break on framework-heavy sites. This agent uses a
**hybrid "Set-of-Marks"** approach:

1. **Walk the accessibility tree** across the main frame and every iframe, keeping only
   interactive elements (buttons, links, textboxes, comboboxes, options, etc.).
2. **Stamp each element** with a unique `data-agent-id` attribute and target it via
   `[data-agent-id="N"]`. This sidesteps the classic failure mode where generated CSS
   paths collide on nested DOMs (Google Flights resolved a naive nth-of-type path to
   *65 elements* — the stamp guarantees uniqueness by construction).
3. **Annotate a screenshot** with numbered colored boxes drawn over each element (via a
   throwaway canvas page — no native image library dependencies).

The model receives **both** — the marked screenshot *and* a text list:
```
[12] combobox "Round trip"
[15] textbox "Where from?"
[18] textbox "Departure"
```
Vision gives spatial understanding; the text list gives exact, machine-checkable
targets. The model acts by referencing a number.

### The loop (`lib/agent.ts`)

```
PLAN ─► [ OBSERVE ─► THINK ─► ACT ] × N ─► VERIFY ─► DONE
              ▲___________________│
```

- **Plan** (1 Sonnet call): resolves the goal into a `start_url`, on-page
  `success_criteria`, `notes` (relative dates resolved to absolute values), and
  `fallback_urls` — 1–2 alternative sites if the primary is blocked. All injected
  into every observation so the model always knows where to go next.
  Forced structured output via tool_choice.
- **Observe**: perception pipeline above + URL/title, open-dialog flag, console errors,
  last action result. Delivered as a `tool_result` attached to the previous
  `tool_use_id` so the model sees one coherent conversation thread.
- **Think** (1 model call): the model reasons briefly then calls **exactly one** of
  12 browser tools: `navigate`, `click`, `type`, `select_option`, `scroll`, `key`,
  `wait`, `extract`, `go_back`, `ask_user`, `done`, `give_up`.
- **Act**: Playwright executes the tool call with tiered error recovery (direct attempt
  → short retry → longer retry for navigation timeouts → surface to model to adapt).
- **Verify** (1 Sonnet call): before any `done()` is accepted, a separate model call
  grounded in the screenshot **and** raw page text confirms success criteria are
  actually met. Premature `done()` calls are rejected and the loop continues.

### Other design decisions worth noting

- **Stuck detector:** observations are hashed (URL + title + element values); 3
  consecutive unchanged observations from *mutating* actions trigger graceful give_up.
  Read-only tools (`extract`, `wait`, `ask_user`) are excluded from the count.
- **Page warning system:** every observation runs `detectPageWarnings()` which checks
  for bot/access blocks (Cloudflare, "Access Denied", "Just a moment"), HTTP errors
  (404, 500), and zero-element pages. Warnings are injected into the observation text
  *before* the element list so the model acts on them immediately — navigating to a
  fallback site or giving up — rather than wasting steps on a blocked page.
- **Cost controls:** system prompt + tool schemas carry `cache_control: ephemeral` so
  the static prefix isn't re-billed each step. Screenshots are pruned to the last 2 in
  conversation history — without this, image tokens grow quadratically with step count.
- **Interactive `ask_user`:** agent pauses, emits an event with a `requestId`, the UI
  shows an amber reply box, the answer POSTs to `/api/agent/reply`, the in-memory
  registry resolves the paused Promise, and the loop continues with the answer injected
  as a `tool_result`.
- **Concurrency guard:** the browser is a module-level singleton. Concurrent
  `runAgent()` calls are serialized by an in-process Promise-chain mutex.

### Project layout

```
app/
  page.tsx                 chat UI (log panel + live browser view + reply box)
  api/agent/route.ts       NDJSON streaming endpoint — runs the agent loop
  api/agent/reply/route.ts receives ask_user replies from the UI
lib/
  agent.ts                 the loop: plan, observe/think/act, verify, recovery
  browser.ts               Playwright wrapper + the observe() perception pipeline
  tools.ts                 12 browser tool schemas (Anthropic format + Zod validation)
  ask-registry.ts          pause/resume bridge for ask_user
scripts/
  run-agent.mts            CLI harness (same agent core, writes screenshots to disk)
  debug-extract.mts        check element detection on any URL — no API calls
  debug-combobox.mts       verify custom dropdown interaction — no API calls
```

---

## Model cost analysis: Opus vs. Sonnet

The loop model fires every step with a growing history and two screenshots. Plan and
verify are single short calls. So the question was: **does the loop actually need Opus?**

The same flights scenario was run end-to-end on both:

| | **Opus** (`claude-opus-4-8`) | **Sonnet** (`claude-sonnet-4-6`) |
|---|---|---|
| Trip type → SFO → JFK → date picker → search | ✅ | ✅ identical element choices |
| Detected AED prices, recovered to USD | ✅ constructed USD URL preserving flight params | ✅ derived the same fix independently |
| Outcome | ✅ verified `done()` in 25 steps | matched Opus step-for-step until billing interrupted one step from done |
| Estimated cost per run | ~$6–9 | ~$1.50–2.50 |

**Finding:** Sonnet matched Opus on a genuinely complex SPA — including a non-trivial
autonomous error recovery — at ~5× lower cost. The default is Sonnet. Opus is an opt-in
escalation via `AGENT_MODEL=claude-opus-4-8` for tasks where Sonnet visibly struggles.

---

## Known limitations

Deliberate scope decisions, not accidents:

- **Bot-protected sites.** StreetEasy, Zillow, and Apartments.com block headless
  Chromium with Cloudflare challenges. The page warning system detects this immediately
  (title/URL pattern matching) and signals the model to navigate to a fallback site
  rather than wasting steps. Sites that load cleanly: Tock, Resy, Redfin, Google
  Flights, weather.gov. No proxy rotation or fingerprint evasion — out of scope.
- **CAPTCHAs.** Detected and escalated to the user via `ask_user`. Not solved.
- **Logins / credentials.** No credential storage. If a task requires login, the agent
  asks the user via `ask_user` or gives up cleanly.
- **Real payments.** Hard-stopped in the system prompt — the agent stops at the
  confirmation/review screen and reports what it found. It will not submit payment
  details or complete a real transaction.
- **Slider-based filters.** Range sliders are unreliable to operate via set-of-marks.
  The agent satisfies numeric constraints (e.g. "under $300") by finding qualifying
  visible results rather than dragging a slider handle.
- **Concurrency.** One run at a time per process. A second request queues until the
  first finishes. Production use would need a browser-context pool and a shared
  (e.g. Redis) ask_user registry.
- **One active tab.** The agent acts on the active page. Multi-tab flows are not managed.
