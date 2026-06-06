/**
 * scripts/run-agent.ts
 *
 * CLI harness to drive the agent directly (no Next.js) so the full loop is
 * visible in the terminal. Screenshots are written to ./screenshots/ instead
 * of dumping base64 into the console.
 *
 * Usage:
 *   npm run agent -- "Look up the weekend weather forecast for San Francisco and summarize it"
 */

import fs from "fs";
import path from "path";

// ── Minimal .env.local loader (no dotenv dependency) ────────────────────────
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// Import AFTER env is loaded so the Anthropic client picks up the key.
const { runAgent, closeBrowser } = await import("../lib/agent");

const goal =
  process.argv.slice(2).join(" ").trim() ||
  "Look up the weekend weather forecast for San Francisco and summarize it";

// Screenshot output dir
const shotDir = path.resolve(process.cwd(), "screenshots");
fs.mkdirSync(shotDir, { recursive: true });

function fmt(s: string, max = 600): string {
  const clean = s.replace(/\n/g, "\n          ");
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

console.log("─".repeat(72));
console.log("GOAL:", goal);
console.log("MODELS:", process.env.AGENT_MODEL ?? "claude-sonnet-4-6", "/", process.env.PLANNER_MODEL ?? "claude-sonnet-4-6");
console.log("HEADLESS:", process.env.BROWSER_HEADLESS === "true");
console.log("─".repeat(72));

let shotCount = 0;

const result = await runAgent({
  goal,
  onStep: (e) => {
    const tag = e.type.toUpperCase().padEnd(8);
    const step = String(e.step).padStart(2, "0");
    console.log(`[${step}] ${tag} ${fmt(e.message)}`);

    // Persist screenshots so we can eyeball what the agent saw.
    if (e.screenshotBase64) {
      const file = path.join(shotDir, `step-${String(++shotCount).padStart(2, "0")}-${e.type}.png`);
      fs.writeFileSync(file, Buffer.from(e.screenshotBase64, "base64"));
    }
  },
}).catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.message : err);
  return null;
});

console.log("─".repeat(72));
if (result) {
  console.log("SUCCESS :", result.success);
  console.log("STEPS   :", result.steps);
  console.log("SUMMARY :", result.summary);
  if (result.confirmation) console.log("CONFIRM :", result.confirmation);
}
console.log(`Screenshots: ${shotDir} (${shotCount} captured)`);
console.log("─".repeat(72));

await closeBrowser();
process.exit(result?.success ? 0 : 1);
