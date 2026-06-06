/**
 * app/api/agent/route.ts
 *
 * Streaming POST endpoint. Accepts { goal } and streams StepEvents as
 * newline-delimited JSON (NDJSON) back to the chat UI.
 *
 * Interactive ask_user: each run gets a `requestId`. When the agent pauses on
 * ask_user, we attach that id to the streamed event and await the user's reply,
 * which arrives on the sibling `POST /api/agent/reply` route (see ask-registry).
 */

import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { runAgent, type StepEvent } from "@/lib/agent";
import { waitForAnswer, cancelAnswer } from "@/lib/ask-registry";

export const runtime = "nodejs"; // Playwright requires Node.js runtime (not Edge)
export const maxDuration = 300;  // 5-minute timeout for long agent runs

export async function POST(req: NextRequest) {
  const body = await req.json();
  const goal: string = body.goal ?? "";
  // Per-user API key — takes precedence over the server's ANTHROPIC_API_KEY env var.
  // Transmitted over HTTPS, used only for this run, never logged or stored.
  const apiKey: string | undefined = body.apiKey || undefined;

  if (!goal.trim()) {
    return new Response(JSON.stringify({ error: "goal is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Require at least one key source
  if (!apiKey && !process.env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "No API key. Add ANTHROPIC_API_KEY to the server or enter your key in the UI." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // Correlates this run's ask_user pauses with replies on /api/agent/reply.
  const requestId = randomUUID();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: StepEvent) {
        // Tell the client where to POST the reply for any ask_user event.
        const payload = event.type === "ask_user" ? { ...event, requestId } : event;
        const line = JSON.stringify(payload) + "\n";
        controller.enqueue(encoder.encode(line));
      }

      try {
        const result = await runAgent({
          goal,
          maxSteps: parseInt(process.env.AGENT_MAX_STEPS ?? "40", 10),
          onStep: send,
          onAskUser: () => waitForAnswer(requestId),
          apiKey,  // undefined = fall back to server env var
        });

        // Final result event
        send({
          type: result.success ? "done" : "give_up",
          step: result.steps,
          message: result.summary,
          summary: result.summary,
          screenshotBase64: result.finalScreenshotBase64,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "error", step: 0, message: `Fatal agent error: ${message}` });
      } finally {
        cancelAnswer(requestId); // release any dangling waiter if we bailed early
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no", // disable Nginx buffering for streaming
    },
  });
}
