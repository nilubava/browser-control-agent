/**
 * lib/tools.ts
 *
 * Tool definitions in two forms:
 *
 *  1. ANTHROPIC_TOOLS — the JSON schema array passed directly to Anthropic's
 *     `tools` parameter. The model returns a `tool_use` block naming one of these.
 *
 *  2. TOOL_SCHEMAS — Zod schemas for each tool's input, used to parse + validate
 *     the raw JSON the model returns before we try to execute it.
 *
 * Tool list (matches the architecture spec):
 *  navigate, click, type, select_option, scroll, key,
 *  wait, extract, go_back, ask_user, done, give_up
 */

import { z } from "zod";
import type { Tool } from "@anthropic-ai/sdk/resources/messages.js";

// ---------------------------------------------------------------------------
// Anthropic tool definitions (JSON Schema)
// ---------------------------------------------------------------------------

export const ANTHROPIC_TOOLS: Tool[] = [
  {
    name: "navigate",
    description:
      "Navigate the browser to a URL. Use for the initial site visit and any full-page navigation. " +
      "Prepend https:// if missing.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "Absolute or protocol-relative URL to navigate to.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "click",
    description:
      "Click an element by its mark number from the current observation. " +
      "Use for buttons, links, dropdown triggers, calendar days, and any non-input interactive element.",
    input_schema: {
      type: "object" as const,
      properties: {
        element_id: {
          type: "number",
          description: "The mark number shown on the annotated screenshot.",
        },
      },
      required: ["element_id"],
    },
  },
  {
    name: "type",
    description:
      "Focus an input or textarea and type text into it. Optionally press Enter to submit. " +
      "Use for search boxes, form fields, date inputs. " +
      "IMPORTANT: for native <select> elements use select_option instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        element_id: {
          type: "number",
          description: "The mark number of the input element.",
        },
        text: {
          type: "string",
          description: "Text to type.",
        },
        submit: {
          type: "boolean",
          description: "If true, presses Enter after typing. Default false.",
        },
      },
      required: ["element_id", "text"],
    },
  },
  {
    name: "select_option",
    description:
      "Select a value from a native HTML <select> element (role=combobox with tag=select). " +
      "Do NOT use for custom dropdown widgets — for those, click the trigger then click the option.",
    input_schema: {
      type: "object" as const,
      properties: {
        element_id: {
          type: "number",
          description: "The mark number of the <select> element.",
        },
        value: {
          type: "string",
          description: "The option value or visible label text to select.",
        },
      },
      required: ["element_id", "value"],
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the page or a specific element into view. Use to reveal content below the fold, " +
      "load more items, or bring a partially-visible element into view before clicking.",
    input_schema: {
      type: "object" as const,
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction.",
        },
        element_id: {
          type: "number",
          description:
            "Optional — if provided, scrolls this element into view instead of scrolling the page.",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "key",
    description:
      "Press a keyboard key or chord. Useful for dismissing modals (Escape), " +
      "navigating calendar pickers (ArrowRight, ArrowDown), Tab through fields, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        keys: {
          type: "string",
          description:
            'Key or chord in Playwright format: "Escape", "Enter", "Tab", "ArrowDown", "Control+a", etc.',
        },
      },
      required: ["keys"],
    },
  },
  {
    name: "wait",
    description:
      "Explicitly wait for a page transition or async content to appear. " +
      "Use after actions that trigger slow loads (search submission, payment processing). " +
      "Keep ms low — 2000ms max before re-observing.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Human-readable reason for waiting (for logging).",
        },
        ms: {
          type: "number",
          description: "Milliseconds to wait. Default 1500, max 3000.",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "extract",
    description:
      "Extract visible text from the current page. Use to read confirmation numbers, " +
      "prices, flight details, apartment listings, weather data, or any result to include in the report.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "What you are trying to extract (e.g. 'confirmation number', 'flight prices and times').",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "go_back",
    description:
      "Navigate back one page in browser history. Use when you ended up on the wrong page " +
      "or want to try a different path.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ask_user",
    description:
      "Pause the agent and ask the user a question. Use for: " +
      "(1) CAPTCHA detected, (2) login credentials required, " +
      "(3) genuine ambiguity in the original request that needs clarification. " +
      "Do NOT use for things you can figure out from the page.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user. Be specific about what you need.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "done",
    description:
      "Signal successful completion. Call this ONLY when you have verified the goal was achieved " +
      "(confirmation page visible, data extracted, etc.). Include all relevant details in summary.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description:
            "Full report of what was accomplished: confirmation numbers, prices, " +
            "reservation details, search results, or whatever the user asked for.",
        },
        confirmation: {
          type: "string",
          description:
            "Optional extracted confirmation code, booking reference, or key data point.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "give_up",
    description:
      "Gracefully abandon the task after exhausting reasonable approaches. " +
      "Explain clearly what you tried and why it failed — this is a valid, " +
      "useful response (better than looping forever or hallucinating success).",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description:
            "Clear explanation of what was attempted, what failed, and why the task cannot be completed. " +
            "Include suggestions for how the user could do it manually.",
        },
      },
      required: ["reason"],
    },
    // Cache the entire tools array after the first step — it never changes mid-run.
    // Anthropic caches everything up to and including the block marked ephemeral,
    // so this one annotation on the last tool covers all 12 definitions (~2 500 tokens).
    cache_control: { type: "ephemeral" } as const,
  },
];

