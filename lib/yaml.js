/**
 * A dependency-free YAML parser covering what configuration files use: block mappings and
 * sequences, flow collections, plain/quoted/block scalars, comments, anchors, aliases and merge
 * keys (<<), tags, and multiple documents. Complex keys ("? key") are not supported.
 */
import { ParseError, scalar } from './common.js';

const BLANK = /^[ \t]*(#.*)?$/;
const SEQ_ITEM = /^-(?:[ \t]|$)/;
const PROPS = /^(?:(&[^\s,[\]{}]+)|(![^\s,[\]{}]*))[ \t]*/;
const DATE = /^\d{4}-\d\d?-\d\d?(?:(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::\d\d)?))?)?$/;

const DOUBLE_ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};

/** Parses every document in a YAML stream. Returns an array with one node (or null) per document. */
export function parseYaml(text) {
  const lines = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
  const docs = [];
  let start = 0;
  let explicit = false;
  const flush = (end) => {
    if (explicit || lines.slice(start, end).some((l) => !BLANK.test(l) && !/^%/.test(l))) {
      docs.push(new Parser(lines, start, end).document());
    }
  };
  for (let i = 0; i < lines.length; i++) {
    if (/^---(?:[ \t]|$)/.test(lines[i])) {
      flush(i);
      // Content after "---" on the same line belongs to the new document.
      lines[i] = lines[i].slice(3);
      start = i;
      explicit = true;
    } else if (/^\.\.\.(?:[ \t]|$)/.test(lines[i])) {
      flush(i);
      start = i + 1;
      explicit = false;
    }
  }
  flush(lines.length);
  return docs;
}

