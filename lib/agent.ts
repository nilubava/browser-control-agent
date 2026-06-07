/**
 * lib/agent.ts
 *
 * Core agent loop — ReAct-style observe → think → act, fully wired to Claude.
 *
 * Pipeline:
 *   1. planTask()        — one cheap Sonnet call. Resolves the goal into a
 *                          start URL, concrete success criteria, and notes
 *                          (relative dates → absolute, key params extracted).
 *   2. main loop         — agent model (Sonnet by default) with tool use. Each turn: observe → send
 *                          (system + goal + plan + compact history + annotated
 *                          screenshot + element list) → execute tool call →
 *                          feed result back as the next tool_result.
 *   3. stuck detector    — hash each observation; give_up after 3 repeats.
 *   4. verifyCompletion()— when the model calls done(), a Sonnet check confirms
 *                          the success criteria are actually visible before we
 *                          report success (guards against hallucinated success).
 *   5. tiered recovery   — executeWithRecovery() retries transient failures
 *                          before surfacing them to the model.
 *
 * Context cost control: the system prompt + tools are cached (static prefix),
 * and old screenshots are pruned from history so token usage stays bounded.
 */

import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import {
  launchBrowser,
  closeBrowser,
  observe,
  navigate,
  clickElement,
  typeIntoElement,
  selectOption,
  scroll,
  pressKey,
  goBack,
  extractText,
  getVisibleText,
  type Observation,
  type ActionResult,
  type PageElement,
} from "./browser";
import {
  ANTHROPIC_TOOLS,
  parseToolCall,
  type ToolCall,
} from "./tools";

// ---------------------------------------------------------------------------
// Models (overridable via env)
// ---------------------------------------------------------------------------

const AGENT_MODEL    = process.env.AGENT_MODEL    ?? "claude-sonnet-4-6";
// Planner: one call at run start — keep on Sonnet for reliability (cost is negligible, ~$0.004/run).
// Verifier: may fire multiple times and sends a screenshot each time — Haiku is 4× cheaper there.
const PLANNER_MODEL  = process.env.PLANNER_MODEL  ?? "claude-sonnet-4-6";
const VERIFIER_MODEL = process.env.VERIFIER_MODEL ?? "claude-3-5-haiku-20241022";

// ---------------------------------------------------------------------------
// Anthropic client (lazy — validates the key without crashing at import time)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

// If a per-request key is supplied it gets its own fresh client (not cached)
// so it never bleeds into another user's run. The cached singleton is only used
// when falling back to the server-side env var.
function getClient(apiKey?: string): Anthropic {
  if (apiKey) {
    return new Anthropic({ apiKey });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "No API key found. Either set ANTHROPIC_API_KEY in .env.local " +
      "or enter your key in the UI settings."
    );
  }
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ---------------------------------------------------------------------------
// In-process run lock — serializes concurrent runAgent() calls.
//
// The browser (lib/browser.ts) is a module-level singleton: one Page, one
// element registry, one screenshot buffer. Two simultaneous runs would
// interleave navigations and corrupt each other's registry.
//
// This mutex queues callers so only one run is active at a time. It does NOT
// help across multiple server processes — that requires a context-per-session
// pool and is out of scope for a local demo.
// ---------------------------------------------------------------------------

let _runLock: Promise<void> = Promise.resolve();

