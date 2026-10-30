/**
 * A minimal language server for the data formats over stdio (JSON-RPC with Content-Length framing).
 * Supports full-text sync, diagnostics with quick fixes, document symbols, formatting (JSON, XML),
 * inlay hints (CSV/TSV column names), references and CodeLens (SQL tables), and completion:
 *   - JSON, YAML, TOML, INI: keys already used in the document, table/section names, true/false/null
 *   - XML: element names used in the document, and the closing tag for the open element
 *   - SQL: keywords, types, functions, and tables and columns from CREATE TABLE statements in the
 *     document and the project's other .sql files
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lineIndex } from '../lib/common.js';
import { detectDelimiter, fieldsWithOffsets } from '../lib/csv.js';
import { diagnose, quickFixes } from '../lib/diagnostics.js';
import { format } from '../lib/format.js';
import { outline, sqlCode, sqlDefinitions } from '../lib/outline.js';
import { FUNCTIONS, KEYWORDS, TYPES, readSchema } from '../lib/sql.js';

const { version } = JSON.parse(readFileSync(new URL('../saturn-language.json', import.meta.url), 'utf8'));

const CompletionKind = { Text: 1, Function: 3, Field: 5, Variable: 6, Class: 7, Property: 10, Value: 12, Keyword: 14, Snippet: 15 };

const documents = new Map();
let root = process.cwd();

// ---- Transport ----

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
    const start = headerEnd + 4;
    if (!Number.isFinite(length)) {
      buffer = buffer.subarray(start);
      continue;
    }
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    try {
      void dispatch(JSON.parse(body));
    } catch (e) {
      log(`bad message: ${e}`);
    }
  }
});

function send(message) {
  const json = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

const log = (message) => process.stderr.write(`[storage-ls] ${message}\n`);

// ---- Dispatch ----

const handlers = {
  initialize(params) {
    const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    if (folder) root = toPath(folder);
    else if (params.rootPath) root = params.rootPath;
    return {
      capabilities: {
        textDocumentSync: 1,
        completionProvider: { triggerCharacters: ['"', '[', '<', '/', '.'] },
        codeActionProvider: { codeActionKinds: ['quickfix'] },
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        inlayHintProvider: true,
        referencesProvider: true,
        codeLensProvider: { resolveProvider: false },
      },
      serverInfo: { name: 'saturn-storage', version },
    };
  },
  shutdown: () => null,
  'textDocument/completion': (params) => complete(params),
  'textDocument/codeAction': ({ textDocument, context }) =>
    quickFixes(textOf(textDocument.uri), textDocument.uri, (context?.diagnostics ?? []).filter((d) => d.source === 'storage')),
  'textDocument/documentSymbol': ({ textDocument }) =>
    outline(textOf(textDocument.uri), languageOf(textDocument.uri, documents.get(textDocument.uri)), toPath(textDocument.uri)),
  'textDocument/formatting': ({ textDocument, options }) => formatting(textDocument.uri, options),
  'textDocument/inlayHint': ({ textDocument, range }) => inlayHints(textDocument.uri, range),
  'textDocument/references': (params) => references(params),
  'textDocument/codeLens': ({ textDocument }) => codeLenses(textDocument.uri),
};

const notifications = {
  exit: () => process.exit(0),
  'textDocument/didOpen': ({ textDocument }) => {
    documents.set(textDocument.uri, { text: textDocument.text, languageId: textDocument.languageId });
    publishDiagnostics(textDocument.uri);
  },
  'textDocument/didChange': ({ textDocument, contentChanges }) => {
    const last = contentChanges[contentChanges.length - 1];
    const doc = documents.get(textDocument.uri);
    if (last && !last.range) documents.set(textDocument.uri, { text: last.text, languageId: doc?.languageId });
    publishDiagnostics(textDocument.uri);
  },
  'textDocument/didClose': ({ textDocument }) => {
    documents.delete(textDocument.uri);
    send({ method: 'textDocument/publishDiagnostics', params: { uri: textDocument.uri, diagnostics: [] } });
  },
};

async function dispatch(message) {
  if (message.id === undefined) {
    notifications[message.method]?.(message.params ?? {});
    return;
  }
  const handler = handlers[message.method];
  if (!handler) {
    send({ id: message.id, error: { code: -32601, message: `Unhandled method ${message.method}` } });
    return;
  }
  try {
    send({ id: message.id, result: await handler(message.params ?? {}) });
  } catch (e) {
    send({ id: message.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  }
}

// ---- Diagnostics, formatting and inlay hints ----

const MAX_DIAGNOSE_BYTES = 5 * 1024 * 1024;
const textOf = (uri) => documents.get(uri)?.text ?? readOrEmpty(toPath(uri));

function publishDiagnostics(uri) {
  const doc = documents.get(uri);
  if (!doc) return;
  const diagnostics = doc.text.length > MAX_DIAGNOSE_BYTES ? [] : diagnose(doc.text, languageOf(uri, doc), toPath(uri));
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}

function formatting(uri, options) {
  const text = textOf(uri);
  const formatted = format(text, languageOf(uri, documents.get(uri)), toPath(uri), options);
  if (formatted === null) return [];
  return [{ range: { start: { line: 0, character: 0 }, end: lineIndex(text).position(text.length) }, newText: formatted }];
}

/** CSV/TSV: the column's header name before each field of the data rows in range. */
function inlayHints(uri, range) {
  const language = languageOf(uri, documents.get(uri));
  if (language !== 'csv' && language !== 'tsv') return [];
  const text = textOf(uri);
  const rows = fieldsWithOffsets(text, detectDelimiter(text, toPath(uri)));
  const header = rows[0]?.map((f) => f.value.trim()) ?? [];
  if (header.length < 2) return [];
  const { position } = lineIndex(text);
  const hints = [];
  for (const row of rows.slice(1)) {
    const first = position(row[0].offset);
    if (first.line > range.end.line) break;
    if (first.line < range.start.line || (row.length === 1 && !row[0].value)) continue;
    row.forEach((field, column) => {
      if (header[column]) hints.push({ position: position(field.offset), label: `${header[column]}:`, paddingRight: true });
    });
  }
  return hints;
}

