const STRIP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u2028\u2029\uFEFF]/g;

export function yamlDoubleQuote(input: string): string {
  const stripped = input.replace(STRIP_RE, '');
  const escaped = stripped
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}