function acquireLock(): Promise<() => void> {
  let release!: () => void;
  // The incoming run waits for the current tail of the chain.
  // Its own "done" promise becomes the new tail so the next run waits for it.
  const done = new Promise<void>((resolve) => { release = resolve; });
  const entry = _runLock.then(() => release);
  _runLock = _runLock.then(() => done);
  return entry;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentOptions {
  goal: string;
  /** Optional fallback; the planner computes the real criteria. */
  successCriteria?: string;
  maxSteps?: number;
  onStep?: (event: StepEvent) => void;
  /**
   * Interactive bridge for ask_user. When provided, the loop pauses on
   * ask_user, awaits the user's reply, injects it, and continues. When omitted
   * (e.g. the CLI harness), ask_user simply suspends the run.
   */
  onAskUser?: (question: string) => Promise<string>;
  /**
   * Anthropic API key supplied by the user at runtime.
   * Takes precedence over the ANTHROPIC_API_KEY environment variable so each
   * user can fund their own usage when the app is shared/deployed.
   * Never logged or persisted server-side — used only for this run.
   */
  apiKey?: string;
}

export interface StepEvent {
  type: "plan" | "observe" | "action" | "ask_user" | "done" | "give_up" | "error";
  step: number;
  message: string;
  screenshotBase64?: string;
  elements?: PageElement[];
  summary?: string;
  /** Set on ask_user events so the client knows where to POST the reply. */
  requestId?: string;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  confirmation?: string;
  steps: number;
  finalScreenshotBase64?: string;
}

interface Plan {
  startUrl: string;
  successCriteria: string;
  notes: string;
  fallbackUrls: string[];
  /** Set by the planner when essential info is missing. The agent asks the user
   *  this question before navigating anywhere. */
  clarificationNeeded?: string;
}

// ---------------------------------------------------------------------------
// System prompt — deliberately tight. Static so it can be cached.
// Goal / plan / step budget are injected per-turn in the observation text.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a browser automation agent. You control a REAL web browser to accomplish a user's goal.

Every turn you receive:
- A screenshot of the current page. Interactive elements are outlined with numbered colored marks.
- A text list of those numbered elements: [number] role "name" (metadata).
- The result of your previous action.

To act, think briefly (1-2 sentences), then call EXACTLY ONE tool. Reference elements by their number.

Rules:
- Element numbers are valid ONLY for the current observation. They change every turn — never reuse a number from a previous turn.
- Use select_option only for native <select> dropdowns (marked "native-select"). For custom dropdowns, click the trigger, then click the option that appears.
- If a cookie/consent banner or modal blocks the page, dismiss it first (click its accept/close button, or press Escape).
- After submitting a form or search, the page needs time. Use "wait", then re-observe before assuming the result loaded.
- Call done() only when the goal is genuinely achieved AND visible on the page. Put every relevant detail in the summary (confirmation numbers, prices, times, addresses).
- Call give_up() if you are truly blocked (CAPTCHA, login wall, repeated failures). A clear explanation of what failed is a valid and useful outcome — better than looping or pretending success.
- If a site returns "Access Denied", 403, or any block page — abandon it immediately and move to the next source. Do NOT retry the same site with a different URL or query.
- If a search on a site returns zero results for the specific business/item in the correct location, that site has no listing — move on immediately. Do NOT retry with different search terms or URLs on the same site.
- If a specific business, restaurant, flight, or item cannot be found after checking 2–3 distinct sources, call give_up() immediately. Do NOT keep searching. "This restaurant does not appear to exist or is not bookable online" is a perfectly useful result — tell the user clearly and suggest what they could try manually.
- For restaurant bookings: navigate directly to the Resy search URL with the restaurant name, date, and party size as query params (e.g. resy.com/cities/san-francisco-ca/search?date=2026-06-07&seats=2&query=Che+Fico). If the restaurant appears in results, proceed with booking. If Resy returns no results: do ONE Google search (google.com/search?q=[Restaurant]+restaurant+[City]) to confirm whether the restaurant exists in that city at all. If Google confirms no location → give_up() immediately with a clear explanation. If Google confirms it exists but isn't on Resy → try Tock. Never try OpenTable — it blocks all automated access and is never useful.
- For flight searches: prefer a deep-link URL that lands directly on results rather than filling in a search form from scratch. Kayak format: https://www.kayak.com/flights/[ORIGIN]-[DEST]/[YYYY-MM-DD]?sort=price_a — use this if the planner's start_url is just a homepage and you know all the parameters.
- For flight/product searches with a price constraint: Kayak sorted by price is one authoritative source — do NOT cross-check the same route on Google Flights or other sites. If the sorted results clearly show the cheapest option, that is the answer. Read the prices, state whether any meet the budget, report the cheapest available, and call done(). Different sites price the same route identically; a second source adds steps without adding information.
- Use ask_user() when you need information only the user can provide: CAPTCHAs, login credentials, personal contact details for bookings (name, email, phone), payment info, or genuinely ambiguous requests. Ask in one message and be specific about exactly what you need.
- For restaurant or hotel bookings where the specific business name is not stated, call ask_user() IMMEDIATELY — before navigating anywhere. Do NOT browse platforms and pick a restaurant on the user's behalf. Ask: "Which restaurant would you like to book?" and wait for the answer before proceeding. The user's choice of restaurant is not yours to make.
- Be efficient with your step budget. Always terminate explicitly with done() or give_up().

IMPORTANT: This is a demo. Do NOT complete real purchases, reservations, or transactions.

Two distinct checkout situations — handle them differently:

1. FORM NOT YET FILLED (e.g. Tock checkout with empty First Name / Last Name / Email / Phone fields):
   - Do NOT call done() here. The task is not complete yet.
   - Call ask_user() to request the personal details: "To complete the reservation I need your First Name, Last Name, Email, and Phone Number."
   - Once the user replies, fill in those fields.
   - Stop BEFORE clicking the final "Confirm" / "Reserve Now" / "Complete" button.
   - Then call done() with a full summary of what is shown on the review screen.

2. FORM ALREADY COMPLETE or LOGIN-BASED (e.g. Resy modal that just shows booking details with a "Reserve Now" button — no unfilled fields):
   - Call done() immediately. Report the full details visible (restaurant, date, time, party size, price, cancellation policy).
   - Do NOT click the final confirm button under any circumstances.`;

// Cache the static prefix (tools + system) so it is not re-billed every turn.
const SYSTEM_BLOCKS: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

// ---------------------------------------------------------------------------
// Orchestration tools (planning + verification) — separate from browser tools
// ---------------------------------------------------------------------------

const PLAN_TOOL: Anthropic.Tool = {
  name: "submit_plan",
  description: "Submit the execution plan for the user's goal.",
  input_schema: {
    type: "object",
    properties: {
      start_url: {
        type: "string",
        description: "The full URL of the best site to begin on (e.g. https://www.opentable.com).",
      },
      success_criteria: {
        type: "string",
        description:
          "What must be VISIBLE on the page when the task is done. On-page substance only — " +
          "no actions the agent performs (no 'summarized'/'reported to user'), and no hard-coded " +
          "calendar dates if the site labels things by weekday or relative terms. " +
          "For constraints like price/time limits, the criterion is that QUALIFYING results are " +
          "VISIBLE (e.g. 'flights at or under $300 are shown among the results') — do NOT require " +
          "the list to be mechanically filtered so every other result is hidden, since that depends " +
          "on a specific UI control that may not exist or matter.",
      },
      notes: {
        type: "string",
        description:
          "Key parameters extracted from the goal, with all relative dates/times resolved to absolute values.",
      },
      fallback_urls: {
        type: "array",
        items: { type: "string" },
        description:
          "1–2 alternative URLs to try if the primary site is blocked or inaccessible. " +
          "e.g. if start_url is resy.com, fallback might be [opentable.com, exploretock.com].",
      },
      clarification_needed: {
        type: "string",
        description:
          "If essential information is missing from the goal (e.g. no restaurant name for a " +
          "booking, no origin city for a flight), set this to the exact question to ask the user " +
          "BEFORE any navigation. The agent will pause, show this question to the user, wait for " +
          "their answer, and then proceed. Leave empty or omit if the goal has all needed info. " +
          "Examples: 'Which restaurant would you like to book?' or " +
          "'Which city are you flying from, and what date?'",
      },
    },
    required: ["start_url", "success_criteria", "notes", "fallback_urls"],
  },
};

const VERIFY_TOOL: Anthropic.Tool = {
  name: "submit_verification",
  description: "Report whether the success criteria are visibly met on the current page.",
  input_schema: {
    type: "object",
    properties: {
      met: { type: "boolean", description: "True ONLY if there is concrete on-page evidence." },
      reason: { type: "string", description: "Brief justification citing what is (or isn't) on the page." },
    },
    required: ["met", "reason"],
  },
};

// ---------------------------------------------------------------------------
// Agent entry point
// ---------------------------------------------------------------------------

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  // Serialize runs — the browser is a single-instance singleton. If two requests
  // arrive concurrently the second queues here until the first finishes.
  const release = await acquireLock();
  try {
    return await _runAgent(options);
  } finally {
    release();
  }
}

async function _runAgent(options: AgentOptions): Promise<AgentResult> {
  const { goal, maxSteps = 40, onStep, onAskUser, apiKey } = options;
  const emit = (e: StepEvent) => onStep?.(e);

  // Validate the API key before opening a browser (fail fast, no orphaned process).
  // Per-request key takes precedence over the server env var.
  const client = getClient(apiKey);

  // ── 1. PLAN ───────────────────────────────────────────────────────────────
  let plan = await planTask(client, goal, options.successCriteria);
  const plannerFellBack = !plan.startUrl;
  emit({
    type: plannerFellBack ? "error" : "plan",
    step: 0,
    message: plannerFellBack
      ? `Planner failed — using defaults. Agent will determine the start URL.\n  Criteria: ${plan.successCriteria}`
      : `Start: ${plan.startUrl}\n  Success: ${plan.successCriteria}\n  Notes: ${plan.notes}`,
  });

  // ── CLARIFICATION GATE ────────────────────────────────────────────────────
  // Ask BEFORE launching the browser — no point opening Chrome while waiting
  // for the user to type. After getting the answer, re-plan so the planner
  // can build a proper deep-link URL that includes the user's answer
  // (e.g. resy.com/.../search?query=Nari rather than the generic city page).
  if (plan.clarificationNeeded) {
    emit({ type: "ask_user", step: 0, message: plan.clarificationNeeded });
    if (onAskUser) {
      const answer = await onAskUser(plan.clarificationNeeded);
      emit({ type: "action", step: 0, message: `↳ ${answer}` });

      // Re-plan with the enriched goal so the planner generates the right URL.
      const enrichedPlan = await planTask(
        client,
        `${goal}\nUser specified: ${answer}`,
        options.successCriteria,
      );
      if (enrichedPlan.startUrl) {
        plan = { ...enrichedPlan, clarificationNeeded: undefined };
        emit({
          type: "plan", step: 0,
          message: `Plan updated: ${plan.startUrl}\n  Success: ${plan.successCriteria}\n  Notes: ${plan.notes}`,
        });
      }
    } else {
      // CLI harness — surface and stop.
      return { success: false, summary: `Needs clarification: ${plan.clarificationNeeded}`, steps: 0 };
    }
  }

  // Browser launch deferred until after clarification so the page is never
  // left idle for 30+ seconds waiting for user input (stale page issue).
  await launchBrowser();

  // Pre-navigate to the planned site to save a turn.
  let feedback: string | null = null;
  if (plan.startUrl) {
    const nav = await navigate(plan.startUrl);
    feedback = `Pre-navigation: ${nav.message}`;
  }

  // Conversation history (persists across turns; images pruned to bound cost).
  const messages: Anthropic.MessageParam[] = [];
  let prevToolUseId: string | null = null;

  // Stuck detector. Non-mutating tools (extract/wait) legitimately leave the
  // page unchanged on read-only tasks, so they must NOT trip the detector —
  // only genuine loops of mutating actions should.
  let lastObsHash: string | null = null;
  let stuckCount = 0;
  let lastTool: ToolCall["tool"] | null = null;
  const MAX_STUCK = 3;
  // extract/wait read or pause without changing the page; ask_user pauses for
  // human input. None should count toward the stuck detector.
  const NON_MUTATING = new Set<ToolCall["tool"]>(["extract", "wait", "ask_user"]);

  for (let step = 1; step <= maxSteps; step++) {
    // ── OBSERVE ──────────────────────────────────────────────────────────────
    const obs = await observe(step, maxSteps, goal, plan.successCriteria, null);
    emit({
      type: "observe",
      step,
      message: `Observing: ${obs.title || "(untitled)"} — ${obs.url}`,
      screenshotBase64: obs.screenshotBase64,
      elements: obs.elements,
    });

    // ── 3. STUCK DETECTOR ────────────────────────────────────────────────────
    // Only count an unchanged page as "stuck" if the previous action was meant
    // to change it. Reading the page (extract) or waiting doesn't move state.
    const obsHash = hashObservation(obs);
    const lastWasNonMutating = lastTool !== null && NON_MUTATING.has(lastTool);
    if (obsHash === lastObsHash && !lastWasNonMutating) {
      if (++stuckCount >= MAX_STUCK) {
        const summary = `Page state unchanged for ${MAX_STUCK} consecutive mutating steps (stuck at ${obs.url}). Stopping to avoid an infinite loop.`;
        emit({ type: "give_up", step, message: summary, summary });
        return { success: false, summary, steps: step, finalScreenshotBase64: obs.screenshotBase64 };
      }
    } else if (obsHash !== lastObsHash) {
      stuckCount = 0;
      lastObsHash = obsHash;
    }

    // ── Build the observation message (tool_result if continuing a tool call) ──
    const obsBlocks = buildObservationBlocks(obs, plan, step, maxSteps, feedback);
    feedback = null;
    if (prevToolUseId) {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: prevToolUseId, content: obsBlocks }],
      });
    } else {
      messages.push({ role: "user", content: obsBlocks });
    }
    pruneOldImages(messages, 1);          // keep only the most recent screenshot
    pruneOldObservationText(messages, 3); // compress element lists older than 3 steps

    // ── 2. THINK (agent-model tool-use call) ─────────────────────────────────
    const decision = await decideNextAction(client, messages);
    messages.push({ role: "assistant", content: decision.assistantContent });

    if (!decision.toolUse) {
      // Model replied without acting — nudge and retry next turn.
      prevToolUseId = null;
      feedback = "You did not call a tool. Think briefly, then call exactly one tool.";
      emit({ type: "error", step, message: "Model returned no tool call — nudging." });
      continue;
    }

    // Validate the tool input before executing.
    let toolCall: ToolCall;
    try {
      toolCall = parseToolCall(decision.toolUse.name, decision.toolUse.input);
    } catch (err) {
      prevToolUseId = decision.toolUse.id;
      feedback = `Invalid tool input (${errMsg(err)}). Re-read the element list and try again.`;
      emit({ type: "error", step, message: feedback });
      continue;
    }

    prevToolUseId = decision.toolUse.id;
    lastTool = toolCall.tool;
    emit({
      type: "action",
      step,
      message: `${decision.reasoning ? `💭 ${decision.reasoning}\n` : ""}${formatActionMessage(toolCall)}`,
    });

    // ── Terminal & special tools ─────────────────────────────────────────────
    if (toolCall.tool === "done") {
      // ── 4. VERIFY before declaring success ─────────────────────────────────
      const verdict = await verifyCompletion(client, obs, plan.successCriteria);
      if (verdict.met) {
        const summary = toolCall.input.summary;
        emit({ type: "done", step, message: summary, summary, screenshotBase64: obs.screenshotBase64 });
        return {
          success: true,
          summary,
          confirmation: toolCall.input.confirmation,
          steps: step,
          finalScreenshotBase64: obs.screenshotBase64,
        };
      }
      // Not actually done — bounce it back and keep going.
      feedback = `Your done() was rejected by verification: ${verdict.reason}. The success criteria are NOT yet visibly met. Keep working.`;
      emit({ type: "error", step, message: `Verification rejected done(): ${verdict.reason}` });
      continue;
    }

    if (toolCall.tool === "give_up") {
      const reason = toolCall.input.reason;
      emit({ type: "give_up", step, message: reason, summary: reason, screenshotBase64: obs.screenshotBase64 });
      return { success: false, summary: reason, steps: step, finalScreenshotBase64: obs.screenshotBase64 };
    }

    if (toolCall.tool === "ask_user") {
      const question = toolCall.input.question;
      emit({ type: "ask_user", step, message: question, summary: question });

      if (onAskUser) {
        // Pause the loop and wait for the user's reply (delivered out-of-band by
        // the streaming route). prevToolUseId is already the ask_user tool_use
        // id, so the next observation is sent as its tool_result — and we inject
        // the answer via `feedback` so the model reads it. Then continue.
        const answer = await onAskUser(question);
        feedback = `The user answered your question — "${question}"\nUSER REPLY: ${answer}\nUse this to proceed.`;
        continue;
      }

      // No interactive channel (e.g. CLI harness): surface the question and stop.
      return { success: false, summary: `Needs input: ${question}`, steps: step, finalScreenshotBase64: obs.screenshotBase64 };
    }

    // ── 5. ACT with tiered recovery ──────────────────────────────────────────
    const result = await executeWithRecovery(toolCall, step, emit);
    feedback = `Action ${result.ok ? "succeeded" : "FAILED"}: ${result.message}`;
  }

  // Hard cut — the model never called done() or give_up() despite the warnings.
  // Capture the last known page so the user can see where the agent got stuck.
  let lastScreenshot: string | undefined;
  let lastUrl = "";
  try {
    const finalObs = await observe(maxSteps, maxSteps, goal, plan.successCriteria, null);
    lastScreenshot = finalObs.screenshotBase64;
    lastUrl = finalObs.url;
  } catch { /* ignore — browser may be closed */ }

  const summary =
    `Step budget (${maxSteps}) exhausted without completing the goal.` +
    (lastUrl ? ` Last page: ${lastUrl}.` : "") +
    ` The agent did not produce a final summary — try rephrasing the goal or breaking it into smaller steps.`;

  emit({ type: "give_up", step: maxSteps, message: summary, summary, screenshotBase64: lastScreenshot });
  return { success: false, summary, steps: maxSteps, finalScreenshotBase64: lastScreenshot };
}

// ---------------------------------------------------------------------------
// 1. planTask — cheap Sonnet call, forced structured output
// ---------------------------------------------------------------------------

async function planTask(
  client: Anthropic,
  goal: string,
  fallbackCriteria?: string
): Promise<Plan> {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  try {
    const resp = await client.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 1024,
      tools: [PLAN_TOOL],
      tool_choice: { type: "tool", name: "submit_plan" },
      messages: [
        {
          role: "user",
          content:
            `Today is ${dateStr}. The user's request: "${goal}".\n\n` +

            `STEP 1 — Check for missing essential information:\n` +
            `Before anything else, identify whether the goal is missing information that only the user ` +
            `can provide and that is REQUIRED to proceed. Examples:\n` +
            `  • Restaurant booking with no restaurant name → clarification_needed = "Which restaurant would you like to book?"\n` +
            `  • Flight search with no origin city → clarification_needed = "Which city are you flying from?"\n` +
            `  • Hotel search with no destination → clarification_needed = "Which city do you need a hotel in?"\n` +
            `If essential info is missing, set clarification_needed and still set a best-guess start_url ` +
            `(the user's answer will be injected before the agent navigates). ` +
            `If the goal has all needed information, leave clarification_needed empty.\n\n` +

            `STEP 2 — Extract every parameter from the goal:\n` +
            `Identify ALL relevant values before picking a URL: origin/destination cities or airports, ` +
            `dates (resolve relative terms like "next Friday" or "tonight" to absolute YYYY-MM-DD values), ` +
            `times, party/guest size, price limits, trip type (one-way/round-trip), cabin class, ` +
            `cuisine type, dietary restrictions, duration, hotel star rating, etc. ` +
            `Put ALL resolved parameters in the notes field so the agent always has them.\n\n` +

            `STEP 3 — Build the deepest possible start_url using these templates:\n\n` +

            `FLIGHTS (prefer Kayak — lands on results, always USD, no currency param needed):\n` +
            `  One-way:    https://www.kayak.com/flights/[IATA1]-[IATA2]/[YYYY-MM-DD]?sort=price_a\n` +
            `  Round-trip: https://www.kayak.com/flights/[IATA1]-[IATA2]/[YYYY-MM-DD]/[YYYY-MM-DD]?sort=price_a\n` +
            `  + cabin class: append &cabin=economy OR &cabin=business OR &cabin=first OR &cabin=premium_economy\n` +
            `  IMPORTANT — do NOT append &fs=price= for price constraints. Kayak returns "No results" when ` +
            `  no flights match the filter instead of showing the cheapest available. Sort by price only ` +
            `  (?sort=price_a) and let the agent read the results and evaluate the price constraint itself.\n` +
            `  Fallback (if Kayak is blocked): https://www.kayak.com/flights/[IATA1]-[IATA2]/[YYYY-MM-DD]?sort=price_a ` +
            `  on a direct navigate — same URL, no price filter. Do NOT fall back to Google Flights; ` +
            `  its complex SPA requires many more steps and produces no new price information.\n\n` +

            `RESTAURANTS / BUSINESS BOOKINGS:\n` +
            `  Step 1 — Resy (preferred): https://resy.com/cities/[city-slug]/search?date=[YYYY-MM-DD]&seats=[N]&query=[Restaurant+Name]\n` +
            `    Lands directly on search results for the restaurant with date and party size pre-filled.\n` +
            `    City slug format: san-francisco-ca, nyc-ny, los-angeles-ca, chicago-il, miami-fl, boston-ma, etc.\n` +
            `  Step 2 — If Resy shows no results, set fallback_url to a Google existence check:\n` +
            `    https://www.google.com/search?q=[Restaurant+Name]+restaurant+[City]+[State]\n` +
            `    If Google confirms no location in that city → agent gives up immediately.\n` +
            `    If Google confirms it exists but not on Resy → agent tries Tock.\n` +
            `  Step 3 — Tock (only if restaurant confirmed to exist):\n` +
            `    https://www.exploretock.com/city/[city-slug]/search?city=[City+Name]&latlng=[LAT],[LON]&q=[Restaurant+Name]&date=[YYYY-MM-DD]&time=[HH:MM]&party=[N]\n` +
            `    IMPORTANT: the latlng param is required — without it Tock overrides the city using IP geolocation\n` +
            `    (e.g. a UAE IP defaults to Dubai/Berlin). Always include it.\n` +
            `    City slugs and coordinates:\n` +
            `      san-francisco  → 37.7749,-122.4194\n` +
            `      nyc            → 40.7128,-74.0060\n` +
            `      los-angeles    → 34.0522,-118.2437\n` +
            `      chicago        → 41.8781,-87.6298\n` +
            `      miami          → 25.7617,-80.1918\n` +
            `      boston         → 42.3601,-71.0589\n` +
            `      seattle        → 47.6062,-122.3321\n` +
            `      austin         → 30.2672,-97.7431\n` +
            `      london         → 51.5074,-0.1278\n` +
            `      paris          → 48.8566,2.3522\n` +
            `      dubai          → 25.2048,55.2708\n` +
            `      tokyo          → 35.6762,139.6503\n` +
            `  NEVER include OpenTable in fallback_urls — it blocks all automated search requests and wastes steps.\n\n` +

            `WEATHER:\n` +
            `  Google: https://www.google.com/search?q=weather+[city]+[state]+[timeframe]\n` +
            `  weather.com: https://weather.com/weather/[today|tenday|weekend]/l/[City]+[State]\n\n` +

            `HOTELS:\n` +
            `  Booking.com: https://www.booking.com/searchresults.html?ss=[city]&checkin=[YYYY-MM-DD]&checkout=[YYYY-MM-DD]&group_adults=[N]\n` +
            `  Google Hotels: https://www.google.com/travel/hotels?q=[city]+hotels&checkin=[YYYY-MM-DD]&checkout=[YYYY-MM-DD]&adults=[N]\n\n` +

            `GENERAL RULE: encode every extracted parameter into the URL as a query param wherever the ` +
            `template supports it. A URL that lands on results with all filters pre-applied saves 10–15 ` +
            `agent steps compared to starting from a homepage and filling forms.\n\n` +

            `STEP 4 — Write the success criteria:\n` +
            `Describe ONLY what must be visibly present on the page when done ` +
            `(e.g. "flights from SFO to JFK on June 13 are listed with prices in USD"). ` +
            `Do NOT include steps the agent performs. Do NOT hard-code exact calendar dates if the ` +
            `site labels things by weekday or relative terms. ` +
            `For price-constrained searches (flights, hotels, products): write the criteria as ` +
            `"results are visible sorted by price, and the agent has identified the cheapest option ` +
            `and whether it meets the [budget] constraint" — NOT "a result under $X is visible". ` +
            `The constraint may not be satisfiable; the agent should always be able to report the ` +
            `cheapest available and call done() regardless of whether it meets the budget.`,
        },
      ],
    });

    const tu = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (tu) {
      const input = tu.input as {
        start_url: string;
        success_criteria: string;
        notes: string;
        fallback_urls?: string[];
        clarification_needed?: string;
      };
      const fallbackUrls = input.fallback_urls ?? [];
      return {
        startUrl: input.start_url,
        successCriteria: input.success_criteria,
        notes: input.notes +
          (fallbackUrls.length
            ? `\nFALLBACK SITES (use if primary is blocked): ${fallbackUrls.join(", ")}`
            : ""),
        fallbackUrls,
        clarificationNeeded: input.clarification_needed || undefined,
      };
    }
  } catch (err) {
    // Re-throw billing / auth errors immediately — silent fallback would send
    // the agent to about:blank with generic criteria, which is confusing and
    // wastes the browser launch. Any other API error falls through to defaults.
    const msg = errMsg(err);
    if (/credit balance|unauthorized|authentication/i.test(msg)) throw err;
    // fall through to default plan for transient errors
  }

  return {
    startUrl: "",
    successCriteria: fallbackCriteria ?? `The user's goal is visibly achieved: "${goal}"`,
    notes: `Date context: ${dateStr}.`,
    fallbackUrls: [],
  };
}