// ---------------------------------------------------------------------------
// Zod input schemas (mirror the JSON schemas above; used for runtime validation)
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS = {
  navigate: z.object({
    url: z.string().min(1),
  }),

  click: z.object({
    element_id: z.number().int().positive(),
  }),

  type: z.object({
    element_id: z.number().int().positive(),
    text: z.string(),
    submit: z.boolean().optional().default(false),
  }),

  select_option: z.object({
    element_id: z.number().int().positive(),
    value: z.string().min(1),
  }),

  scroll: z.object({
    direction: z.enum(["up", "down", "left", "right"]),
    element_id: z.number().int().positive().optional(),
  }),

  key: z.object({
    keys: z.string().min(1),
  }),

  wait: z.object({
    reason: z.string(),
    ms: z.number().int().min(100).max(3_000).optional().default(1_500),
  }),

  extract: z.object({
    query: z.string().min(1),
  }),

  go_back: z.object({}),

  ask_user: z.object({
    question: z.string().min(1),
  }),

  done: z.object({
    summary: z.string().min(1),
    confirmation: z.string().optional(),
  }),

  give_up: z.object({
    reason: z.string().min(1),
  }),
} as const;

// ---------------------------------------------------------------------------
// Parsed tool call union type — what the agent loop works with
// ---------------------------------------------------------------------------

export type ToolCall =
  | { tool: "navigate";      input: z.infer<typeof TOOL_SCHEMAS.navigate> }
  | { tool: "click";         input: z.infer<typeof TOOL_SCHEMAS.click> }
  | { tool: "type";          input: z.infer<typeof TOOL_SCHEMAS.type> }
  | { tool: "select_option"; input: z.infer<typeof TOOL_SCHEMAS.select_option> }
  | { tool: "scroll";        input: z.infer<typeof TOOL_SCHEMAS.scroll> }
  | { tool: "key";           input: z.infer<typeof TOOL_SCHEMAS.key> }
  | { tool: "wait";          input: z.infer<typeof TOOL_SCHEMAS.wait> }
  | { tool: "extract";       input: z.infer<typeof TOOL_SCHEMAS.extract> }
  | { tool: "go_back";       input: z.infer<typeof TOOL_SCHEMAS.go_back> }
  | { tool: "ask_user";      input: z.infer<typeof TOOL_SCHEMAS.ask_user> }
  | { tool: "done";          input: z.infer<typeof TOOL_SCHEMAS.done> }
  | { tool: "give_up";       input: z.infer<typeof TOOL_SCHEMAS.give_up> };

/** Parse + validate a raw tool_use block from the Anthropic response */
export function parseToolCall(name: string, rawInput: unknown): ToolCall {
  const schema = TOOL_SCHEMAS[name as keyof typeof TOOL_SCHEMAS];
  if (!schema) {
    throw new Error(`Unknown tool: "${name}"`);
  }
  const input = schema.parse(rawInput);
  return { tool: name, input } as ToolCall;
}

/** Terminal tools — when the model calls one of these, the loop ends */
export const TERMINAL_TOOLS = new Set(["done", "give_up"]);
