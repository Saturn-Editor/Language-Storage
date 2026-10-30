/**
 * Shared pieces for the format parsers. Every structured parser (JSON, YAML, TOML, INI) produces the
 * same small data model so one tree renderer can show them all:
 *
 *   { type: 'object', entries: [{ key, value }] }   keys keep their source order
 *   { type: 'array', items: [node] }
 *   { type: 'string' | 'number' | 'boolean' | 'null' | 'date', value, raw? }
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** A parse failure with a 1-based line and column. */
export class ParseError extends Error {
  constructor(message, line, column) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

/** 1-based line and column of a character offset. */
export function positionAt(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export const errorAt = (text, offset, message) => {
  const { line, column } = positionAt(text, offset);
  return new ParseError(message, line, column);
};

export const scalar = (type, value, raw) => (raw === undefined ? { type, value } : { type, value, raw });

/** Converts the data model to plain JavaScript values (used by tests and by callers who want JSON). */
export function toPlain(node) {
  if (node.type === 'object') return Object.fromEntries(node.entries.map(({ key, value }) => [key, toPlain(value)]));
  if (node.type === 'array') return node.items.map(toPlain);
  return node.value;
}

/** Maps character offsets to 0-based LSP positions, and back, for one text. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const position = (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - starts[lo] };
  };
  const offset = ({ line, character }) => Math.min(text.length, (starts[line] ?? text.length) + character);
  return { position, offset, lines: starts.length };
}

/** Replaces each match's characters (except line breaks) with spaces, so offsets stay put. */
export const blank = (text, pattern) => text.replace(pattern, (m) => m.replace(/[^\n]/g, ' '));