// ---------------------------------------------------------------------------
// 2. decideNextAction — one Opus call; returns the chosen tool use + reasoning
// ---------------------------------------------------------------------------

interface Decision {
  assistantContent: Anthropic.ContentBlockParam[];
  toolUse: Anthropic.ToolUseBlock | null;
  reasoning: string;
}

async function decideNextAction(
  client: Anthropic,
  messages: Anthropic.MessageParam[]
): Promise<Decision> {
  const resp = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 1_000,   // was 1_500 — tool calls are short; output costs 5× input
    system: SYSTEM_BLOCKS,
    tools: ANTHROPIC_TOOLS,
    tool_choice: { type: "auto" },
    messages,
  });

  const toolUse =
    resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use") ?? null;
  const reasoning = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text.trim())
    .join(" ")
    .slice(0, 300);

  return {
    assistantContent: resp.content as Anthropic.ContentBlockParam[],
    toolUse,
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// 4. verifyCompletion — Sonnet grounded in screenshot + page text
// ---------------------------------------------------------------------------

async function verifyCompletion(
  client: Anthropic,
  obs: Observation,
  successCriteria: string
): Promise<{ met: boolean; reason: string }> {
  try {
    const pageText = await getVisibleText(3_500);
    const resp = await client.messages.create({
      model: VERIFIER_MODEL,
      max_tokens: 300,
      tools: [VERIFY_TOOL],
      tool_choice: { type: "tool", name: "submit_verification" },
      messages: [
        {
          role: "user",
          content: [
            imageBlock(obs.screenshotBase64),
            {
              type: "text",
              text:
                `USER GOAL: ${obs.goal}\n` +
                `SUCCESS CRITERIA: ${successCriteria}\n\n` +
                `Current page: ${obs.title} — ${obs.url}\n\n` +
                `Visible page text:\n${pageText}\n\n` +
                `Is the SUBSTANCE of the user's goal visibly satisfied by the content on THIS page right now?\n` +
                `Guidance:\n` +
                `- met=true if the page clearly contains the information or end-state the user asked for ` +
                `(the requested data, a confirmation/review screen, etc.).\n` +
                `- Judge substance, not phrasing. If the site labels days by weekday (e.g. "Saturday") and the ` +
                `requested weekend is present, that counts — do NOT demand exact calendar-date arithmetic.\n` +
                `- Ignore any criteria that cannot be observed on the page (e.g. whether a summary was ` +
                `"reported to the user") — that is the agent's job, not a page condition.\n` +
                `- For numeric constraints (e.g. "under $300"), met=true as long as qualifying results are ` +
                `VISIBLE among the listings. Do NOT require the list to be filtered so every non-qualifying ` +
                `result is hidden — a page showing a $241 flight satisfies "under $300" even if pricier ` +
                `options also appear.\n` +
                `- Stay strict against hallucination: if the needed information is NOT actually on the page, met=false.`,
            },
          ],
        },
      ],
    });

    const tu = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (tu) return tu.input as { met: boolean; reason: string };
  } catch (err) {
    // If verification itself errors, don't block the agent — trust the model.
    return { met: true, reason: `Verification skipped (error: ${errMsg(err)}).` };
  }
  return { met: false, reason: "Verifier returned no structured response." };
}

// ---------------------------------------------------------------------------
// execute() — dispatch ToolCall → browser action
// ---------------------------------------------------------------------------

async function execute(toolCall: ToolCall): Promise<ActionResult> {
  switch (toolCall.tool) {
    case "navigate":
      return navigate(toolCall.input.url);
    case "click":
      return clickElement(toolCall.input.element_id);
    case "type":
      return typeIntoElement(toolCall.input.element_id, toolCall.input.text, toolCall.input.submit ?? false);
    case "select_option":
      return selectOption(toolCall.input.element_id, toolCall.input.value);
    case "scroll":
      return scroll(toolCall.input.direction, toolCall.input.element_id);
    case "key":
      return pressKey(toolCall.input.keys);
    case "wait": {
      const ms = toolCall.input.ms ?? 1_500;
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true, message: `Waited ${ms}ms (${toolCall.input.reason})` };
    }
    case "extract":
      return extractText(toolCall.input.query);
    case "go_back":
      return goBack();
    case "ask_user":
    case "done":
    case "give_up":
      return { ok: false, message: `${toolCall.tool} should not reach execute()` };
  }
}

