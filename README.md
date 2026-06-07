# Browser Control Agent

A text-driven agent that controls a **real browser** to accomplish natural-language tasks.
You type a command — *"Search for one-way flights from SFO to JFK next Friday under $300"* —
and the agent navigates, fills forms, operates date pickers and custom dropdowns, recovers
from errors, and reports what it found.

The core design problem is **grounding**: how do you get a language model to act reliably on
a visual, stateful, unpredictable medium like a web page? The answer here is a hybrid
perception layer that gives the model both a visual representation (annotated screenshot) and
a structured text map (numbered element list), wrapped in a ReAct-style
**observe → think → act** loop with a separate verification gate to prevent hallucinated success.

---

## Demo

### 1 · Weekend weather forecast
*~5 steps · fast · always works*

[![Watch weather forecast demo](https://cdn.loom.com/sessions/thumbnails/62bd98da682e4ac180faed1976dda3b5-with-play.gif)](https://www.loom.com/share/62bd98da682e4ac180faed1976dda3b5)

The agent navigates directly to the weather service, reads the weekend forecast for San
Francisco, and returns a structured summary with temperatures, conditions, and precipitation.

---

### 2 · Flight search — no qualifying flights, reports cheapest available
*~12 steps · Kayak deep link, complex SPA navigation*

[![Watch flight search - no matching flights demo](https://cdn.loom.com/sessions/thumbnails/bbcdad16cb504ea1832bbe720357e4fd-with-play.gif)](https://www.loom.com/share/bbcdad16cb504ea1832bbe720357e4fd)

No qualifying flights under the budget exist for this route and date. Rather than giving up,
the agent reports the **cheapest available option** with full details — airline, price, times,
stops — so the user can make an informed decision. A useful near-miss beats a silent failure.

The planner constructs a **Kayak deep link** with origin, destination, date, and sort order
pre-encoded — the agent lands directly on a sorted results page rather than filling forms.

---

### 3 · Flight search — successful, flight found under budget
*~10 steps · verifies price constraint before calling done()*

[![Watch successful flight check demo](https://cdn.loom.com/sessions/thumbnails/279b88fa8f0849f29edc4a2dfc8c2a72-with-play.gif)](https://www.loom.com/share/279b88fa8f0849f29edc4a2dfc8c2a72)

A qualifying flight exists. The agent finds it, extracts airline, price, departure/arrival
times, and stop count, then calls `done()`. The verifier confirms success criteria are met
before the result is accepted.

---

### 4 · Graceful failure — restaurant does not exist in requested city
*~8 steps · clear give_up with alternatives*

[![Watch graceful failure demo](https://cdn.loom.com/sessions/thumbnails/cf6fa65701504e62b50ce789f99dd53c-with-play.gif)](https://www.loom.com/share/cf6fa65701504e62b50ce789f99dd53c)

When asked to book at a restaurant that has no location in the requested city, the agent
checks Resy, verifies the restaurant doesn't exist (via a quick existence check), then gives
up with a clear explanation and concrete alternatives — rather than looping indefinitely
across blocked and empty platforms.

A confident *"this place doesn't exist in San Francisco"* is more useful than 40 wasted steps.

---

### 5 · Restaurant booking — ask_user clarification + successful booking
*~15 steps · clarification gate, Resy deep link, form filling, pauses for guest details*

[![Watch ask_user + restaurant booking demo](https://cdn.loom.com/sessions/thumbnails/2ffdda97807a4a2285340664376defb3-with-play.gif)](https://www.loom.com/share/2ffdda97807a4a2285340664376defb3)

When the goal is underspecified — *"Book me a table for 2 tonight at 7pm in San Francisco"*
with no restaurant name — the agent fires a **clarification gate before the browser even
opens**. An amber reply box appears, the user types the restaurant name, and the planner
**re-runs with the enriched goal** to generate a Resy deep link with date, party size, and
restaurant name pre-encoded. The browser then opens directly on the results for the correct
restaurant.

The agent proceeds through the booking flow (selects time slot, fills in party size) and
pauses again when it needs personal details to complete the reservation — name, email, phone —
rather than fabricating or skipping them.

---

## Setup

**Requirements:** Node 20+, an Anthropic API key.

```bash
# 1. Install dependencies
npm install

# 2. Install the Playwright Chromium build
npm run playwright:install

# 3. Add your API key
cp .env.local.example .env.local
# Edit .env.local and set ANTHROPIC_API_KEY=sk-ant-...
```

### Run — two ways

**Web chat UI** (primary interface):

```bash
npm run dev    # → http://localhost:3000
```

Type a command in the left panel. The right panel shows the live annotated browser
screenshot, updating at every step. If the agent needs information from you (which restaurant
to book, contact details for a reservation, a CAPTCHA answer), an amber reply box appears
above the input — type your answer and press Reply to resume.

**CLI harness** (same agent core, no UI):

```bash
npm run agent -- "your command here"
```

Screenshots from each step are written to `./screenshots/`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required.** Or provide via UI (see below). |
| `BROWSER_HEADLESS` | `false` | Set `true` to hide the browser window. |
| `AGENT_MAX_STEPS` | `40` | Loop budget before giving up. |
| `AGENT_MODEL` | `claude-sonnet-4-6` | Main loop model — fires every step. |
| `PLANNER_MODEL` | `claude-sonnet-4-6` | One upfront planning call. |
| `VERIFIER_MODEL` | `claude-3-5-haiku-20241022` | Pre-`done()` verification — cheaper model, fires per attempt. |

### API key — two ways to provide it

**Option A — `.env.local` (recommended for local use)**

```bash
cp .env.local.example .env.local
# Set ANTHROPIC_API_KEY=sk-ant-...
```

The key lives only on your machine, never leaves the server process.

**Option B — UI key input (for shared / deployed use)**

Click **`🔓 Add key`** in the top-right of the log panel.

> ⚠️ **Security notice:**
> - Stored in `localStorage` — readable by JS and browser extensions.
> - Transmitted to the server over HTTPS on every run; visible in DevTools → Network.
> - **Never persisted server-side** — discarded after each run.
> - For a deployed app, set `ANTHROPIC_API_KEY` as a server env var instead.
> - **Clear the key when done** using the Clear button in the key panel.

---

## Test scenarios

These scenarios cover all five demo cases above. Run them to exercise the full pipeline.

### 1. Weekend weather forecast

```
Look up the weekend weather forecast for San Francisco
```

**Expected:** Navigates to a weather service, reads the SF weekend forecast, returns
temperatures and conditions for Saturday and Sunday.

[▶ Watch demo](https://www.loom.com/share/62bd98da682e4ac180faed1976dda3b5)

---

### 2. Flight search — no qualifying flights

```
Search for one-way flights from SFO to JFK next Friday under $300
```

**Expected:** The planner constructs a Kayak deep link (`kayak.com/flights/SFO-JFK/[date]?sort=price_a`)
with all parameters pre-encoded. If no flights exist under the price limit, the agent reports
the **cheapest available option** with full details rather than silently failing.

[▶ Watch demo](https://www.loom.com/share/bbcdad16cb504ea1832bbe720357e4fd)

---

### 3. Flight search — successful

```
Search for one-way flights from SFO to LAX this weekend under $200
```

**Expected:** Finds a qualifying flight, extracts airline, price, and schedule, calls `done()`
with a full summary. The verifier confirms the price constraint is satisfied before accepting
the result.

[▶ Watch demo](https://www.loom.com/share/279b88fa8f0849f29edc4a2dfc8c2a72)

---

### 4. Restaurant booking — restaurant does not exist in city

```
Book me a table for 2 tonight at 7pm at Nobu in San Francisco
```

**Expected (correct behaviour):** Nobu does not have a San Francisco location. The agent
searches Resy, confirms no listing exists, and gives up with a clear explanation:

> *"Nobu does not appear to have a San Francisco location. I checked Resy without finding
> a listing. The nearest Nobu locations are in Palo Alto and Los Angeles."*

[▶ Watch demo](https://www.loom.com/share/cf6fa65701504e62b50ce789f99dd53c)

---

### 5. Restaurant booking — underspecified goal triggers clarification, then books

```
Book me a table for 2 tonight at 7pm in San Francisco
```

**Expected:** No restaurant name in the goal. The planner detects the missing info and fires a
clarification gate **before the browser opens**. An amber reply box appears:

> *"Which restaurant would you like to book?"*

Type a restaurant name (e.g. `Nari`). The planner re-runs with the enriched goal and generates
a Resy deep link with restaurant, date, and party size pre-filled. The agent navigates directly
to results for that restaurant and proceeds with the booking flow, pausing again for personal
details when it reaches the reservation form:

> *"I've found availability. To complete the reservation I need your name, email, and phone number."*

Reply in the amber box (e.g. `Jane Smith, jane@example.com, 415-555-1234`) and the loop
resumes. The agent fills the guest form and stops at the review screen — it does **not**
click Confirm.

[▶ Watch demo](https://www.loom.com/share/2ffdda97807a4a2285340664376defb3)

---

## How it works

### The perception problem

LLMs can't reliably click raw pixel coordinates, and a full DOM dump is enormous, noisy, and
full of selectors that break on framework-heavy sites. This agent uses a **hybrid
Set-of-Marks** approach:

1. **Walk the accessibility tree** across the main frame and every iframe, keeping only
   interactive elements (buttons, links, textboxes, comboboxes, selects, etc.).
2. **Stamp each element** with a unique `data-agent-id` attribute. Targeting by stamp
   sidesteps the classic failure mode where generated CSS paths collide on nested DOMs —
   Google Flights resolved a naive `nth-of-type` path to *65 elements*; the stamp guarantees
   uniqueness by construction.
3. **Annotate a screenshot** with numbered colored boxes drawn over each element via a
   throwaway canvas page — no native image library dependencies.

The model receives **both**: the marked screenshot *and* a structured text list:

```
[12] combobox "Round trip"
[15] textbox "Where from?"
[18] textbox "Departure"
```

Vision gives spatial understanding; the text list gives exact, machine-checkable targets.
The model acts by referencing a number.

### The loop (`lib/agent.ts`)

```
PLAN ─► CLARIFY? ─► [ OBSERVE ─► THINK ─► ACT ] × N ─► VERIFY ─► DONE
                          ▲___________________│
```

| Stage | Detail |
|---|---|
| **Plan** | 1 Sonnet call. Resolves the goal into `start_url`, on-page `success_criteria`, `notes` (relative dates → absolute values), `fallback_urls`, and optionally `clarification_needed`. Forced structured output via `tool_choice`. |
| **Clarify** | If `clarification_needed` is set, the amber reply box appears **before the browser opens**. The user's answer is appended to the goal and the planner re-runs to generate the correct deep-link URL. Browser only launches after clarification is resolved. |
| **Observe** | Perception pipeline + URL/title, open-dialog flag, console errors, last action result. Delivered as a `tool_result` so the model sees one coherent conversation thread. |
| **Think** | 1 model call. Reasons briefly, then calls exactly one of 12 browser tools: `navigate` `click` `type` `select_option` `scroll` `key` `wait` `extract` `go_back` `ask_user` `done` `give_up`. |
| **Act** | Playwright executes the tool call. Tiered recovery: direct attempt → short retry → longer retry for navigation timeouts → surface to model. |
| **Verify** | Before any `done()` is accepted, a separate model call grounded in the screenshot **and** raw page text confirms success criteria are actually met. Premature `done()` calls are rejected and the loop continues. |

### Design decisions

**Deep-link URL strategy.** The planner builds the deepest possible URL before the browser
opens, encoding all known parameters directly:

| Use case | Template |
|---|---|
| Flights | `kayak.com/flights/[IATA1]-[IATA2]/[YYYY-MM-DD]?sort=price_a` — always USD, pre-sorted cheapest |
| Restaurant (Resy) | `resy.com/cities/[city-slug]/search?date=[YYYY-MM-DD]&seats=[N]&query=[Name]` |
| Restaurant (Tock) | `exploretock.com/city/[slug]/search?city=...&latlng=[LAT],[LON]&date=...&time=...&party=N` — `latlng` required to override IP geolocation |
| Weather | `weather.com/weather/tenday/l/[City]+[State]+United+States` |

This eliminates most form-filling steps: the agent lands on a pre-filtered results page
rather than navigating through multi-step wizards.

**Clarification gate.** The planner has a structural `clarification_needed` field (not just a
prompt instruction). When populated, a gate in `_runAgent` fires before `launchBrowser()` —
the amber reply box appears, the user answers, and `planTask` re-runs with the enriched goal
to regenerate the correct deep-link URL. This solves two problems: (1) prevents the agent
from picking a random result when the goal is underspecified, and (2) avoids launching a
browser that sits idle and goes stale during a 30+ second wait.

**Restaurant existence check.** After Resy returns no results for a restaurant search, the
agent checks whether the restaurant has any presence before trying fallback platforms. If it
doesn't exist in the city, it gives up immediately with alternatives rather than cycling
through 2–3 booking sites. Give up after 2 sources maximum even if the restaurant does exist
on none of them.

**Stuck detector.** Observations are hashed (URL + title + element values). Three consecutive
unchanged hashes from *mutating* actions trigger graceful `give_up`. Read-only tools
(`extract`, `wait`, `ask_user`) are excluded from the count.

**Semantic loop detection.** The system prompt instructs the agent to `give_up` after
exhausting 2–3 distinct sources without finding the target, and to abandon blocked sites
immediately rather than retrying them with different URLs. This prevents circular search
behaviour when a business doesn't exist or a site is access-controlled.

**Context pruning.** Old observations are compressed rather than dropped: the interactive
element list (500–1500 tokens) is removed, but the step header, URL, page title, and action
feedback are preserved. This gives the agent episodic memory (it can see "I searched Resy at
step 3 and found no results") while keeping history cost bounded. Without pruning, token
usage grows O(n²) with step count.

**Prompt caching.** System prompt and tool schemas carry `cache_control: ephemeral`. The
static prefix (~3000 tokens) is cached after the first step and billed at 10× lower rate for
all subsequent steps.

**Cost-tiered models.** The main loop uses Sonnet (quality matters per step). The verifier
uses Haiku (it's a simple yes/no grounded check — Haiku handles it at 4× lower cost per
call). The planner stays on Sonnet — using Haiku here caused silent failures (empty `startUrl`,
generic fallback criteria) that wasted many downstream steps.

**Interactive `ask_user`.** Agent pauses, emits an event with a `requestId`, the UI shows an
amber reply box, the answer POSTs to `/api/agent/reply`, an in-memory registry resolves the
paused Promise, and the loop continues with the answer injected as a `tool_result`. Used for
two distinct cases: (1) up-front clarification (missing goal info, fires before browser
launches) and (2) mid-task information requests (contact details, CAPTCHA answers, etc.).

**Concurrency guard.** The browser is a module-level singleton. Concurrent `runAgent()`
calls are serialized by an in-process Promise-chain mutex.

**Cookie and consent banners.** `dismissOverlays()` runs automatically before every `observe()`
call. It targets 11 specific consent-button selectors ("Accept all", "Accept cookies", "I agree",
"Got it", "No thanks", etc.) and clicks the first visible match. The selector list is intentionally
narrow — generic "OK"/"Close" buttons are excluded because they also close app-owned dropdowns and
date pickers. The system prompt provides a fallback instruction for the model to handle any banner
the heuristic misses.

**A/B tested layouts.** The `data-agent-id` stamp is re-derived from scratch on every `observe()`:
elements are identified by their accessibility role and name, not by CSS path or position. A layout
change between A/B variants simply produces a different element list, which the model reads fresh the
next turn — no special case needed. This also solves the deeper issue: on Google Flights, a naive
`nth-of-type` CSS path resolves to 65 elements; the stamp guarantees uniqueness regardless of DOM structure.

**Loading states and page transitions.** `waitForSettle()` fires after every navigation, click, key
press, and go_back. It attempts `networkidle` (2 s timeout) and falls back to `domcontentloaded`
gracefully — some sites keep long-poll XHR connections open indefinitely, which would cause
`networkidle` to never resolve. Tier 3 of `executeWithRecovery()` adds a 2 s delay and a retry
specifically for navigation timeouts. The system prompt additionally instructs the model to call
`wait` and re-observe after form submissions before assuming the result has loaded.

**Stale browser recovery.** `launchBrowser()` checks `browser.isConnected()` before reusing
the existing page. If the window was closed manually or crashed between runs, it cleans up
the stale reference and relaunches rather than surfacing a `page.evaluate` error.

### Project layout

```
app/
  page.tsx                 Chat UI — log panel, live browser view, reply box (responsive)
  api/agent/route.ts       NDJSON streaming endpoint — runs the agent loop
  api/agent/reply/route.ts Receives ask_user replies from the UI
lib/
  agent.ts                 The loop: plan, clarify, observe/think/act, verify, recovery, pruning
  browser.ts               Playwright wrapper + observe() perception pipeline
  tools.ts                 12 browser tool schemas (Anthropic format + Zod validation)
  ask-registry.ts          Pause/resume bridge for ask_user
scripts/
  run-agent.mts            CLI harness — same agent core, writes screenshots to disk
  debug-extract.mts        Check element detection on any URL — no API calls
  debug-combobox.mts       Verify custom dropdown interaction — no API calls
```

---

## Cost analysis

### Per-run cost (after optimisations)

| Scenario | Steps | Estimated cost |
|---|---|---|
| Weather lookup | ~5 | ~$0.05 |
| Flight search (no match, reports nearest) | ~12 | ~$0.20–0.30 |
| Flight search (successful) | ~10 | ~$0.15–0.25 |
| Restaurant (exists, with clarification + booking) | ~15 | ~$0.20–0.30 |
| Restaurant (not found, gives up) | ~8 | ~$0.10 |

### Sonnet vs. Opus (main loop model)

The same flights scenario was run end-to-end on both:

| | **Opus** (`claude-opus-4-8`) | **Sonnet** (`claude-sonnet-4-6`) |
|---|---|---|
| SFO → JFK form filling | ✅ | ✅ identical element choices |
| AED → USD autonomous recovery | ✅ constructed USD URL preserving flight params | ✅ derived the same fix independently |
| Outcome | ✅ verified `done()` in 25 steps | Matched Opus step-for-step |
| Estimated cost per run | ~$6–9 | ~$0.20–0.30 |

**Finding:** Sonnet matched Opus on a genuinely complex SPA — including unscripted currency
recovery — at ~20× lower cost. Opus is available as opt-in via `AGENT_MODEL=claude-opus-4-8`
for tasks where Sonnet visibly struggles.

### Cost optimisations applied

| Optimisation | Saving |
|---|---|
| `cache_control` on system prompt + tools | ~3000 tokens billed at cache-read rate (10×) cheaper from step 2 onward |
| Observation text pruning (strip element lists, keep headers) | Converts O(n²) history growth → O(n) |
| Keep 1 screenshot in history (not 2) | Saves ~1365 tokens/step for all but the latest step |
| Haiku for verifier (not planner) | ~4× cheaper on the verification call vs. Sonnet |
| `max_tokens: 1000` for agent decisions | Tool calls are short; reduces output billing by ~33% |
| Deep-link URL strategy | Eliminates 5–10 form-filling steps per run, reducing total step count |
| Clarification gate before browser launch | Prevents stale-browser idle time and wasted navigation steps |

---

## Known limitations

Deliberate scope decisions, not accidents:

- **Bot-protected sites.** Cloudflare challenges on StreetEasy, Zillow, Apartments.com are
  detected immediately (title/URL pattern matching) and the agent navigates to a fallback
  rather than wasting steps. Sites that load cleanly: Resy, Tock, Kayak, weather.com.
  No proxy rotation or fingerprint evasion — out of scope.
- **CAPTCHAs.** Detected and escalated to the user via `ask_user`. Not solved.
- **Logins / credentials.** No credential storage. If a task requires login the agent asks
  via `ask_user` or gives up cleanly.
- **Real payments.** Hard-stopped in the system prompt — agent stops at the review screen.
  Will not submit payment details or complete a real transaction.
- **Slider-based filters.** Range sliders are unreliable via set-of-marks. The agent
  satisfies numeric constraints (e.g. "under $300") by finding qualifying visible results
  rather than dragging a slider.
- **Concurrency.** One run at a time per process. A second request queues until the first
  finishes. Production use needs a browser-context pool and a shared ask_user registry.
- **One active tab.** The agent acts on the active page. Multi-tab flows are not managed.
