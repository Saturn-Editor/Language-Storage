import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const project = mkdtempSync(join(tmpdir(), 'storage-ls-'));
writeFileSync(join(project, 'schema.sql'), 'CREATE TABLE users (id INT, email TEXT);\n');
writeFileSync(join(project, 'queries.sql'), "SELECT * FROM users;\n-- users in a comment\nSELECT 'users' FROM users u;\n");

const server = spawn(process.execPath, [fileURLToPath(new URL('../server/server.js', import.meta.url)), '--stdio'], { cwd: project });
after(() => server.kill());

let buffer = Buffer.alloc(0);
const pending = new Map();
const diagnostics = new Map();
server.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === 'textDocument/publishDiagnostics') diagnostics.set(message.params.uri, message.params.diagnostics);
    else pending.get(message.id)?.(message);
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const json = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  return new Promise((resolve) => pending.set(id, (m) => resolve(m.result)));
}
function notify(method, params) {
  const json = JSON.stringify({ jsonrpc: '2.0', method, params });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

/** Opens `text` (with "|" marking the cursor) and asks for completion there. */
async function completeAt(name, languageId, marked) {
  const uri = pathToFileURL(join(project, name)).href;
  const cursor = marked.indexOf('|');
  const text = marked.replace('|', '');
  const lines = text.slice(0, cursor).split('\n');
  notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
  return request('textDocument/completion', { textDocument: { uri }, position: { line: lines.length - 1, character: lines[lines.length - 1].length } });
}
const labels = (items) => items.map((i) => i.label);

test('initialize', async () => {
  const result = await request('initialize', { rootUri: pathToFileURL(project).href, capabilities: {} });
  assert.equal(result.serverInfo.name, 'saturn-storage');
});

test('json keys and literals', async () => {
  assert.deepEqual(labels(await completeAt('a.json', 'json', '{"name": 1, "nested": {"value": 2},\n "|"}')).sort(), ['name', 'nested', 'value']);
  assert.ok(labels(await completeAt('b.json', 'json', '{"a": t|}')).includes('true'));
});

test('yaml keys insert "key: "', async () => {
  const items = await completeAt('a.yaml', 'yaml', 'image: node\nports:\n  - 80\nim|');
  const image = items.find((i) => i.label === 'image');
  assert.equal(image.insertText, 'image: ');
});

test('toml tables include their brackets', async () => {
  const items = await completeAt('a.toml', 'toml', '[server]\nport = 1\n\n[se|');
  assert.deepEqual(labels(items), ['[server]']);
});

test('xml closes the open element', async () => {
  const items = await completeAt('a.xml', 'xml', '<root>\n  <item>x</item>\n</|');
  assert.deepEqual(items.map((i) => [i.label, i.insertText]), [['root', 'root>']]);
});

test('sql keywords follow the typed case, and tables come from the project', async () => {
  assert.ok(labels(await completeAt('q.sql', 'sql', 'sel|')).includes('select'));
  assert.ok(labels(await completeAt('q.sql', 'sql', 'SEL|')).includes('SELECT'));
  assert.deepEqual(labels(await completeAt('q.sql', 'sql', 'SELECT * FROM u|')), ['users']);
  assert.deepEqual(labels(await completeAt('q.sql', 'sql', 'SELECT u.| FROM users u')).sort(), ['email', 'id']);
});

/** Opens a document and returns its uri. */
function open(name, languageId, text) {
  const uri = pathToFileURL(join(project, name)).href;
  notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
  return uri;
}

test('publishes diagnostics on open and change, and clears them on close', async () => {
  const uri = open('bad.json', 'json', '{"a": 1,}');
  const list = await request('textDocument/codeAction', {
    textDocument: { uri },
    range: { start: { line: 0, character: 8 }, end: { line: 0, character: 8 } },
    context: { diagnostics: [] },
  });
  assert.deepEqual(list, []);
  assert.equal(diagnostics.get(uri)[0].message, 'Trailing comma before }');
  const [fix] = await request('textDocument/codeAction', { textDocument: { uri }, range: diagnostics.get(uri)[0].range, context: { diagnostics: diagnostics.get(uri) } });
  assert.equal(fix.title, 'Remove trailing comma');
  notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: '{"a": 1}' }] });
  await request('textDocument/documentSymbol', { textDocument: { uri } });
  assert.deepEqual(diagnostics.get(uri), []);
});

test('document symbols and formatting', async () => {
  const uri = open('f.json', 'json', '{"a":{"b":1}}');
  const [a] = await request('textDocument/documentSymbol', { textDocument: { uri } });
  assert.equal(a.children[0].name, 'b');
  const [edit] = await request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });
  assert.equal(edit.newText, '{\n  "a": {\n    "b": 1\n  }\n}\n');
  assert.deepEqual(edit.range.end, { line: 0, character: 13 });
});

test('csv inlay hints name each column', async () => {
  const uri = open('t.csv', 'csv', 'id,name\n1,Ada\n2,Grace\n');
  const hints = await request('textDocument/inlayHint', { textDocument: { uri }, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } } });
  assert.deepEqual(hints.map((h) => [h.label, h.position.character]), [['id:', 0], ['name:', 2]]);
  assert.ok(hints.every((h) => h.position.line === 1));
});

test('sql code lens counts uses of a table across the project, and references find them', async () => {
  const uri = pathToFileURL(join(project, 'schema.sql')).href;
  const [lens] = await request('textDocument/codeLens', { textDocument: { uri } });
  assert.equal(lens.command.title, '2 references');
  assert.deepEqual(lens.command.arguments[0], { line: 0, character: 13 });
  const all = await request('textDocument/references', { textDocument: { uri }, position: lens.command.arguments[0], context: { includeDeclaration: true } });
  assert.equal(all.length, 3);
  const uses = await request('textDocument/references', { textDocument: { uri }, position: lens.command.arguments[0], context: { includeDeclaration: false } });
  assert.ok(uses.every((l) => l.uri.endsWith('queries.sql')));
});
