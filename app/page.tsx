"use client";

/**
 * app/page.tsx
 *
 * Layout:
 *  - Left panel:  header → goal bar → step log → reply box → input
 *  - Right panel: live annotated browser screenshot
 */

import { useState, useRef, useEffect, useCallback, FormEvent } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepEvent {
  type: "plan" | "observe" | "action" | "ask_user" | "done" | "give_up" | "error";
  step: number;
  message: string;
  screenshotBase64?: string;
  summary?: string;
  requestId?: string;
}

interface LogEntry {
  event: StepEvent;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

const C = {
  // Backgrounds
  base:       "#0c0e14",
  panel:      "#0f1117",
  surface:    "#13151e",
  surfaceHi:  "#181b26",

  // Borders
  border:     "#1c1f2e",
  borderHi:   "#252836",

  // Text
  textPrimary:   "#e4e7ed",
  textSecondary: "#7d8799",
  textMuted:     "#3d4456",
  textDim:       "#252836",

  // Accents
  green:    "#4ade80",
  greenDim: "#166534",
  greenBg:  "#071811",
  blue:     "#60a5fa",
  blueDim:  "#1e3a5f",
  purple:   "#c084fc",
  amber:    "#fbbf24",
  amberDim: "#78350f",
  amberBg:  "#1a1200",
  red:      "#f87171",
  redBg:    "#1f0707",
  redDim:   "#7f1d1d",
};

const FONT_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
const FONT_MONO = `"SF Mono", "Fira Code", "Cascadia Code", "Consolas", monospace`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Home() {
  const [input, setInput]             = useState("");
  const [log, setLog]                 = useState<LogEntry[]>([]);
  const [screenshot, setScreenshot]   = useState<string | null>(null);
  const [running, setRunning]         = useState(false);
  const [activeGoal, setActiveGoal]   = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [screenshotStep, setScreenshotStep] = useState(0);
  const [copied, setCopied]           = useState(false);

  const [pending, setPending] = useState<{ requestId: string; question: string } | null>(null);
  const [reply, setReply]     = useState("");

  const [apiKey, setApiKey]           = useState("");
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyDraft, setKeyDraft]       = useState("");

