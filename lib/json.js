/**
 * A JSON parser that keeps key order and reports errors by line and column. With `jsonc`, comments
 * and trailing commas are accepted (tsconfig.json, .jsonc files).
 */
import { errorAt, scalar } from './common.js';

const ESCAPE_CHARS = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** Files named .json that are conventionally JSON with comments. */
export const isJsonc = (path) => /\.jsonc$/i.test(path) || /(^|[\\/])(tsconfig|jsconfig)[^\\/]*\.json$|[\\/]\.vscode[\\/][^\\/]+\.json$|devcontainer\.json$/i.test(path);

export function parseJson(text, { jsonc = false } = {}) {
  let i = 0;
  const fail = (message, at = i) => {
    throw errorAt(text, at, message);
  };
  const describe = () => (i >= text.length ? 'end of file' : `'${text[i]}'`);

  function skip() {
    for (;;) {
      while (i < text.length && ' \t\r\n﻿'.includes(text[i])) i++;
      if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
        if (!jsonc) fail('Comments are not allowed in JSON');
        if (text[i + 1] === '/') {
          while (i < text.length && text[i] !== '\n') i++;
        } else {
          const end = text.indexOf('*/', i + 2);
          if (end === -1) fail('Unterminated comment');
          i = end + 2;
        }
        continue;
      }
      return;
    }
  }

  function value() {
    skip();
    const ch = text[i];
    if (ch === '{') return object();
    if (ch === '[') return array();
    if (ch === '"') return scalar('string', string());
    if (ch === '-' || (ch >= '0' && ch <= '9')) return number();
    for (const [word, node] of [['true', scalar('boolean', true)], ['false', scalar('boolean', false)], ['null', scalar('null', null)]]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return node;
      }
    }
    return fail(`Expected a value but found ${describe()}`);
  }

  function object() {
    const start = i++;
    const entries = [];
    const seen = new Set();
    skip();
    if (text[i] === '}') {
      i++;
      return { type: 'object', entries };
    }
    for (;;) {
      skip();
      if (text[i] !== '"') fail(i >= text.length ? `Unclosed '{' opened at ${where(start)}` : `Expected a property name in double quotes but found ${describe()}`);
      const keyAt = i;
      const key = string();
      if (seen.has(key)) fail(`Duplicate key "${key}"`, keyAt);
      seen.add(key);
      skip();
      if (text[i] !== ':') fail(`Expected ':' after property name but found ${describe()}`);
      i++;
      entries.push({ key, value: value() });
      skip();
      if (text[i] === ',') {
        i++;
        skip();
        if (text[i] === '}') {
          if (!jsonc) fail('Trailing comma before }');
          i++;
          return { type: 'object', entries };
        }
        continue;
      }
      if (text[i] === '}') {
        i++;
        return { type: 'object', entries };
      }
      fail(i >= text.length ? `Unclosed '{' opened at ${where(start)}` : `Expected ',' or '}' but found ${describe()}`);
    }
  }

  function array() {
    const start = i++;
    const items = [];
    skip();
    if (text[i] === ']') {
      i++;
      return { type: 'array', items };
    }
    for (;;) {
      items.push(value());
      skip();
      if (text[i] === ',') {
        i++;
        skip();
        if (text[i] === ']') {
          if (!jsonc) fail('Trailing comma before ]');
          i++;
          return { type: 'array', items };
        }
        continue;
      }
      if (text[i] === ']') {
        i++;
        return { type: 'array', items };
      }
      fail(i >= text.length ? `Unclosed '[' opened at ${where(start)}` : `Expected ',' or ']' but found ${describe()}`);
    }
  }

  function string() {
    const start = i++;
    let out = '';
    for (;;) {
      const ch = text[i];
      if (ch === undefined || ch === '\n') fail('Unterminated string', start);
      if (ch === '"') {
        i++;
        return out;
      }
      if (ch < ' ') fail('Control characters must be escaped in strings');
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        if (!(next in ESCAPE_CHARS)) fail(`Invalid escape '\\${next ?? ''}'`);
        out += ESCAPE_CHARS[next];
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
  }

  function number() {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail('Invalid number');
    i += m[0].length;
    if (/^[\w.]/.test(text[i] ?? '')) fail('Invalid number');
    return scalar('number', Number(m[0]), m[0]);
  }

  function where(at) {
    const { line, column } = errorAt(text, at, '');
    return `line ${line}, column ${column}`;
  }

  skip();
  if (i >= text.length) return null;
  const root = value();
  skip();
  if (i < text.length) fail(`Unexpected ${describe()} after the end of the document`);
  return root;
}