// ---- SQL references and CodeLens ----

/** The identifier at a position in `text`. */
function wordAt(text, position) {
  const lineText = text.split(/\r?\n/)[position.line] ?? '';
  const before = /[\w$]*$/.exec(lineText.slice(0, position.character))[0];
  const after = /^[\w$]*/.exec(lineText.slice(position.character))[0];
  return before + after;
}

/** This file and the project's other .sql files, preferring the editor's text for open ones. */
async function sqlFiles(uri) {
  const path = toPath(uri);
  const files = [{ uri, text: textOf(uri) }];
  for (const s of await projectSchemas()) {
    if (s.path === path) continue;
    const href = pathToFileURL(s.path).href;
    files.push({ uri: href, text: documents.get(href)?.text ?? s.text });
  }
  return files;
}

/** Whole-word, case-insensitive uses of `name` outside comments and strings. */
function occurrences(files, name) {
  const re = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`, 'gi');
  return files.flatMap((f) => {
    const { position } = lineIndex(f.text);
    return [...sqlCode(f.text).matchAll(re)].map((m) => ({ uri: f.uri, range: { start: position(m.index), end: position(m.index + name.length) } }));
  });
}

/** Where the last part of a CREATE statement's name starts (inside any quotes). */
function nameStart(text, d) {
  const end = d.nameOffset + d.nameLength - (/["`\]]/.test(text[d.nameOffset + d.nameLength - 1]) ? 1 : 0);
  return end - d.name.split('.').pop().length;
}

