/**
 * lib/ask-registry.ts
 *
 * Bridges the agent's ask_user pause with the user's reply, which arrives on a
 * SEPARATE HTTP request (`POST /api/agent/reply`) while the original agent
 * stream is still open.
 *
 * Design:
 *  - The streaming route owns a `requestId` per agent run.
 *  - When the agent calls ask_user, it `await`s waitForAnswer(requestId).
 *  - The reply route calls provideAnswer(requestId, answer), which resolves
 *    that promise so the loop continues.
 *
 * The buffering (answers that arrive before the agent registers its waiter)
 * makes this race-free regardless of network timing.
 *
 * LIMITATION: this is module-level in-memory state, so it only works for a
 * single server instance (fine for local/demo; would need Redis or similar to
 * scale horizontally).
 */

type Resolver = (answer: string) => void;

const pendingResolvers = new Map<string, Resolver>();
const bufferedAnswers = new Map<string, string>();

/** Called by the agent when it needs input. Resolves when the user replies. */
export function waitForAnswer(requestId: string): Promise<string> {
  const buffered = bufferedAnswers.get(requestId);
  if (buffered !== undefined) {
    bufferedAnswers.delete(requestId);
    return Promise.resolve(buffered);
  }
  return new Promise<string>((resolve) => {
    pendingResolvers.set(requestId, resolve);
  });
}

/** Called by the reply route. Returns true if a waiter (or buffer slot) accepted it. */
export function provideAnswer(requestId: string, answer: string): boolean {
  const resolve = pendingResolvers.get(requestId);
  if (resolve) {
    pendingResolvers.delete(requestId);
    resolve(answer);
    return true;
  }
  // The reply beat the agent's waiter — buffer it so waitForAnswer resolves
  // immediately when it registers.
  bufferedAnswers.set(requestId, answer);
  return true;
}

/** Cleanup for an abandoned run (stream closed before the user answered). */
export function cancelAnswer(requestId: string): void {
  pendingResolvers.delete(requestId);
  bufferedAnswers.delete(requestId);
}
