import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/** A plain-text tool result. */
export function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

/**
 * A failed call. `isError` tells the agent the call didn't work (as opposed to
 * an empty answer), so it can retry, fix its input, or tell the user.
 */
export function failure(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }], isError: true };
}

/** Annotations for tools that only read the user's own wiki. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
