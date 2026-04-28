import { describe, expect, it } from 'vitest';
import { yamlDoubleQuote } from '../lib/yaml-escape';

const ch = (cp: number) => String.fromCodePoint(cp);

describe('yamlDoubleQuote', () => {
  it('wraps plain ASCII in double quotes', () => {
    expect(yamlDoubleQuote('hello')).toBe('"hello"');
  });

  it('escapes backslashes BEFORE double quotes', () => {
    expect(yamlDoubleQuote('C:\\Users')).toBe('"C:\\\\Users"');
    expect(yamlDoubleQuote('a"b')).toBe('"a\\"b"');
    expect(yamlDoubleQuote('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('escapes newline, carriage return, tab', () => {
    expect(yamlDoubleQuote('line1\nline2')).toBe('"line1\\nline2"');
    expect(yamlDoubleQuote('a\rb')).toBe('"a\\rb"');
    expect(yamlDoubleQuote('col1\tcol2')).toBe('"col1\\tcol2"');
  });

  it('strips C0 control characters except tab', () => {
    expect(yamlDoubleQuote('a' + ch(0x00) + 'b')).toBe('"ab"');
    expect(yamlDoubleQuote('a' + ch(0x01) + 'b')).toBe('"ab"');
    expect(yamlDoubleQuote('a' + ch(0x08) + 'b')).toBe('"ab"');
    expect(yamlDoubleQuote('a' + ch(0x0b) + 'b')).toBe('"ab"');
    expect(yamlDoubleQuote('a' + ch(0x1f) + 'b')).toBe('"ab"');
  });

  it('escapes tab via the \\t form rather than stripping', () => {
    expect(yamlDoubleQuote('a' + ch(0x09) + 'b')).toBe('"a\\tb"');
  });

  it('strips C1 control characters', () => {
    expect(yamlDoubleQuote('a' + ch(0x80) + 'b')).toBe('"ab"');
    expect(yamlDoubleQuote('a' + ch(0x9f) + 'b')).toBe('"ab"');
  });

  it('strips DEL (U+007F)', () => {
    expect(yamlDoubleQuote('a' + ch(0x7f) + 'b')).toBe('"ab"');
  });

  it('strips Unicode line separators U+2028 / U+2029', () => {
    expect(yamlDoubleQuote('a' + ch(0x2028) + 'b')).toBe('"ab"');
    expect(yamlDoubleQuote('a' + ch(0x2029) + 'b')).toBe('"ab"');
  });

  it('strips BOM (U+FEFF)', () => {
    expect(yamlDoubleQuote(ch(0xfeff) + 'hello')).toBe('"hello"');
  });

  it('handles empty string', () => {
    expect(yamlDoubleQuote('')).toBe('""');
  });

  it('preserves printable Unicode (CJK, emoji, accents)', () => {
    expect(yamlDoubleQuote('café')).toBe('"café"');
    expect(yamlDoubleQuote('日本語')).toBe('"日本語"');
    expect(yamlDoubleQuote('hi 👋')).toBe('"hi 👋"');
  });

  it('round-trips: title with quotes, backslashes, and newlines is parseable', () => {
    const title = 'Foo "bar"\\baz\nqux';
    const yaml = `title: ${yamlDoubleQuote(title)}\n`;
    const m = yaml.match(/^title:\s*"((?:[^"\\]|\\.)*)"$/m);
    expect(m).not.toBeNull();
    const decoded = m![1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    expect(decoded).toBe(title);
  });
});
