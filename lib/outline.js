/**
 * Document outlines as LSP DocumentSymbols (0-based ranges). The parsers don't keep source
 * positions, so each format has a small position-tracking scanner of its own. They are lenient:
 * a half-typed document still gets an outline of what can be read.
 */
import { blank, lineIndex } from './common.js';
import { flavourOf } from './ini.js';
import { readSchema } from './sql.js';

export const SymbolKind = { Namespace: 3, Class: 5, Property: 7, Field: 8, Interface: 11, Function: 12, String: 15, Key: 20, Object: 19, Array: 18, Struct: 23, Event: 24 };

const symbol = (name, kind, range, selectionRange = range) => ({ name, kind, range, selectionRange, children: [] });

export function outline(text, languageId, path = '') {
  const build = { json: jsonOutline, yaml: yamlOutline, toml: tomlOutline, ini: iniOutline, xml: xmlOutline, sql: sqlOutline }[languageId];
  return build ? build(text, path) : [];
}

// ---- JSON ----

function jsonOutline(text, path) {
  const { position } = lineIndex(text);
  const lines = /\.(jsonl|ndjson)$/i.test(path);
  const roots = [];
  // Each frame is an open object or array; the root acts as an array for JSON Lines.
  const stack = [{ type: lines ? 'array' : 'root', symbol: null, index: 0, pendingKey: null }];
  const childrenOf = (frame) => frame.symbol?.children ?? roots;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const top = stack[stack.length - 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (/[ \t\r\n]/.test(text[k] ?? '')) k++;
      if (top.type === 'object' && text[k] === ':') {
        let name;
        try {
          name = JSON.parse(text.slice(i, j + 1));
        } catch {
          name = text.slice(i + 1, j);
        }
        const range = { start: position(i), end: position(j + 1) };
        const s = symbol(name, SymbolKind.Property, range, { ...range });
        childrenOf(top).push(s);
        top.pendingKey = s;
      }
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (ch === '{' || ch === '[') {
      const type = ch === '{' ? 'object' : 'array';
      const kind = type === 'object' ? SymbolKind.Object : SymbolKind.Array;
      let owner = null;
      if (top.type === 'object' && top.pendingKey) {
        owner = top.pendingKey;
        owner.kind = kind;
      } else if (top.type === 'array') {
        const range = { start: position(i), end: position(i + 1) };
        owner = symbol(`[${top.index}]`, kind, range, { ...range });
        childrenOf(top).push(owner);
      }
      stack.push({ type, symbol: owner, index: 0, pendingKey: null });
      top.pendingKey = null;
      i++;
    } else if (ch === '}' || ch === ']') {
      if (stack.length > 1) {
        const frame = stack.pop();
        if (frame.symbol) frame.symbol.range.end = position(i + 1);
      }
      i++;
    } else if (ch === ',') {
      if (top.type === 'array') top.index++;
      top.pendingKey = null;
      i++;
    } else i++;
  }
  // JSON Lines records aren't separated by commas, so number them in order here.
  if (lines) roots.forEach((s, n) => (s.name = `[${n}]`));
  return roots;
}

// ---- YAML ----