/** Uses of `name` that aren't the name in its own CREATE statement. */
function uses(files, name) {
  const definitions = new Set(files.flatMap((f) => sqlDefinitions(f.text)
    .filter((d) => d.name.split('.').pop().toLowerCase() === name.toLowerCase())
    .map((d) => `${f.uri}:${nameStart(f.text, d)}`)));
  return occurrences(files, name).filter((l) => {
    const { offset } = lineIndex(files.find((f) => f.uri === l.uri).text);
    return !definitions.has(`${l.uri}:${offset(l.range.start)}`);
  });
}

async function references({ textDocument, position, context }) {
  if (languageOf(textDocument.uri, documents.get(textDocument.uri)) !== 'sql') return [];
  const name = wordAt(textOf(textDocument.uri), position);
  if (!/^[A-Za-z_]/.test(name)) return [];
  const files = await sqlFiles(textDocument.uri);
  return context?.includeDeclaration === false ? uses(files, name) : occurrences(files, name);
}

/** "N references" above each CREATE TABLE and CREATE VIEW. */
async function codeLenses(uri) {
  if (languageOf(uri, documents.get(uri)) !== 'sql') return [];
  const files = await sqlFiles(uri);
  const text = files[0].text;
  const { position } = lineIndex(text);
  return sqlDefinitions(text).filter((d) => d.kind === 'table' || d.kind === 'view').map((d) => {
    const n = uses(files, d.name.split('.').pop()).length;
    return {
      range: { start: position(d.start), end: position(d.start) },
      command: { title: `${n} reference${n === 1 ? '' : 's'}`, command: 'storage.showReferences', arguments: [position(nameStart(text, d))] },
    };
  });
}

// ---- Completion ----

const toPath = (uri) => (uri.startsWith('file:') ? fileURLToPath(uri) : uri);

/** Saturn replaces the text matching this before the cursor, so insertText must cover exactly that. */
const WORD_BEFORE = /[\w#`[\]-]*$/;

const LANGUAGE_BY_EXTENSION = [
  [/\.(jsonc?|jsonl|ndjson|geojson|webmanifest|har|babelrc)$/i, 'json'],
  [/\.ya?ml$/i, 'yaml'],
  [/(\.toml|cargo\.lock|poetry\.lock|uv\.lock)$/i, 'toml'],
  [/\.(xml|xsd|xslt?|plist|rss|atom|wsdl|kml|gpx)$/i, 'xml'],
  [/\.(sql|ddl)$/i, 'sql'],
  [/\.csv$/i, 'csv'],
  [/\.(tsv|tab)$/i, 'tsv'],
];

function languageOf(uri, doc) {
  if (doc?.languageId) return doc.languageId;
  return LANGUAGE_BY_EXTENSION.find(([re]) => re.test(uri))?.[1] ?? 'ini';
}

async function complete({ textDocument, position }) {
  const uri = textDocument.uri;
  const doc = documents.get(uri);
  const text = doc?.text ?? readOrEmpty(toPath(uri));
  const lines = text.split(/\r?\n/);
  const lineText = lines[position.line] ?? '';
  const before = lineText.slice(0, position.character);
  const word = WORD_BEFORE.exec(before)[0];
  const ctx = { text, lines, line: position.line, before, word, path: toPath(uri) };
  switch (languageOf(uri, doc)) {
    case 'json':
      return jsonItems(ctx);
    case 'yaml':
      return yamlItems(ctx);
    case 'toml':
      return tomlItems(ctx);
    case 'xml':
      return xmlItems(ctx);
    case 'sql':
      return sqlItems(ctx);
    case 'csv':
    case 'tsv':
      return [];
    default:
      return iniItems(ctx);
  }
}

/** Builds items for candidates, skipping the word being typed so it isn't offered back to itself. */
function items(candidates, word, kind, detail) {
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    const label = typeof c === 'string' ? c : c.label;
    if (seen.has(label) || label === word) continue;
    seen.add(label);
    out.push({ label, detail: typeof c === 'string' ? detail : (c.detail ?? detail), insertText: typeof c === 'string' ? label : (c.insertText ?? label), kind });
  }
  return out;
}

