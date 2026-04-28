export function sanitizeLogValue(value: unknown): string {
  return String(value).replace(/[\r\n]/g, ' ').replace(/%/g, '%%');
}