/** Removes a trailing comment: "#" at the start or after whitespace, outside quotes. */
export function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === '\\') i++;
      else if (ch === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
    } else if ((ch === '"' || ch === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

/** Index of the closing quote for a quoted scalar starting at s[start], or -1. */
function closingQuote(s, start) {
  const q = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') i++;
    else if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

/** Decodes a quoted scalar's body (without the quotes), folding line breaks as YAML does. */
function decodeQuoted(body, q) {
  const lines = body.split('\n');
  let out = '';
  let breaks = 0;
  let joinTight = false;
  for (let n = 0; n < lines.length; n++) {
    let part = n > 0 ? lines[n].replace(/^[ \t]+/, '') : lines[n];
    const last = n === lines.length - 1;
    let tight = false;
    if (!last) {
      // A backslash at the end of a line in a double-quoted scalar joins the lines without a space.
      if (q === '"' && /(?:^|[^\\])(?:\\\\)*\\$/.test(part)) {
        part = part.slice(0, -1);
        tight = true;
      } else {
        part = part.replace(/[ \t]+$/, '');
      }
    }
    if (n > 0 && !last && part === '' && !tight) {
      breaks++;
      continue;
    }
    if (n > 0 && !joinTight) out += breaks ? '\n'.repeat(breaks) : ' ';
    out += part;
    breaks = 0;
    joinTight = tight;
  }
  if (q === "'") return out.replace(/''/g, "'");
  return out.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (m, e) => {
    if (e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (e in DOUBLE_ESCAPES) return DOUBLE_ESCAPES[e];
    throw new SyntaxError(`Invalid escape '\\${e}'`);
  });
}

/** Resolves a plain scalar with the YAML 1.2 core schema (plus timestamps). */
export function resolvePlain(s) {
  if (s === '' || /^(?:~|null|Null|NULL)$/.test(s)) return scalar('null', null, s || undefined);
  if (/^(?:true|True|TRUE)$/.test(s)) return scalar('boolean', true, s);
  if (/^(?:false|False|FALSE)$/.test(s)) return scalar('boolean', false, s);
  if (/^[-+]?\d+$/.test(s)) return scalar('number', Number(s), s);
  if (/^0o[0-7]+$/.test(s)) return scalar('number', parseInt(s.slice(2), 8), s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return scalar('number', parseInt(s.slice(2), 16), s);
  if (/^[-+]?(?:\.\d+|\d+(?:\.\d*)?)(?:[eE][-+]?\d+)?$/.test(s)) return scalar('number', Number(s), s);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(s)) return scalar('number', s.startsWith('-') ? -Infinity : Infinity, s);
  if (/^\.(?:nan|NaN|NAN)$/.test(s)) return scalar('number', NaN, s);
  if (DATE.test(s)) return scalar('date', s);
  return scalar('string', s);
}

class Parser {
  constructor(lines, start, end) {
    this.lines = lines;
    this.li = start;
    this.end = end;
    /** Remaining content of a partly consumed line ("- key: value" leaves "key: value"). */
    this.pending = null;
    this.anchors = new Map();
  }

  fail(message, line = this.li + 1, column = 1) {
    throw new ParseError(message, line, column);
  }

  document() {
    const node = this.blockNode(-1);
    const extra = this.peek();
    if (extra) this.fail(extra.indent > 0 ? 'Bad indentation' : 'Unexpected content', extra.no, extra.indent + 1);
    return node;
  }

  /** The next line with content (indent, comment-stripped text, 1-based line number), or null. */
  peek() {
    if (this.pending) return this.pending;
    while (this.li < this.end) {
      const raw = this.lines[this.li];
      if (BLANK.test(raw) || raw.startsWith('%')) {
        this.li++;
        continue;
      }
      const indent = /^ */.exec(raw)[0].length;
      if (raw[indent] === '\t') this.fail('Tabs are not allowed for indentation', this.li + 1, indent + 1);
      return { indent, text: stripComment(raw.slice(indent)), no: this.li + 1 };
    }
    return null;
  }

  consume() {
    if (this.pending) this.pending = null;
    else this.li++;
  }

  /** A block node indented more than `parent`, or null when there is none. */
  blockNode(parent) {
    const line = this.peek();
    if (!line || line.indent <= parent) return null;
    if (SEQ_ITEM.test(line.text)) return this.sequence(line.indent);
    if (line.text.startsWith('? ') || line.text === '?') this.fail('Complex keys (?) are not supported', line.no, line.indent + 1);
    if (keyOf(line.text)) return this.mapping(line.indent);
    this.consume();
    return this.withProps(line.text, line, parent, line.indent);
  }

  mapping(indent) {
    const entries = [];
    const merges = [];
    const seen = new Map();
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) this.fail('Bad indentation of a mapping entry', line.no, line.indent + 1);
      if (SEQ_ITEM.test(line.text)) this.fail('Expected a mapping key, found a sequence item', line.no, line.indent + 1);
      const key = keyOf(line.text);
      if (!key) this.fail("Expected 'key: value'", line.no, line.indent + 1);
      if (key.error) this.fail(key.error, line.no, line.indent + 1);
      this.consume();
      const value = key.rest
        ? this.withProps(key.rest, line, indent, line.indent + key.length, false)
        : this.nestedValue(indent, null, null);
      if (key.name === '<<' && !key.quoted) {
        merges.push({ at: entries.length, value });
        continue;
      }
      if (seen.has(key.name)) this.fail(`Duplicate key "${key.name}"`, line.no, line.indent + 1);
      seen.set(key.name, true);
      entries.push({ key: key.name, value });
    }
    // Merged keys never override keys written in the mapping itself, and earlier sources win.
    let shift = 0;
    for (const { at, value } of merges) {
      const sources = value?.type === 'array' ? value.items : [value];
      const added = [];
      for (const source of sources) {
        if (source?.type !== 'object') this.fail('A merge key (<<) needs a mapping or a list of mappings');
        for (const entry of source.entries) {
          if (!seen.has(entry.key)) {
            seen.set(entry.key, true);
            added.push(entry);
          }
        }
      }
      entries.splice(at + shift, 0, ...added);
      shift += added.length;
    }
    return { type: 'object', entries };
  }

  sequence(indent) {
    const items = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent || !SEQ_ITEM.test(line.text)) break;
      if (line.indent > indent) this.fail('Bad indentation of a sequence item', line.no, line.indent + 1);
      this.consume();
      const rest = line.text.slice(1).replace(/^[ \t]+/, '');
      const column = line.indent + line.text.length - rest.length;
      items.push(rest ? this.withProps(rest, { ...line, indent: column }, indent, column) : this.nestedValue(indent, null, null));
    }
    return { type: 'array', items };
  }

  /** The value of an entry whose line holds nothing more: a nested block, or null. */
  nestedValue(indent, anchor, tag) {
    const next = this.peek();
    let node;
    if (next && next.indent > indent) node = this.blockNode(indent);
    // A sequence may sit at the same indent as its mapping key.
    else if (next && next.indent === indent && SEQ_ITEM.test(next.text)) node = this.sequence(indent);
    else node = tag === '!!str' ? scalar('string', '') : scalar('null', null);
    return this.finish(node, anchor, tag);
  }

  /**
   * Parses anchors and tags in front of a value, then the value itself. `compact` allows a nested
   * block to start on the same line, as in "- key: value"; after "key:" that is an error.
   */
  withProps(text, line, parent, column, compact = true) {
    let anchor = null;
    let tag = null;
    let m;
    while ((m = PROPS.exec(text))) {
      if (m[1]) anchor = m[1].slice(1);
      else tag = m[2];
      column += m[0].length;
      text = text.slice(m[0].length);
    }
    if (!text) return this.nestedValue(parent, anchor, tag);
    // "- key: value" and "- - item" start a nested block on the same line.
    if (SEQ_ITEM.test(text) || keyOf(text)) {
      if (!compact) this.fail('Mapping values are not allowed here (put the nested value on its own line)', line.no, column + 1);
      this.pending = { indent: column, text, no: line.no };
      return this.finish(this.blockNode(parent), anchor, tag);
    }
    return this.finish(this.inlineValue(text, line, parent, column), anchor, tag);
  }

  finish(node, anchor, tag) {
    if (tag) node = applyTag(node, tag);
    if (anchor) this.anchors.set(anchor, node);
    return node;
  }

  inlineValue(text, line, parent, column) {
    const ch = text[0];
    if (ch === '*') {
      const name = /^\*([^\s,[\]{}]+)/.exec(text)?.[1];
      if (!name || !this.anchors.has(name)) this.fail(`Unknown alias *${name ?? ''}`, line.no, column + 1);
      return this.anchors.get(name);
    }
    if (ch === '|' || ch === '>') return this.blockScalar(text, line, parent, column);
    if (ch === '"' || ch === "'") return this.quoted(text, line, column);
    if (ch === '[' || ch === '{') return this.flow(text, line, column);
    if (ch === '@' || ch === '`') this.fail(`'${ch}' cannot start a plain value`, line.no, column + 1);
    return resolvePlain(this.plainContinuation(text, parent));
  }

  /** A plain scalar may continue on following lines indented more than its parent. */
  plainContinuation(text, parent) {
    let out = text;
    let breaks = 0;
    while (this.li < this.end) {
      const raw = this.lines[this.li];
      if (/^[ \t]*$/.test(raw)) {
        breaks++;
        this.li++;
        continue;
      }
      const indent = /^ */.exec(raw)[0].length;
      const body = raw.slice(indent);
      if (indent <= parent || body.startsWith('#')) break;
      const content = stripComment(body);
      if (keyOf(content)) this.fail('Mapping values are not allowed here (check the indentation)', this.li + 1, indent + 1);
      out += breaks ? '\n'.repeat(breaks) : ' ';
      out += content;
      breaks = 0;
      this.li++;
      if (content.length < body.trimEnd().length) break; // a comment ends the scalar
    }
    return out;
  }

  blockScalar(text, line, parent, column) {
    const header = /^([|>])(?:([+-])(\d)?|(\d)([+-])?)?$/.exec(text);
    if (!header) this.fail('Invalid block scalar header', line.no, column + 1);
    const literal = header[1] === '|';
    const chomp = header[2] ?? header[5] ?? '';
    const explicitIndent = Number(header[3] ?? header[4] ?? 0);
    const base = Math.max(parent, 0);

    let contentIndent = explicitIndent ? base + explicitIndent : 0;
    const body = [];
    let i = this.li;
    for (; i < this.end; i++) {
      const raw = this.lines[i];
      if (/^ *$/.test(raw)) {
        body.push('');
        continue;
      }
      const indent = /^ */.exec(raw)[0].length;
      if (!contentIndent) {
        if (indent <= parent) break;
        contentIndent = indent;
      }
      if (indent < contentIndent) break;
      body.push(raw.slice(contentIndent));
    }
    // Trailing blank lines are not consumed past the block; chomping decides what they mean.
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    this.li = i - trailing;

    let value;
    if (literal) {
      value = body.join('\n');
    } else {
      value = '';
      let breaks = 0;
      let prevMore = false;
      let first = true;
      for (const l of body) {
        if (l === '') {
          breaks++;
          continue;
        }
        const more = /^[ \t]/.test(l);
        if (first) value += '\n'.repeat(breaks);
        else if (more || prevMore) value += '\n'.repeat(breaks + 1);
        else value += breaks ? '\n'.repeat(breaks) : ' ';
        value += l;
        breaks = 0;
        prevMore = more;
        first = false;
      }
    }
    if (body.length && chomp !== '-') value += '\n';
    if (chomp === '+') value += '\n'.repeat(trailing);
    return scalar('string', value);
  }

  quoted(text, line, column) {
    let full = text;
    let end = closingQuote(full, 0);
    while (end === -1 && this.li < this.end) {
      full += `\n${this.lines[this.li]}`;
      this.li++;
      end = closingQuote(full, 0);
    }
    if (end === -1) this.fail('Unterminated quoted string', line.no, column + 1);
    const after = stripComment(full.slice(end + 1).split('\n')[0] ?? '');
    if (after.trim()) this.fail(`Unexpected '${after.trim()}' after a quoted string`, line.no + full.slice(0, end).split('\n').length - 1);
    try {
      return scalar('string', decodeQuoted(full.slice(1, end), full[0]));
    } catch (e) {
      return this.fail(e.message, line.no, column + 1);
    }
  }

  flow(text, line, column) {
    let full = text;
    while (!flowClosed(full)) {
      if (this.li >= this.end) this.fail(`Unclosed '${text[0]}'`, line.no, column + 1);
      full += `\n${stripComment(this.lines[this.li].trim())}`;
      this.li++;
    }
    const flow = new FlowParser(full, this.anchors, (message) => this.fail(message, line.no, column + 1));
    const node = flow.value();
    flow.space();
    if (flow.i < full.length) this.fail(`Unexpected '${full.slice(flow.i).trim()}' after a flow collection`, line.no, column + 1);
    return node;
  }
}

