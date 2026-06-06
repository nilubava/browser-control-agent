/**
 * app/api/agent/reply/route.ts
 *
 * Receives the user's answer to an ask_user pause and hands it to the waiting
 * agent run (matched by requestId). The agent's main event stream stays open on
 * the sibling /api/agent route and resumes once this resolves.
 */

import { NextRequest } from "next/server";
import { provideAnswer } from "@/lib/ask-registry";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const requestId: string | undefined = body?.requestId;
  const answer: string | undefined = body?.answer;

  if (!requestId || typeof answer !== "string") {
    return new Response(
      JSON.stringify({ error: "requestId and answer are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  provideAnswer(requestId, answer);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