// ---------------------------------------------------------------------------
// 5. Tiered error recovery
// ---------------------------------------------------------------------------

async function executeWithRecovery(
  toolCall: ToolCall,
  step: number,
  emit: (e: StepEvent) => void
): Promise<ActionResult> {
  // Tier 1: direct attempt.
  let result = await execute(toolCall);
  if (result.ok) return result;

  // Tier 2: element-targeting tools — page may have shifted; pause and retry once.
  if (toolCall.tool === "click" || toolCall.tool === "type" || toolCall.tool === "select_option") {
    emit({ type: "error", step, message: `${result.message} — retrying in 1s…` });
    await new Promise((r) => setTimeout(r, 1_000));
    result = await execute(toolCall);
    if (result.ok) return result;
  }

  // Tier 3: navigation timeout — give it longer and retry once.
  if (toolCall.tool === "navigate" && /timeout/i.test(result.message)) {
    emit({ type: "error", step, message: "Navigation timed out — retrying…" });
    await new Promise((r) => setTimeout(r, 2_000));
    result = await execute(toolCall);
    if (result.ok) return result;
  }

  // Exhausted — surface to the model on the next observation so it can adapt.
  emit({ type: "error", step, message: `Action failed: ${result.message}` });
  return result;
}

// ---------------------------------------------------------------------------
// Observation serialization → Claude content blocks
// ---------------------------------------------------------------------------

type ObsBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;

function buildObservationBlocks(
  obs: Observation,
  plan: Plan,
  step: number,
  maxSteps: number,
  feedback: string | null
): ObsBlock[] {
  const lines: string[] = [];
  lines.push(`STEP ${step} of ${maxSteps}`);
  lines.push(`GOAL: ${obs.goal}`);
  lines.push(`SUCCESS CRITERIA: ${plan.successCriteria}`);
  if (plan.notes) lines.push(`PLAN NOTES: ${plan.notes}`);
  if (feedback) lines.push(`\n${feedback}`);

  // Budget warning — give the model a chance to wrap up gracefully rather than
  // being hard-cut with no summary. Fires with increasing urgency as the limit approaches.
  const stepsLeft = maxSteps - step;
  if (stepsLeft <= 0) {
    lines.push(`\n🚨 FINAL STEP: You MUST call done() or give_up() RIGHT NOW. ` +
      `Do not take any other action. Summarize everything you have found so far.`);
  } else if (stepsLeft === 1) {
    lines.push(`\n🚨 LAST CHANCE — 1 step remaining. Call done() or give_up() immediately. ` +
      `Summarize all findings collected so far. Do not navigate or click anything.`);
  } else if (stepsLeft <= 3) {
    lines.push(`\n⚠ BUDGET WARNING: Only ${stepsLeft} steps remaining. ` +
      `Do not start any new navigation or multi-step actions. ` +
      `Summarize what you have found and call done() or give_up() now.`);
  }
  lines.push("");
  lines.push(`URL: ${obs.url}`);
  lines.push(`TITLE: ${obs.title || "(untitled)"}`);

  // Surface page-level warnings FIRST — before the element list — so the model
  // acts on them immediately rather than trying to interact with a blocked page.
  if (obs.pageWarnings.length) {
    lines.push("");
    for (const w of obs.pageWarnings) lines.push(`⚠ WARNING: ${w}`);
  }

  if (obs.openDialogs) lines.push("NOTE: a dialog/modal appears to be open.");
  if (obs.numTabs > 1) lines.push(`NOTE: ${obs.numTabs} tabs open (acting on the active one).`);
  if (obs.consoleErrors.length) {
    lines.push(`CONSOLE ERRORS: ${obs.consoleErrors.slice(-3).join(" | ")}`);
  }
  lines.push("");
  lines.push("INTERACTIVE ELEMENTS (reference by number):");
  if (obs.elements.length === 0) {
    lines.push("  (none detected — try scrolling, waiting, or navigating)");
  } else {
    for (const el of obs.elements) lines.push(serializeElement(el));
  }

  return [imageBlock(obs.screenshotBase64), { type: "text", text: lines.join("\n") }];
}