/**
 * The key at the start of a block mapping line: { name, rest, length, quoted } where `rest` is the
 * text after "key:" and `length` how far into the line it starts. Null when the line isn't a key.
 */
function keyOf(text) {
  if (text[0] === '"' || text[0] === "'") {
    const end = closingQuote(text, 0);
    if (end === -1) return null;
    const m = /^[ \t]*:(?:[ \t]+|$)/.exec(text.slice(end + 1));
    if (!m) return null;
    let name;
    try {
      name = decodeQuoted(text.slice(1, end), text[0]);
    } catch (e) {
      return { error: e.message };
    }
    const length = end + 1 + m[0].length;
    return { name, rest: text.slice(length), length, quoted: true };
  }
  if (/^[[{]/.test(text) || /^[-?:][ \t]/.test(text) || /^[,\]}#&*!|>%@`]/.test(text)) return null;
  const m = /^(.*?)[ \t]*:(?:[ \t]+|$)/.exec(text);
  if (!m || !m[1]) return null;
  return { name: m[1], rest: text.slice(m[0].length), length: m[0].length, quoted: false };
}

function flowClosed(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((ch === '"' || ch === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) {
      const end = closingQuote(s, i);
      if (end === -1) return false;
      i = end;
    } else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      if (--depth === 0) return true;
    }
  }
  return false;
}

class FlowParser {
  constructor(s, anchors, fail) {
    this.s = s;
    this.i = 0;
    this.anchors = anchors;
    this.fail = fail;
  }

  space() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  value() {
    this.space();
    let anchor = null;
    let tag = null;
    let m;
    while ((m = PROPS.exec(this.s.slice(this.i)))) {
      if (m[1]) anchor = m[1].slice(1);
      else tag = m[2];
      this.i += m[0].length;
    }
    this.space();
    let node;
    const ch = this.s[this.i];
    if (ch === '[') node = this.sequence();
    else if (ch === '{') node = this.mapping();
    else if (ch === '*') {
      const name = /^\*([^\s,[\]{}]+)/.exec(this.s.slice(this.i))?.[1];
      if (!name || !this.anchors.has(name)) this.fail(`Unknown alias *${name ?? ''}`);
      this.i += name.length + 1;
      node = this.anchors.get(name);
    } else if (ch === '"' || ch === "'") node = scalar('string', this.quoted());
    else node = resolvePlain(this.plain());
    if (tag) node = applyTag(node, tag);
    if (anchor) this.anchors.set(anchor, node);
    return node;
  }

  quoted() {
    const end = closingQuote(this.s, this.i);
    if (end === -1) this.fail('Unterminated quoted string');
    const body = this.s.slice(this.i + 1, end);
    const q = this.s[this.i];
    this.i = end + 1;
    try {
      return decodeQuoted(body, q);
    } catch (e) {
      return this.fail(e.message);
    }
  }

  plain() {
    const start = this.i;
    while (this.i < this.s.length && !/[,[\]{}]/.test(this.s[this.i]) && !/^:(?:\s|[,[\]{}]|$)/.test(this.s.slice(this.i))) this.i++;
    return this.s.slice(start, this.i).trim().replace(/\s*\n\s*/g, ' ');
  }

  /** A key and optional ": value" inside a flow collection. */
  pair() {
    this.space();
    const keyNode = this.s[this.i] === '"' || this.s[this.i] === "'" ? scalar('string', this.quoted()) : resolvePlain(this.plain());
    this.space();
    if (this.s[this.i] !== ':') return { key: keyNode, value: null };
    this.i++;
    this.space();
    if (/[,\]}]/.test(this.s[this.i] ?? '')) return { key: keyNode, value: scalar('null', null) };
    return { key: keyNode, value: this.value() };
  }

  sequence() {
    this.i++;
    const items = [];
    for (;;) {
      this.space();
      if (this.s[this.i] === ']') {
        this.i++;
        return { type: 'array', items };
      }
      // A single "key: value" pair inside [ ] is a one-entry mapping.
      const start = this.i;
      const item = /^[[{*&!]/.test(this.s[this.i]) ? null : this.pair();
      if (item?.value) items.push({ type: 'object', entries: [{ key: keyText(item.key), value: item.value }] });
      else {
        this.i = start;
        items.push(this.value());
      }
      this.space();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ']') this.fail(`Expected ',' or ']' in a flow sequence`);
    }
  }

  mapping() {
    this.i++;
    const entries = [];
    const seen = new Set();
    for (;;) {
      this.space();
      if (this.s[this.i] === '}') {
        this.i++;
        return { type: 'object', entries };
      }
      const { key, value } = this.pair();
      const name = keyText(key);
      if (seen.has(name)) this.fail(`Duplicate key "${name}"`);
      seen.add(name);
      entries.push({ key: name, value: value ?? scalar('null', null) });
      this.space();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') this.fail(`Expected ',' or '}' in a flow mapping`);
    }
  }
}

const keyText = (node) => (node.type === 'string' || node.type === 'date' ? node.value : (node.raw ?? String(node.value)));

/** Standard tags change how a scalar resolves; other tags (e.g. CloudFormation's !Ref) are kept for display. */
function applyTag(node, tag) {
  const text = node.raw ?? (node.value === null ? '' : String(node.value));
  const isScalar = node.type !== 'object' && node.type !== 'array';
  switch (tag) {
    case '!!str':
      return isScalar ? scalar('string', text) : node;
    case '!!int':
    case '!!float':
      return isScalar && !Number.isNaN(Number(text)) ? scalar('number', Number(text), text) : node;
    case '!!bool':
      return isScalar ? scalar('boolean', /^true$/i.test(text), text) : node;
    case '!!null':
      return scalar('null', null);
    case '!':
    case '!!map':
    case '!!seq':
    case '!!binary':
    case '!!timestamp':
      return node;
    default:
      return { ...node, tag };
  }
}