function yamlOutline(text) {
  const roots = [];
  const stack = []; // { indent, symbol }
  const src = text.split(/\r?\n/);
  let blockIndent = -1;
  let lastLine = 0;
  const close = (indent, line) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop().symbol.range.end = { line, character: src[line]?.length ?? 0 };
    }
  };
  src.forEach((lineText, n) => {
    const indent = /^ */.exec(lineText)[0].length;
    if (blockIndent >= 0) {
      if (!lineText.trim() || indent > blockIndent) return;
      blockIndent = -1;
    }
    if (/^(---|\.\.\.)(\s|$)/.test(lineText)) {
      close(0, lastLine);
      return;
    }
    const m = /^( *)(- +)?((?:"[^"]*"|'[^']*'|[^\s#'"][^:#]*?))[ \t]*:(?:[ \t]+(.*))?$/.exec(lineText);
    if (!m || /^\s*#/.test(lineText)) return;
    const keyIndent = m[1].length + (m[2]?.length ?? 0);
    close(keyIndent, lastLine);
    const name = m[3].replace(/^(["'])(.*)\1$/, '$2');
    const range = { start: { line: n, character: keyIndent }, end: { line: n, character: lineText.length } };
    const s = symbol(name, SymbolKind.Property, range, { start: range.start, end: { line: n, character: keyIndent + m[3].length } });
    (stack[stack.length - 1]?.symbol.children ?? roots).push(s);
    stack.push({ indent: keyIndent, symbol: s });
    lastLine = n;
    const value = (m[4] ?? '').replace(/\s+#.*$/, '');
    if (/^[|>][-+0-9]*$/.test(value)) blockIndent = keyIndent;
    else if (value) {
      stack.pop();
      return;
    }
    s.kind = SymbolKind.Object;
  });
  // Keys that opened a block also end at the last key inside it.
  close(-1, lastLine);
  const fixKinds = (list) => list.forEach((s) => {
    if (s.kind === SymbolKind.Object && !s.children.length) s.kind = SymbolKind.Property;
    fixKinds(s.children);
  });
  fixKinds(roots);
  return roots;
}

// ---- TOML and INI ----

function sectioned(text, { header, key, comment, multiline }) {
  const roots = [];
  let section = null;
  let inString = null;
  const src = text.split(/\r?\n/);
  src.forEach((lineText, n) => {
    if (inString) {
      if (lineText.includes(inString)) inString = null;
      return;
    }
    if (comment.test(lineText)) return;
    const end = { line: n, character: lineText.length };
    let m;
    if (header && (m = header.exec(lineText))) {
      const start = { line: n, character: m.index + m[1].length };
      section = symbol(m[2].trim(), m[0].includes('[[') ? SymbolKind.Array : SymbolKind.Namespace, { start, end }, { start, end: { line: n, character: start.character + m[2].length + (m[0].includes('[[') ? 4 : 2) } });
      roots.push(section);
      return;
    }
    if ((m = key.exec(lineText))) {
      const start = { line: n, character: m[1].length };
      const s = symbol(m[2].trim(), SymbolKind.Property, { start, end }, { start, end: { line: n, character: start.character + m[2].length } });
      (section?.children ?? roots).push(s);
      if (section) section.range.end = end;
      const delimiter = multiline && /("""|''')/.exec(lineText.slice(m[0].length));
      if (delimiter && lineText.split(delimiter[1]).length === 2) inString = delimiter[1];
    }
  });
  return roots;
}

const tomlOutline = (text) => sectioned(text, {
  header: /^(\s*)\[\[?\s*([^\]]+?)\s*\]\]?/,
  key: /^(\s*)((?:[\w-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[\w-]+|"[^"]*"|'[^']*'))*)\s*=/,
  comment: /^\s*#/,
  multiline: true,
});

function iniOutline(text, path) {
  const flavour = flavourOf(path);
  return sectioned(text, {
    header: flavour === 'ini' ? /^(\s*)\[([^\]]+)\]/ : null,
    key: flavour === 'env' ? /^(\s*(?:export\s+)?)([A-Za-z_][\w.-]*)\s*=/ : /^(\s*)([^=:#;\s][^=:]*?)\s*[=:]/,
    comment: /^\s*[#;!]/,
    multiline: false,
  });
}

// ---- XML ----

function xmlOutline(text) {
  const { position } = lineIndex(text);
  const clean = blank(text, /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>/g);
  const roots = [];
  const stack = [];
  for (const m of clean.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const end = m.index + m[0].length;
    if (m[1]) {
      const at = stack.map((s) => s.tag).lastIndexOf(m[2]);
      if (at === -1) continue;
      for (const open of stack.splice(at)) open.symbol.range.end = position(end);
      continue;
    }
    const nameRange = { start: position(m.index + 1), end: position(m.index + 1 + m[2].length) };
    const s = symbol(m[2], SymbolKind.Field, { start: position(m.index), end: position(end) }, nameRange);
    const id = /\b(?:id|name|key)\s*=\s*("([^"]*)"|'([^']*)')/.exec(m[3]);
    if (id) s.detail = id[2] ?? id[3];
    (stack[stack.length - 1]?.symbol.children ?? roots).push(s);
    if (!m[4]) stack.push({ tag: m[2], symbol: s });
  }
  return roots;
}

// ---- SQL ----

const SQL_KINDS = { table: SymbolKind.Struct, view: SymbolKind.Interface, index: SymbolKind.Key, function: SymbolKind.Function, procedure: SymbolKind.Function, trigger: SymbolKind.Event, type: SymbolKind.Class, schema: SymbolKind.Namespace, sequence: SymbolKind.Key };

/** SQL with comments and string literals blanked out, so offsets match the source. */
export const sqlCode = (text) => blank(text, /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*(?:'|$)/g);

/** CREATE statements: { kind, name, nameOffset, start, end } with offsets into `text`. */
export function sqlDefinitions(text) {
  const code = sqlCode(text);
  const out = [];
  const re = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global\s+|local\s+)?temp(?:orary)?\s+|unique\s+|materialized\s+|virtual\s+)*(table|view|index|function|procedure|trigger|type|schema|sequence)\s+(?:if\s+not\s+exists\s+)?((?:[\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\])(?:\.(?:[\w$]+|"[^"]+"|`[^`]+`|\[[^\]]+\]))*)/gi;
  for (const m of code.matchAll(re)) {
    const semicolon = code.indexOf(';', m.index + m[0].length);
    const end = semicolon === -1 ? code.length : semicolon + 1;
    out.push({ kind: m[1].toLowerCase(), name: m[2].replace(/["`[\]]/g, ''), nameOffset: m.index + m[0].length - m[2].length, nameLength: m[2].length, start: m.index, end });
  }
  return out;
}

function sqlOutline(text) {
  const { position } = lineIndex(text);
  const code = sqlCode(text);
  return sqlDefinitions(text).map((d) => {
    const s = symbol(d.name, SQL_KINDS[d.kind], { start: position(d.start), end: position(d.end) },
      { start: position(d.nameOffset), end: position(d.nameOffset + d.nameLength) });
    s.detail = d.kind;
    if (d.kind === 'table') {
      let columns = [];
      try {
        columns = readSchema(text.slice(d.start, d.end)).tables[0]?.columns ?? [];
      } catch {
        // A half-written table still lists by name.
      }
      const body = code.slice(d.nameOffset + d.nameLength, d.end);
      let from = 0;
      for (const c of columns) {
        const m = new RegExp(`["\`\\[]?\\b${c.name.replace(/[$]/g, '\\$')}\\b["\`\\]]?`).exec(body.slice(from));
        if (!m) continue;
        const at = d.nameOffset + d.nameLength + from + m.index;
        from += m.index + m[0].length;
        const range = { start: position(at), end: position(at + m[0].length) };
        const column = symbol(c.name, SymbolKind.Field, range, { ...range });
        column.detail = c.type;
        s.children.push(column);
      }
    }
    return s;
  });
}