function serializeElement(el: PageElement): string {
  const parts = [`[${el.id}] ${el.role}`];
  if (el.name) parts.push(`"${truncate(el.name, 60)}"`);

  const meta: string[] = [];
  if (el.tag === "select") meta.push("native-select");
  if (el.type && el.type !== el.role) meta.push(`type=${el.type}`);
  if (el.value) meta.push(`value="${truncate(el.value, 30)}"`);
  if (!el.enabled) meta.push("disabled");
  if (el.frameIndex > 0) meta.push(`iframe#${el.frameIndex}`);
  if (meta.length) parts.push(`(${meta.join(", ")})`);

  return "  " + parts.join(" ");
}

// ---------------------------------------------------------------------------
// Context cost control — keep only the most recent screenshots
// ---------------------------------------------------------------------------

function pruneOldImages(messages: Anthropic.MessageParam[], keep = 2): void {
  // Collect references to every image block, in order.
  const holders: Array<{ arr: unknown[]; index: number }> = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    m.content.forEach((block, i) => {
      const b = block as { type: string; content?: unknown };
      if (b.type === "image") {
        holders.push({ arr: m.content as unknown[], index: i });
      } else if (b.type === "tool_result" && Array.isArray(b.content)) {
        b.content.forEach((inner, j) => {
          if ((inner as { type: string }).type === "image") {
            holders.push({ arr: b.content as unknown[], index: j });
          }
        });
      }
    });
  }
  // Replace all but the last `keep` with a lightweight placeholder.
  const cutoff = Math.max(0, holders.length - keep);
  for (let i = 0; i < cutoff; i++) {
    const { arr, index } = holders[i];
    arr[index] = { type: "text", text: "[screenshot from an earlier step omitted to save context]" };
  }
}

