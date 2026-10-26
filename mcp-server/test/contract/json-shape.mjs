/**
 * Compare a live app response with a contract fixture (app-responses.json),
 * by shape, not by value. Shared by the app's contract test
 * (app/src/__tests__/mcp-contract.test.ts) and scripts/mcp-smoke.mjs, so
 * both hold the app to the fields the MCP tools read.
 *
 * - Every key of an expected object must be in the actual one, with the same
 *   JSON type. Extra keys are fine: the MCP server ignores them.
 * - null on either side matches any type (nullable fields).
 * - Each actual array element is checked against the first expected one.
 *   An array that is empty everywhere it appears can't be checked: its path
 *   (indices as [*]) goes to `unverified`.
 * - An expected object whose only key is "*" is a map keyed by data (e.g.
 *   category names): every actual value is checked against it, and an empty
 *   map goes to `unverified` the same way.
 *
 * @param {unknown} expected
 * @param {unknown} actual
 * @returns {{ errors: string[], unverified: string[] }}
 */
export function compareShape(expected, actual) {
  const state = { errors: [], checked: new Set(), empty: new Set() };
  walk(expected, actual, '$', '$', state);
  return { errors: state.errors, unverified: [...state.empty].filter((p) => !state.checked.has(p)) };
}

/** "string", "number", "boolean", "null", "array", "object" or "undefined". */
export function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function walk(expected, actual, path, pattern, state) {
  const want = jsonType(expected);
  const got = jsonType(actual);
  if (got === 'undefined') {
    state.errors.push(`${path}: missing (expected ${want})`);
    return;
  }
  if (want === 'null' || got === 'null') return;
  if (want !== got) {
    state.errors.push(`${path}: expected ${want}, got ${got}`);
    return;
  }
  if (want === 'array') {
    if (!expected.length) return;
    (actual.length ? state.checked : state.empty).add(pattern);
    actual.forEach((item, i) => walk(expected[0], item, `${path}[${i}]`, `${pattern}[*]`, state));
    return;
  }
  if (want === 'object') {
    const keys = Object.keys(expected);
    if (keys.length === 1 && keys[0] === '*') {
      const entries = Object.entries(actual);
      (entries.length ? state.checked : state.empty).add(`${pattern}.*`);
      for (const [key, value] of entries) walk(expected['*'], value, `${path}.${key}`, `${pattern}.*`, state);
      return;
    }
    for (const key of keys) {
      walk(expected[key], actual[key], `${path}.${key}`, `${pattern}.${key}`, state);
    }
  }
}
