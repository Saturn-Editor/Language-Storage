/**
 * A TOML 1.0 parser producing the shared data model: tables, arrays of tables, dotted keys, inline
 * tables, all four string forms, integers (with _ and 0x/0o/0b), floats, booleans and date-times.
 */
import { errorAt, scalar } from './common.js';

const BARE_KEY = /^[A-Za-z0-9_-]+/;
const DATETIME = /^\d{4}-\d\d-\d\d(?:[Tt ]\d\d:\d\d:\d\d(?:\.\d+)?(?:[Zz]|[-+]\d\d:\d\d)?)?|^\d\d:\d\d:\d\d(?:\.\d+)?/;
const BASIC_ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

/** Tables are built as { node, kind, defined } so redefinitions can be reported. */
const newTable = (kind) => ({ node: { type: 'object', entries: [] }, kind, defined: false, children: new Map() });

export function parseToml(text) {
  const src = text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
  let i = 0;
  const fail = (message, at = i) => {
    throw errorAt(src, at, message);
  };

  const root = newTable('table');
  let current = root;

  /** Adds a child to a table's node, keeping a parallel map of child tables for lookups. */
  function setChild(table, key, value, at) {
    if (table.children.has(key)) fail(`Duplicate key "${key}"`, at);
    table.children.set(key, value);
    table.node.entries.push({ key, value: value.node ?? value });
  }

  function child(table, key, at, kind = 'implicit') {
    const existing = table.children.get(key);
    if (existing === undefined) {
      const t = newTable(kind);
      setChild(table, key, t, at);
      return t;
    }
    if (existing.kind === 'array') return existing.tables[existing.tables.length - 1];
    if (!existing.children || existing.kind === 'inline') fail(`"${key}" is already defined as a value`, at);
    return existing;
  }

  const spaces = () => {
    while (src[i] === ' ' || src[i] === '\t') i++;
  };
  function blank() {
    for (;;) {
      spaces();
      if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
      if (src[i] === '\n') i++;
      else if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
      else return;
    }
  }
  function endOfLine() {
    spaces();
    if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
    if (i < src.length && src[i] !== '\n') fail(`Expected the end of the line but found '${src[i]}'`);
  }

  function key() {
    const parts = [];
    for (;;) {
      spaces();
      const at = i;
      if (src[i] === '"') parts.push({ name: basicString(), at });
      else if (src[i] === "'") parts.push({ name: literalString(), at });
      else {
        const m = BARE_KEY.exec(src.slice(i));
        if (!m) fail(i >= src.length || src[i] === '\n' ? 'Expected a key' : `Invalid character '${src[i]}' in a key`);
        parts.push({ name: m[0], at });
        i += m[0].length;
      }
      spaces();
      if (src[i] !== '.') return parts;
      i++;
    }
  }

  /** Parses "a.b.c = value" into `table`. */
  function keyValue(table, inline = false) {
    const parts = key();
    if (src[i] !== '=') fail(`Expected '=' after a key`);
    i++;
    spaces();
    let target = table;
    for (const part of parts.slice(0, -1)) {
      target = child(target, part.name, part.at, inline ? 'inline' : 'dotted');
      if (target.kind === 'table' && target.defined && !inline && target !== table) {
        fail(`Table "${part.name}" was already defined with a header`, part.at);
      }
    }
    const last = parts[parts.length - 1];
    setChild(target, last.name, value(), last.at);
  }

  function value() {
    const ch = src[i];
    if (ch === '"') return scalar('string', src.startsWith('"""', i) ? multilineBasic() : basicString());
    if (ch === "'") return scalar('string', src.startsWith("'''", i) ? multilineLiteral() : literalString());
    if (ch === '[') return array();
    if (ch === '{') return inlineTable();
    const rest = src.slice(i, i + 64);
    let m;
    if ((m = /^(?:true|false)(?![\w-])/.exec(rest))) {
      i += m[0].length;
      return scalar('boolean', m[0] === 'true', m[0]);
    }
    if ((m = DATETIME.exec(rest)) && !/^\d/.test(rest.slice(m[0].length))) {
      i += m[0].length;
      return scalar('date', m[0]);
    }
    if ((m = /^[+-]?(?:inf|nan)(?![\w-])/.exec(rest))) {
      i += m[0].length;
      return scalar('number', m[0].includes('nan') ? NaN : m[0].startsWith('-') ? -Infinity : Infinity, m[0]);
    }
    if ((m = /^0x[0-9a-fA-F](?:_?[0-9a-fA-F])*|^0o[0-7](?:_?[0-7])*|^0b[01](?:_?[01])*/.exec(rest))) {
      i += m[0].length;
      const digits = m[0].slice(2).replace(/_/g, '');
      return scalar('number', parseInt(digits, { x: 16, o: 8, b: 2 }[m[0][1]]), m[0]);
    }
    if ((m = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/.exec(rest)) && m[0] !== '' && !/^[\w.]/.test(rest.slice(m[0].length))) {
      i += m[0].length;
      return scalar('number', Number(m[0].replace(/_/g, '')), m[0]);
    }
    return fail(i >= src.length || ch === '\n' ? 'Expected a value' : `Invalid value starting with '${ch}'`);
  }

  function basicString() {
    const start = i++;
    let out = '';
    for (;;) {
      const ch = src[i];
      if (ch === undefined || ch === '\n') fail('Unterminated string', start);
      if (ch === '"') {
        i++;
        return out;
      }
      if (ch === '\\') out += escape();
      else {
        out += ch;
        i++;
      }
    }
  }

  function escape() {
    const next = src[i + 1];
    if (next === 'u' || next === 'U') {
      const len = next === 'u' ? 4 : 8;
      const hex = src.slice(i + 2, i + 2 + len);
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) fail(`Invalid \\${next} escape`);
      i += 2 + len;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (!(next in BASIC_ESCAPES)) fail(`Invalid escape '\\${next ?? ''}'`);
    i += 2;
    return BASIC_ESCAPES[next];
  }

  function literalString() {
    const start = i++;
    const end = src.indexOf("'", i);
    const nl = src.indexOf('\n', i);
    if (end === -1 || (nl !== -1 && nl < end)) fail('Unterminated string', start);
    i = end + 1;
    return src.slice(start + 1, end);
  }

  function multilineBasic() {
    const start = i;
    i += 3;
    if (src[i] === '\n') i++;
    let out = '';
    for (;;) {
      if (i >= src.length) fail('Unterminated multi-line string', start);
      if (src.startsWith('"""', i)) {
        // Up to two quotes may sit right before the closing delimiter.
        let n = 3;
        while (src[i + n] === '"' && n < 5) n++;
        out += '"'.repeat(n - 3);
        i += n;
        return out;
      }
      if (src[i] === '\\') {
        // A backslash at the end of a line trims the line break and following whitespace.
        const m = /^\\[ \t]*\n[\s]*/.exec(src.slice(i));
        if (m) {
          i += m[0].length;
          continue;
        }
        out += escape();
        continue;
      }
      out += src[i++];
    }
  }

  function multilineLiteral() {
    const start = i;
    i += 3;
    if (src[i] === '\n') i++;
    const end = src.indexOf("'''", i);
    if (end === -1) fail('Unterminated multi-line string', start);
    let close = end;
    while (src[close + 3] === "'" && close - end < 2) close++;
    const out = src.slice(i, close);
    i = close + 3;
    return out;
  }

  function array() {
    const start = i++;
    const items = [];
    for (;;) {
      blank();
      if (src[i] === ']') {
        i++;
        return { type: 'array', items };
      }
      if (i >= src.length) fail("Unclosed '['", start);
      items.push(value());
      blank();
      if (src[i] === ',') i++;
      else if (src[i] !== ']') fail(`Expected ',' or ']' in an array`);
    }
  }

  function inlineTable() {
    const start = i++;
    const table = newTable('inline');
    spaces();
    if (src[i] === '}') {
      i++;
      return table.node;
    }
    for (;;) {
      keyValue(table, true);
      spaces();
      if (src[i] === '}') {
        i++;
        return table.node;
      }
      if (src[i] !== ',') fail(i >= src.length || src[i] === '\n' ? `Unclosed '{'` : `Expected ',' or '}' in an inline table`, i >= src.length ? start : i);
      i++;
    }
  }

  function header() {
    const start = i;
    const isArray = src.startsWith('[[', i);
    i += isArray ? 2 : 1;
    const parts = key();
    if (!src.startsWith(isArray ? ']]' : ']', i)) fail(`Expected '${isArray ? ']]' : ']'}' to close the table header`);
    i += isArray ? 2 : 1;
    endOfLine();

    let table = root;
    for (const part of parts.slice(0, -1)) table = child(table, part.name, part.at);
    const last = parts[parts.length - 1];
    const existing = table.children.get(last.name);
    if (isArray) {
      let list = existing;
      if (!list) {
        list = { kind: 'array', tables: [], node: { type: 'array', items: [] } };
        setChild(table, last.name, list, last.at);
      } else if (list.kind !== 'array') {
        fail(`"${last.name}" is already defined and is not an array of tables`, start);
      }
      const t = newTable('table');
      t.defined = true;
      list.tables.push(t);
      list.node.items.push(t.node);
      return t;
    }
    if (existing) {
      if (existing.kind === 'implicit' && !existing.defined) {
        existing.kind = 'table';
        existing.defined = true;
        return existing;
      }
      fail(`Table "${parts.map((p) => p.name).join('.')}" is defined more than once`, start);
    }
    const t = newTable('table');
    t.defined = true;
    setChild(table, last.name, t, last.at);
    return t;
  }

  for (;;) {
    blank();
    if (i >= src.length) break;
    if (src[i] === '[') current = header();
    else {
      keyValue(current);
      endOfLine();
    }
  }
  return root.node;
}