/** Every key in the document except the one on the cursor's line. */
function keysExcept(lines, cursorLine, pattern) {
  const found = [];
  lines.forEach((l, n) => {
    if (n === cursorLine) return;
    for (const m of l.matchAll(pattern)) found.push(m[1]);
  });
  return found;
}

const LITERALS = ['true', 'false', 'null'];

function jsonItems({ lines, line, before, word }) {
  // A key: after "{" or "," (possibly on an earlier line), inside an opening quote.
  const keyPosition = /(?:^|[{,])\s*"[^"]*$/.test(before) && !/:\s*"[^"]*$/.test(before);
  if (keyPosition) return items(keysExcept(lines, line, /"((?:[^"\\]|\\.)+)"\s*:/g), word, CompletionKind.Property, 'Key');
  if (/:\s*[a-z]*$/.test(before) || /[[,]\s*[a-z]*$/.test(before)) return items(LITERALS, word, CompletionKind.Value, 'Literal');
  return [];
}

function yamlItems({ lines, line, before, word }) {
  if (/^\s*(?:-\s+)?[\w-]*$/.test(before)) {
    return items(keysExcept(lines, line, /^\s*(?:-\s+)?([\w][\w .-]*?)\s*:(?:\s|$)/g).map((k) => ({ label: k, insertText: `${k}: ` })), word, CompletionKind.Property, 'Key');
  }
  if (/:\s+[a-zA-Z]*$/.test(before) || /^\s*-\s+[a-zA-Z]*$/.test(before)) return items(LITERALS, word, CompletionKind.Value, 'Literal');
  return [];
}

function tomlItems({ lines, line, before, word }) {
  if (/^\s*\[\[?[\w.-]*$/.test(before)) {
    const tables = keysExcept(lines, line, /^\s*\[\[?\s*([^\]]+?)\s*\]\]?/g);
    const prefix = /\[\[/.test(before) ? '[[' : '[';
    // The word Saturn replaces includes the brackets, so the label and insert text carry them too.
    return items(tables.map((t) => ({ label: `${prefix}${t}${prefix === '[[' ? ']]' : ']'}` })), word, CompletionKind.Class, 'Table');
  }
  if (/^\s*[\w-]*$/.test(before)) {
    return items(keysExcept(lines, line, /^\s*([\w.-]+)\s*=/g).map((k) => ({ label: k, insertText: `${k} = ` })), word, CompletionKind.Property, 'Key');
  }
  if (/=\s*[a-z]*$/.test(before)) return items(['true', 'false'], word, CompletionKind.Value, 'Literal');
  return [];
}

function iniItems({ lines, line, before, word }) {
  if (/^\s*\[[\w .-]*$/.test(before)) {
    return items(keysExcept(lines, line, /^\s*\[([^\]]+)\]/g).map((s) => ({ label: `[${s}]` })), word, CompletionKind.Class, 'Section');
  }
  if (/^\s*(?:export\s+)?[\w.-]*$/.test(before)) return items(keysExcept(lines, line, /^\s*(?:export\s+)?([\w.-]+)\s*[=:]/g), word, CompletionKind.Property, 'Key');
  return [];
}

function xmlItems({ text, lines, line, before, word }) {
  const offset = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + before.length;
  // "</" offers the innermost element still open at the cursor.
  if (/<\/[\w:.-]*$/.test(before)) {
    const open = openElement(text.slice(0, offset - word.length - 2));
    return open ? [{ label: open, detail: 'Close tag', insertText: `${open}>`, kind: CompletionKind.Class }] : [];
  }
  if (/<[\w:.-]*$/.test(before)) {
    const names = [...text.matchAll(/<([A-Za-z_][\w:.-]*)/g)].map((m) => m[1]);
    return items(names, word, CompletionKind.Class, 'Element');
  }
  return [];
}

/** The innermost element left open in `text`. */
function openElement(text) {
  const stack = [];
  const clean = text.replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)/g, '');
  for (const m of clean.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) {
      const at = stack.lastIndexOf(m[2]);
      if (at !== -1) stack.length = at;
    } else stack.push(m[2]);
  }
  return stack[stack.length - 1] ?? null;
}