// ---------------------------------------------------------------------------
// Context cost control — compress old observation text blocks
// ---------------------------------------------------------------------------
//
// The element list (INTERACTIVE ELEMENTS) is the largest part of each
// observation message and can run to 1 000+ tokens on complex pages. It is
// only useful for the current step, not for historical context. This function
// replaces element lists in turns older than `keep` with a one-line summary,
// turning the O(n²) history growth into O(n).
//
function pruneOldObservationText(messages: Anthropic.MessageParam[], keep = 3): void {
  const holders: Array<{ arr: unknown[]; index: number; text: string }> = [];

  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (let i = 0; i < m.content.length; i++) {
      const b = m.content[i] as { type: string; text?: string; content?: unknown[] };
      // Direct text block (first turn before any tool_result wrapping)
      if (b.type === "text" && b.text?.includes("INTERACTIVE ELEMENTS")) {
        holders.push({ arr: m.content as unknown[], index: i, text: b.text });
      }
      // Nested inside a tool_result block (all subsequent turns)
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        for (let j = 0; j < b.content.length; j++) {
          const inner = b.content[j] as { type: string; text?: string };
          if (inner.type === "text" && inner.text?.includes("INTERACTIVE ELEMENTS")) {
            holders.push({ arr: b.content as unknown[], index: j, text: inner.text });
          }
        }
      }
    }
  }

  const cutoff = Math.max(0, holders.length - keep);
  for (let i = 0; i < cutoff; i++) {
    const { arr, index, text } = holders[i];
    // Keep everything UP TO the element list — drop only the elements themselves.
    // This preserves step / URL / title / feedback so the model remembers what it
    // already tried (critical for avoiding re-visiting sites it already searched),
    // while still cutting the 500–1 500 tokens that the element list costs.
    const pruned = text.replace(
      /\nINTERACTIVE ELEMENTS[\s\S]*$/,
      "\n[Interactive elements pruned to save context]",
    );
    (arr as { type: string; text: string }[])[index] = { type: "text", text: pruned };
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function imageBlock(base64: string): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } };
}

