/**
 * Limits on sources added by AI agents (MCP add_source). Constants only, so
 * the Settings page can show them without importing server code.
 */

/** Links per add_source call. */
export const MAX_PER_CALL = 5;
/** Items per rolling 24 hours, across all agents. */
export const MAX_PER_DAY = 20;