async function sqlItems({ text, before, word, path }) {
  if (!word && !/\.$/.test(before)) return [];
  const upper = !word || word[0] === word[0].toUpperCase();
  const cased = (w) => (upper ? w : w.toLowerCase());
  const tables = await knownTables(text, path);

  // "alias.col" or "table.col": columns of that table (aliases resolved from FROM/JOIN clauses).
  const dotted = /([A-Za-z_][\w$]*)\.([\w$]*)$/.exec(before);
  if (dotted) {
    const name = resolveAlias(text, dotted[1]);
    const table = tables.find((t) => t.name.toLowerCase() === name.toLowerCase() || t.name.toLowerCase().endsWith(`.${name.toLowerCase()}`));
    return table ? items(table.columns.map((c) => ({ label: c.name, detail: c.type })), word, CompletionKind.Field, 'Column') : [];
  }

  const afterTableKeyword = /\b(?:from|join|into|update|table|references)\s+[\w$]*$/i.test(before);
  const tableItems = items(tables.map((t) => ({ label: t.name, detail: `Table (${t.columns.length} columns)` })), word, CompletionKind.Class, 'Table');
  if (afterTableKeyword) return tableItems;
  const columns = tables.flatMap((t) => t.columns.map((c) => ({ label: c.name, detail: `${t.name}.${c.name} ${c.type}` })));
  return [
    ...items(KEYWORDS.map(cased), word, CompletionKind.Keyword, 'Keyword'),
    ...items(TYPES.map(cased), word, CompletionKind.Keyword, 'Type'),
    ...items(FUNCTIONS.map((f) => ({ label: cased(f), insertText: `${cased(f)}(` })), word, CompletionKind.Function, 'Function'),
    ...tableItems,
    ...items(columns, word, CompletionKind.Field, 'Column'),
  ];
}

/** Turns an alias from "FROM users u" / "JOIN orders AS o" into its table name. */
function resolveAlias(text, alias) {
  const re = new RegExp(`\\b(?:from|join)\\s+([\\w$."]+)\\s+(?:as\\s+)?${alias.replace(/\$/g, '\\$')}\\b`, 'i');
  return re.exec(text)?.[1].replace(/"/g, '') ?? alias;
}

/** Tables from this document plus the project's other .sql files (read at most every few seconds). */
async function knownTables(text, path) {
  const own = safeSchema(text).tables;
  const others = (await projectSchemas()).filter((s) => s.path !== path).flatMap((s) => s.tables);
  return [...own, ...others];
}

const safeSchema = (text) => {
  try {
    return readSchema(text);
  } catch {
    return { tables: [] };
  }
};

function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// ---- Project .sql files (cached briefly; completion asks often) ----

const SKIP = new Set(['.git', 'node_modules', '.idea', '.vscode', 'dist', 'out', 'build']);
const FILE_LIMIT = 200;
const MAX_SQL_BYTES = 2 * 1024 * 1024;
let schemaCache = { at: 0, schemas: [] };

async function projectSchemas() {
  if (Date.now() - schemaCache.at < 5000) return schemaCache.schemas;
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= FILE_LIMIT) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(full);
      } else if (/\.(sql|ddl)$/i.test(e.name)) {
        files.push(full);
      }
    }
  };
  await walk(root);
  const schemas = [];
  for (const file of files) {
    try {
      if ((await stat(file)).size > MAX_SQL_BYTES) continue;
      const text = await readFile(file, 'utf8');
      schemas.push({ path: file, text, tables: safeSchema(text).tables });
    } catch {
      // Unreadable files are skipped.
    }
  }
  schemaCache = { at: Date.now(), schemas };
  return schemas;
}
