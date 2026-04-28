const ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,79})$/;

export type SafeIdKind = 'source' | 'page';

export function assertSafeId(id: unknown, kind: SafeIdKind): asserts id is string {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new TypeError(`invalid_${kind}_id`);
  }
}

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}
