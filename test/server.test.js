import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const project = mkdtempSync(join(tmpdir(), 'storage-ls-'));
writeFileSync(join(project, 'schema.sql'), 'CREATE TABLE users (id INT, email TEXT);\n');

const server = spawn(process.execPath, [fileURLToPath(new URL('../server/server.js', import.meta.url)), '--stdio'], { cwd: project });
after(() => server.kill());

let buffer = Buffer.alloc(0);
const pending = new Map();
server.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    pending.get(message.id)?.(message);
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
