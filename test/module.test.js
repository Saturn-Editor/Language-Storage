import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../module.js';

const manifest = JSON.parse(readFileSync(new URL('../saturn-language.json', import.meta.url), 'utf8'));

/** Answers for showInput/showOpenDialog, open editor files, and what the module did. */
const ui = { input: null, openDialog: null, editorFiles: new Map(), posted: [], opened: [] };

function fakeSaturn() {
  const previews = new Map();
  const templates = new Map();
  const webviews = new Map();
  activate({
    previews: { registerRenderer: (id, fn) => previews.set(id, fn) },
    files: { registerTemplate: (id, t) => templates.set(id, t) },
    webviews: {
      register: (id, provider) => webviews.set(id, provider),
      postMessage: (id, message, projectPath) => ui.posted.push({ id, message, projectPath }),
    },
    workspace: {
      findFiles: async (root) => [join(root, 'schema.sql')],
      openFile: (projectPath, path, line) => ui.opened.push({ path, line }),
      onDidChangeFiles: () => {},
    },
    editor: { file: (projectPath, path) => ui.editorFiles.get(path) ?? null, onDidChangeFile: () => {} },
    window: { showInput: async () => ui.input, showOpenDialog: async () => ui.openDialog },
    projects: { onDidClose: () => {} },
  });
  return { previews, templates, webviews };
}

const { previews, templates, webviews } = fakeSaturn();
const render = (id, text, path) => previews.get(id)(text, { path, projectPath: '/p' });

test('every manifest preview and template has a handler', () => {
  for (const p of manifest.contributes.previews) assert.ok(previews.has(p.id), p.id);
  for (const t of manifest.contributes.fileTemplates) assert.ok(templates.has(t.id), t.id);
});

test('tree previews escape content and show structure', () => {
  const html = render('storage.json', '{"<b>": "<script>alert(1)</script>", "n": [1, 2]}', '/p/a.json');
  assert.match(html, /Object · 2 keys/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<details open>/);
});

test('jsonc files accept comments; plain JSON reports them with an excerpt', () => {
  assert.match(render('storage.json', '{ // c\n "a": 1 }', '/p/tsconfig.json'), /JSON with Comments/);
  const html = render('storage.json', '{ // c\n "a": 1 }', '/p/data.json');
  assert.match(html, /Line 1, column 3:/);
  assert.match(html, /data-error-line/);
});

test('json lines previews each record', () => {
  assert.match(render('storage.json', '{"a":1}\n\n{"a":2}\n', '/p/x.jsonl'), /2 records/);
  assert.match(render('storage.json', '{"a":1}\n{bad}\n', '/p/x.jsonl'), /Line 2/);
});

test('yaml, toml, ini, xml, csv and sql previews', () => {
  assert.match(render('storage.yaml', 'a: 1\n---\nb: 2\n', '/p/x.yaml'), /2 documents/);
  assert.match(render('storage.toml', '[t]\na = 1\n', '/p/x.toml'), /Object · 1 key/);
  assert.match(render('storage.ini', 'A=1\n', '/p/.env'), /Environment/);
  assert.match(render('storage.xml', '<r><c/><c/></r>', '/p/x.xml'), /&lt;r&gt; · 3 elements/);
  const csv = render('storage.csv', 'name,qty\nbolt,2\nnut,10\n', '/p/x.csv');
  assert.match(csv, /2 rows × 2 columns/);
  assert.match(csv, /<td class="num">10<\/td>/);
  assert.match(render('storage.csv', 'a\tb\n1\t2\n', '/p/x.tsv'), /TSV/);
  const sql = render('storage.sql', 'CREATE TABLE t (id INT PRIMARY KEY);', '/p/x.sql');
  assert.match(sql, /1 tables/);
  assert.match(sql, /s-pk/);
});

test('templates name and fill files', () => {
  const ctx = { name: 'my-data', dir: '/p', projectPath: '/p' };
  assert.equal(templates.get('storage.jsonFile').fileName(ctx), 'my-data.json');
  assert.equal(templates.get('storage.yamlFile').fileName({ ...ctx, name: 'x.yml' }), 'x.yml');
  assert.match(templates.get('storage.xmlFile').content({ ...ctx, name: '1 bad name' }), /<badname>/);
  assert.match(templates.get('storage.tomlFile').content(ctx), /\[my-data\]/);
});

test('the SQL generator panel is registered and gets the project schema', async () => {
  const project = mkdtempSync(join(tmpdir(), 'storage-panel-'));
  writeFileSync(join(project, 'schema.sql'), 'CREATE TABLE users (id INT, email TEXT);\n');
  const panel = webviews.get('storage.sqlGenerator');
  assert.ok(manifest.contributes.panels.some((p) => p.id === 'storage.sqlGenerator' && p.kind === 'webview'));
  const html = await panel.html({ projectPath: project });
  assert.match(html, /"name":"users"/);
  assert.match(html, /function generateSelect/);
  assert.doesNotMatch(html, /^export /m);
  // The generator and the page share one script, so a name declared in both would stop it loading.
  assert.doesNotThrow(() => new Function(/<script>([\s\S]*)<\/script>/.exec(html)[1]));

  // State survives a reload of the page.
  await panel.onMessage({ type: 'state', state: { mode: 'insert', note: '</script>' } }, { projectPath: project });
  const reloaded = await panel.html({ projectPath: project });
  assert.match(reloaded, /"mode":"insert"/);
  assert.match(reloaded, /\\u003c\/script>/, 'state is escaped inside the script');
});

test('the SQL generator writes new files and appends to existing ones', async () => {
  const project = mkdtempSync(join(tmpdir(), 'storage-panel-'));
  const panel = webviews.get('storage.sqlGenerator');
  const ctx = { projectPath: project };
  const lastStatus = () => ui.posted.filter((p) => p.message.type === 'status').at(-1).message;

  ui.input = 'queries/../report';
  writeFileSync(join(project, 'report.sql'), 'SELECT 0;');
  await panel.onMessage({ type: 'newFile', sql: 'SELECT 1;' }, ctx);
  assert.match(lastStatus().message, /already exists/);

  ui.input = 'fresh';
  await panel.onMessage({ type: 'newFile', sql: 'SELECT 1;' }, ctx);
  assert.equal(readFileSync(join(project, 'fresh.sql'), 'utf8'), 'SELECT 1;\n');
  assert.deepEqual(ui.opened.at(-1), { path: join(project, 'fresh.sql'), line: 1 });

  ui.input = '../outside.sql';
  await panel.onMessage({ type: 'newFile', sql: 'SELECT 1;' }, ctx);
  assert.equal(lastStatus().kind, 'error');

  ui.openDialog = [join(project, 'report.sql')];
  await panel.onMessage({ type: 'append', sql: 'SELECT 2;' }, ctx);
  assert.equal(readFileSync(join(project, 'report.sql'), 'utf8'), 'SELECT 0;\n\nSELECT 2;\n');
  assert.deepEqual(ui.opened.at(-1), { path: join(project, 'report.sql'), line: 3 });

  ui.editorFiles.set(join(project, 'report.sql'), { dirty: true, text: '' });
  await panel.onMessage({ type: 'append', sql: 'SELECT 3;' }, ctx);
  assert.match(lastStatus().message, /unsaved changes/);
  assert.doesNotMatch(readFileSync(join(project, 'report.sql'), 'utf8'), /SELECT 3/);

  await panel.onMessage({ type: 'unknown', sql: 'x' }, ctx);
});
