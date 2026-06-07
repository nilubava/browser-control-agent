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
 * LIMITATION: this is in-memory state, so it only works for a single server
 * instance (fine for local/demo; would need Redis or similar to scale
 * horizontally).
 *
 * Why globalThis: in the Next.js App Router each route segment is bundled
 * separately, so a plain module-level `const map = new Map()` is instantiated
 * ONCE PER ROUTE that imports it. `/api/agent` (which calls waitForAnswer) and
 * `/api/agent/reply` (which calls provideAnswer) would then each get their OWN
 * copies — the reply writes to one map while the paused agent waits forever on
 * the other, so the run hangs after the user answers an ask_user prompt.
 * Anchoring the maps on globalThis gives every bundle the same singleton. This
 * also survives dev-mode hot reloads, which re-evaluate modules.
 */

type Resolver = (answer: string) => void;

interface AskRegistryStore {
  pendingResolvers: Map<string, Resolver>;
  bufferedAnswers: Map<string, string>;
}

const globalStore = globalThis as typeof globalThis & {
  __askRegistry?: AskRegistryStore;
};

const store: AskRegistryStore =
  globalStore.__askRegistry ??
  (globalStore.__askRegistry = {
    pendingResolvers: new Map<string, Resolver>(),
    bufferedAnswers: new Map<string, string>(),
  });

const { pendingResolvers, bufferedAnswers } = store;

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