function hashObservation(obs: Observation): string {
  // Include element identity + current values so that progress on a page whose
  // URL/title/count never change (e.g. filling a multi-field form on one screen)
  // registers as a state change. A coarse url|count|title hash would treat each
  // field-fill as "no change" and wrongly trip the stuck detector mid-progress.
  const elementSig = obs.elements
    .map((e) => `${e.id}:${e.role}:${e.name}:${e.value ?? ""}`)
    .join("|");
  const key = `${obs.url}|${obs.title}|${elementSig}`;
  return crypto.createHash("md5").update(key).digest("hex");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatActionMessage(tc: ToolCall): string {
  switch (tc.tool) {
    case "navigate":      return `→ navigate(${tc.input.url})`;
    case "click":         return `→ click(#${tc.input.element_id})`;
    case "type":          return `→ type("${truncate(tc.input.text, 40)}") into #${tc.input.element_id}${tc.input.submit ? " + Enter" : ""}`;
    case "select_option": return `→ select_option("${tc.input.value}") on #${tc.input.element_id}`;
    case "scroll":        return `→ scroll(${tc.input.direction})`;
    case "key":           return `→ key("${tc.input.keys}")`;
    case "wait":          return `→ wait(${tc.input.ms ?? 1500}ms — ${tc.input.reason})`;
    case "extract":       return `→ extract("${tc.input.query}")`;
    case "go_back":       return `→ go_back()`;
    case "ask_user":      return `→ ask_user("${tc.input.question}")`;
    case "done":          return `✓ done()`;
    case "give_up":       return `✗ give_up()`;
  }
}

// Re-export for the API route's cleanup path.
export { closeBrowser };
