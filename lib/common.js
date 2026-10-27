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
