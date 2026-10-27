import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activate } from '../module.js';

const manifest = JSON.parse(readFileSync(new URL('../saturn-module.json', import.meta.url), 'utf8'));

function fakeSaturn() {
  const previews = new Map();
  const templates = new Map();
  activate({
    previews: { registerRenderer: (id, fn) => previews.set(id, fn) },
    files: { registerTemplate: (id, t) => templates.set(id, t) },
  });
  return { previews, templates };
}

const { previews, templates } = fakeSaturn();
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