  const [elapsed, setElapsed] = useState(0);
  const timerRef              = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef                = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("anthropic_api_key");
    if (saved) setApiKey(saved);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  useEffect(() => {
    if (running) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [running]);

  function fmtElapsed(s: number) {
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  }

  function saveKey(e: FormEvent) {
    e.preventDefault();
    const v = keyDraft.trim();
    setApiKey(v);
    if (v) localStorage.setItem("anthropic_api_key", v);
    else localStorage.removeItem("anthropic_api_key");
    setShowKeyInput(false);
    setKeyDraft("");
  }

  function clearKey() {
    setApiKey("");
    localStorage.removeItem("anthropic_api_key");
    setShowKeyInput(false);
  }

  const copySummary = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const goal = input.trim();
    if (!goal || running) return;

    setInput("");
    setLog([]);
    setScreenshot(null);
    setPending(null);
    setReply("");
    setCurrentStep(0);
    setScreenshotStep(0);
    setActiveGoal(goal);
    setRunning(true);

    addToLog({ type: "action", step: 0, message: goal });

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, apiKey: apiKey || undefined }),
      });

      if (!res.ok || !res.body) {
        addToLog({ type: "error", step: 0, message: `HTTP ${res.status}: ${res.statusText}` });
        setRunning(false);
        setActiveGoal(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as StepEvent;
            addToLog(event);
            if (event.step > 0) setCurrentStep(event.step);
            if (event.screenshotBase64) {
              setScreenshot(event.screenshotBase64);
              setScreenshotStep(event.step);
            }
            if (event.type === "ask_user" && event.requestId) {
              setPending({ requestId: event.requestId, question: event.message });
            }
            if (event.type === "done" || event.type === "give_up") {
              setPending(null);
              setActiveGoal(null);
            }
          } catch { /* ignore malformed lines */ }
        }
      }
    } catch (err) {
      addToLog({ type: "error", step: 0,
        message: `Network error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setRunning(false);
      setActiveGoal(null);
    }
  }

  function addToLog(event: StepEvent) {
    setLog((prev) => [...prev, { event, timestamp: new Date() }]);
  }

  async function handleReply(e: FormEvent) {
    e.preventDefault();
    if (!pending || !reply.trim()) return;
    const answer  = reply.trim();
    const current = pending;
    addToLog({ type: "action", step: 0, message: `↳ ${answer}` });
    setReply("");
    setPending(null);
    try {
      await fetch("/api/agent/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: current.requestId, answer }),
      });
    } catch (err) {
      addToLog({ type: "error", step: 0,
        message: `Failed to send reply: ${err instanceof Error ? err.message : String(err)}` });
      setPending(current);
    }
  }

  const lastEntry     = log[log.length - 1]?.event;
  const terminalEntry = lastEntry?.type === "done" || lastEntry?.type === "give_up" ? lastEntry : null;

  // ── render ──────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden",
                  background: C.base, fontFamily: FONT_SANS }}>

      {/* ── LEFT: Log panel ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", width: 500,
                    flexShrink: 0, borderRight: `1px solid ${C.border}`,
                    background: C.panel }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between",
                      alignItems: "center", padding: "12px 16px",
                      borderBottom: `1px solid ${C.border}`, background: C.surface,
                      flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: C.textSecondary, fontSize: 11,
                           fontWeight: 600, letterSpacing: 1 }}>AGENT LOG</span>
            {running && (
              <span style={{ color: C.textMuted, fontSize: 11, fontFamily: FONT_MONO }}>
                step {currentStep} · {fmtElapsed(elapsed)}
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {running && (
              <span style={{ display: "flex", alignItems: "center", gap: 5,
                             color: C.amber, fontSize: 11, fontWeight: 500 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%",
                               background: C.amber, display: "inline-block" }} />
                running
              </span>
            )}
            <button
              onClick={() => { setShowKeyInput(v => !v); setKeyDraft(apiKey); }}
              style={{ background: C.surfaceHi, border: `1px solid ${C.borderHi}`,
                       color: apiKey ? C.green : C.textMuted, fontSize: 11,
                       padding: "3px 10px", cursor: "pointer", borderRadius: 5,
                       fontFamily: FONT_SANS, fontWeight: 500 }}
              title={apiKey ? "API key set — click to change" : "No API key — click to add"}>
              {apiKey ? "🔑 Key set" : "🔓 Add key"}
            </button>
          </div>
        </div>

        {/* Active goal bar */}
        {activeGoal && (
          <div style={{ display: "flex", alignItems: "center", gap: 8,
                        padding: "8px 16px", borderBottom: `1px solid ${C.border}`,
                        background: C.panel, flexShrink: 0,
                        borderLeft: `3px solid ${C.green}` }}>
            <span style={{ color: C.textMuted, fontSize: 10, fontWeight: 600,
                           letterSpacing: 1, flexShrink: 0 }}>GOAL</span>
            <span style={{ color: C.textSecondary, fontSize: 12, overflow: "hidden",
                           textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
              {activeGoal}
            </span>
          </div>
        )}

        {/* API key panel */}
        {showKeyInput && (
          <form onSubmit={saveKey}
            style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`,
                     background: C.panel, flexShrink: 0 }}>
            {/* Warning callout */}
            <div style={{ background: C.amberBg, border: `1px solid ${C.amberDim}`,
                          borderRadius: 6, padding: "10px 12px",
                          fontSize: 12, color: "#c8974a", lineHeight: 1.7 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, color: C.amber,
                            display: "flex", alignItems: "center", gap: 6 }}>
                <span>⚠</span><span>Security notice</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, display: "flex",
                           flexDirection: "column" as const, gap: 3 }}>
                <li><strong>Stored in browser localStorage</strong> — not encrypted; readable by JS and extensions.</li>
                <li><strong>Sent to the server over HTTPS</strong> on every run. Visible in DevTools → Network tab.</li>
                <li><strong>Never persisted server-side</strong> — discarded after each run.</li>
                <li>For a deployed app, set <code style={{ background: "#2a1a00", border: `1px solid ${C.amberDim}`,
                    borderRadius: 3, padding: "0 4px", fontFamily: FONT_MONO,
                    fontSize: 11 }}>ANTHROPIC_API_KEY</code> as a server env var instead.</li>
                <li><strong>Clear the key when done testing</strong> using the button below.</li>
              </ul>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input
                type="password"
                value={keyDraft}
                onChange={e => setKeyDraft(e.target.value)}
                placeholder="sk-ant-..."
                autoFocus
                style={{ flex: 1, background: C.surface, border: `1px solid ${C.borderHi}`,
                         borderRadius: 5, padding: "7px 10px", color: C.textPrimary,
                         fontSize: 12, fontFamily: FONT_MONO, outline: "none" }} />
              <button type="submit" style={amberBtn}>Save</button>
              {apiKey && (
                <button type="button" onClick={clearKey}
                  style={{ ...amberBtn, color: C.red, borderColor: C.redDim }}>Clear</button>
              )}
            </div>
          </form>
        )}

        {/* Log body */}
        <div ref={logRef} style={{ flex: 1, overflowY: "auto" as const,
                                   padding: "12px 0 20px" }}>
          {log.length === 0 && (
            <div style={{ padding: "32px 20px" }}>
              <div style={{ color: C.textSecondary, fontSize: 14,
                            fontWeight: 500, marginBottom: 20 }}>
                Type a command to get started.
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
                {[
                  "Look up the weekend weather forecast for San Francisco",
                  "Search for one-way flights from SFO to JFK next Friday under $300",
                  "Book me a table for 2 tonight at 7pm at Nobu in San Francisco",
                ].map((ex, i) => (
                  <button key={i} onClick={() => setInput(ex)}
                    style={{ background: C.surface, border: `1px solid ${C.border}`,
                             borderRadius: 6, padding: "9px 12px", cursor: "pointer",
                             color: C.textSecondary, fontSize: 12, textAlign: "left" as const,
                             fontFamily: FONT_SANS, lineHeight: 1.4 }}>
                    <span style={{ color: C.textMuted, marginRight: 8 }}>→</span>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {log.map((entry, i) => (
            <LogLine key={i} entry={entry} />
          ))}

          {/* Result block */}
          {terminalEntry && (
            <div style={{ margin: "16px 16px 4px",
                          background: terminalEntry.type === "done" ? C.greenBg : C.redBg,
                          border: `1px solid ${terminalEntry.type === "done" ? C.greenDim : C.redDim}`,
                          borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between",
                            alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                               color: terminalEntry.type === "done" ? C.green : C.red }}>
                  {terminalEntry.type === "done" ? "✓ COMPLETED" : "✗ STOPPED"}
                </span>
                <button onClick={() => copySummary(terminalEntry.summary ?? terminalEntry.message)}
                  style={{ background: C.surface, border: `1px solid ${C.borderHi}`,
                           color: C.textMuted, fontSize: 11, padding: "3px 10px",
                           cursor: "pointer", borderRadius: 4, fontFamily: FONT_SANS }}>
                  {copied ? "✓ copied" : "Copy"}
                </button>
              </div>
              <div style={{ fontSize: 13, color: C.textPrimary, whiteSpace: "pre-wrap",
                            lineHeight: 1.75, fontFamily: FONT_SANS }}>
                {terminalEntry.summary ?? terminalEntry.message}
              </div>
            </div>
          )}
        </div>

        {/* Ask-user reply box */}
        {pending && (
          <div style={{ borderTop: `1px solid ${C.amberDim}`, background: C.amberBg,
                        padding: "10px 16px", flexShrink: 0 }}>
            <div style={{ fontSize: 12, color: C.amber, marginBottom: 8, fontWeight: 500 }}>
              ❓ {pending.question}
            </div>
            <form onSubmit={handleReply} style={{ display: "flex", gap: 8 }}>
              <input
                value={reply}
                onChange={e => setReply(e.target.value)}
                placeholder="Type your answer…"
                autoFocus
                style={{ flex: 1, background: C.surface, border: `1px solid ${C.amberDim}`,
                         borderRadius: 5, padding: "7px 10px", color: C.textPrimary,
                         fontSize: 13, fontFamily: FONT_SANS, outline: "none" }} />
              <button type="submit" disabled={!reply.trim()} style={amberBtn}>Reply</button>
            </form>
          </div>
        )}

        {/* Main input */}
        <div style={{ borderTop: `1px solid ${C.border}`, background: C.surface,
                      padding: "12px 16px", flexShrink: 0 }}>
          <form onSubmit={handleSubmit}
            style={{ display: "flex", gap: 8, alignItems: "center",
                     background: C.surfaceHi, border: `1px solid ${C.borderHi}`,
                     borderRadius: 8, padding: "4px 4px 4px 12px" }}>
            <span style={{ color: C.green, fontWeight: 700, fontSize: 14,
                           fontFamily: FONT_MONO, flexShrink: 0 }}>$</span>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Book a table for 2 at Nobu SF tonight at 7pm…"
              disabled={running}
              autoFocus={!pending}
              style={{ flex: 1, background: "transparent", border: "none",
                       outline: "none", color: C.textPrimary, fontSize: 13,
                       fontFamily: FONT_SANS, padding: "6px 0" }} />
            <button type="submit" disabled={running || !input.trim()}
              style={{ background: running || !input.trim() ? C.surface : C.greenBg,
                       border: `1px solid ${running || !input.trim() ? C.border : C.greenDim}`,
                       color: running || !input.trim() ? C.textMuted : C.green,
                       fontFamily: FONT_SANS, fontWeight: 600, fontSize: 13,
                       padding: "7px 16px", cursor: running || !input.trim() ? "not-allowed" : "pointer",
                       borderRadius: 6, flexShrink: 0 }}>
              {running ? "Running…" : "Run →"}
            </button>
          </form>
        </div>
      </div>

      {/* ── RIGHT: Screenshot panel ──────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column",
                    overflow: "hidden", background: C.base }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between",
                      alignItems: "center", padding: "12px 16px",
                      borderBottom: `1px solid ${C.border}`, background: C.surface,
                      flexShrink: 0 }}>
          <span style={{ color: C.textSecondary, fontSize: 11,
                         fontWeight: 600, letterSpacing: 1 }}>BROWSER VIEW</span>
          {screenshotStep > 0 && (
            <span style={{ color: C.textMuted, fontSize: 11,
                           fontFamily: FONT_MONO }}>step {screenshotStep}</span>
          )}
        </div>

        {screenshot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:image/png;base64,${screenshot}`}
            alt="Annotated browser screenshot with numbered element marks"
            style={{ width: "100%", height: "calc(100% - 45px)",
                     objectFit: "contain", objectPosition: "top center" }} />
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column" as const,
                        alignItems: "center", justifyContent: "center",
                        gap: 12, padding: 40, textAlign: "center" as const }}>
            <div style={{ width: 48, height: 48, borderRadius: 12,
                          background: C.surface, border: `1px solid ${C.border}`,
                          display: "flex", alignItems: "center",
                          justifyContent: "center", fontSize: 22 }}>🌐</div>
            <div style={{ color: C.textSecondary, fontSize: 14, fontWeight: 500 }}>
              Browser view
            </div>
            <div style={{ color: C.textMuted, fontSize: 12, lineHeight: 1.8,
                          maxWidth: 280 }}>
              Once a task starts, the live browser screenshot appears here —
              updated at every step with numbered marks over each interactive element.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Shared amber button style
const amberBtn: React.CSSProperties = {
  background: "#1a1200",
  border: `1px solid ${C.amberDim}`,
  color: C.amber,
  fontFamily: FONT_SANS,
  fontWeight: 600,
  fontSize: 12,
  padding: "7px 14px",
  cursor: "pointer",
  borderRadius: 6,
  flexShrink: 0,
};

// ---------------------------------------------------------------------------
// LogLine
// ---------------------------------------------------------------------------

const EVENT_COLORS: Record<StepEvent["type"], string> = {
  plan:      C.purple,
  observe:   C.blue,
  action:    C.green,
  ask_user:  C.amber,
  done:      C.green,
  give_up:   C.red,
  error:     C.red,
};

const EVENT_LABELS: Record<StepEvent["type"], string> = {
  plan:      "PLAN",
  observe:   "VIEW",
  action:    "ACT",
  ask_user:  "ASK",
  done:      "DONE",
  give_up:   "STOP",
  error:     "ERR",
};

const EVENT_ICONS: Record<StepEvent["type"], string> = {
  plan:      "🧭",
  observe:   "👁",
  action:    "▶",
  ask_user:  "❓",
  done:      "✓",
  give_up:   "✗",
  error:     "⚠",
};

function LogLine({ entry }: { entry: LogEntry }) {
  const { event } = entry;

  // done/give_up rendered in result block — skip here
  if (event.type === "done" || event.type === "give_up") return null;

  const isObserve = event.type === "observe";
  const color = EVENT_COLORS[event.type];
  const label = EVENT_LABELS[event.type];
  const icon  = EVENT_ICONS[event.type];

  return (
    <div style={{ display: "flex", gap: 0, padding: "3px 16px",
                  opacity: isObserve ? 0.45 : 1 }}>
      {/* Step badge */}
      <span style={{ color: C.textMuted, fontSize: 11, fontFamily: FONT_MONO,
                     flexShrink: 0, width: 28, paddingTop: 1 }}>
        {event.step > 0 ? String(event.step).padStart(2, "0") : "  "}
      </span>

      {/* Type tag */}
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                     color, flexShrink: 0, width: 38, paddingTop: 2,
                     fontFamily: FONT_SANS, opacity: isObserve ? 0.6 : 1 }}>
        {label}
      </span>

      {/* Icon */}
      <span style={{ fontSize: 11, flexShrink: 0, width: 18, paddingTop: 1 }}>
        {icon}
      </span>

      {/* Message */}
      <span style={{ fontSize: 12, color: isObserve ? C.textMuted : C.textPrimary,
                     lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word" as const,
                     fontFamily: event.type === "action" ? FONT_MONO : FONT_SANS }}>
        {event.message}
      </span>
    </div>
  );
}
