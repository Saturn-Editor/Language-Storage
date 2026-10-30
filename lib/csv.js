/**
 * RFC 4180 CSV parsing with delimiter detection: quoted fields may hold delimiters, doubled quotes
 * and line breaks.
 */
import { ParseError } from './common.js';

const CANDIDATES = [',', ';', '\t', '|'];

/** Picks the delimiter that appears most (outside quotes) on the first line. */
export function detectDelimiter(text, path = '') {
  if (/\.tsv$|\.tab$/i.test(path)) return '\t';
  const first = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  let best = ',';
  let bestCount = 0;
  for (const d of CANDIDATES) {
    let count = 0;
    let quoted = false;
    for (const ch of first) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Returns rows of fields. A trailing newline does not add an empty row. */
export function parseCsv(text, delimiter = ',') {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let line = 1;
  let fieldStarted = false;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' && !fieldStarted) {
      const startLine = line;
      i++;
      for (;;) {
        if (i >= src.length) throw new ParseError('Unterminated quoted field', startLine, 1);
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (src[i] === '\n') line++;
        field += src[i++];
      }
      fieldStarted = true;
      // Lenient: text after a closing quote is kept rather than rejected.
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = false;
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line++;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i++;
  }
  if (fieldStarted || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Like parseCsv, but each field is { value, offset } with the offset of its first character. Never throws. */
export function fieldsWithOffsets(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = { value: '', offset: 0 };
  let i = text.startsWith('﻿') ? 1 : 0;
  field.offset = i;
  let fieldStarted = false;
  const endField = (next) => {
    row.push(field);
    field = { value: '', offset: next };
    fieldStarted = false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' && !fieldStarted) {
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            field.value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field.value += text[i++];
      }
      fieldStarted = true;
      continue;
    }
    if (ch === delimiter) {
      endField(i + 1);
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      const next = i + (ch === '\r' && text[i + 1] === '\n' ? 2 : 1);
      endField(next);
      rows.push(row);
      row = [];
      i = next;
      continue;
    }
    field.value += ch;
    fieldStarted = true;
    i++;
  }
  if (fieldStarted || row.length) {
    endField(i);
    rows.push(row);
  }
  return rows;
}
