import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldsWithOffsets } from '../lib/csv.js';
import { diagnose, quickFixes } from '../lib/diagnostics.js';
import { format } from '../lib/format.js';
import { outline, sqlDefinitions } from '../lib/outline.js';

/** Applies LSP edits for one uri to text. */
function apply(text, edits) {
  const lines = text.split('\n');
  const offset = ({ line, character }) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + character;
  return [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))
    .reduce((t, e) => t.slice(0, offset(e.range.start)) + e.newText + t.slice(offset(e.range.end)), text);
}
const names = (symbols) => symbols.map((s) => (s.children.length ? [s.name, names(s.children)] : s.name));

test('diagnostics: valid documents have none', () => {
  assert.deepEqual(diagnose('{"a": [1, 2]}', 'json', 'a.json'), []);
  assert.deepEqual(diagnose('a: 1\nb:\n  c: 2\n', 'yaml'), []);
  assert.deepEqual(diagnose('<a><b/></a>', 'xml'), []);
  assert.deepEqual(diagnose('a,b\n1,2\n', 'csv', 'x.csv'), []);
});

test('diagnostics: parse errors with a range', () => {
  const [d] = diagnose('{\n  "a": 1,\n}', 'json', 'a.json');
  assert.equal(d.message, 'Trailing comma before }');
  assert.deepEqual(d.range.start, { line: 2, character: 0 });
  assert.equal(d.severity, 1);
  assert.equal(diagnose('a = \n', 'toml').length, 1);
  assert.equal(diagnose('{"a": 1}\n{bad}\n', 'json', 'x.jsonl')[0].range.start.line, 1);
  assert.deepEqual(diagnose('// note\n{"a": 1,}', 'json', 'tsconfig.json'), []);
});

test('diagnostics: ragged CSV rows are warnings', () => {
  const [d, ...rest] = diagnose('a,b,c\n1,2,3\n4,5\n\n', 'csv', 'x.csv');
  assert.equal(rest.length, 0);
  assert.equal(d.severity, 2);
  assert.equal(d.message, 'Row has 2 fields; the header has 3');
  assert.equal(d.range.start.line, 2);
});

test('quick fixes: trailing comma, missing and mismatched XML tags', () => {
  const json = '{\n  "a": 1,\n}';
  const [fix] = quickFixes(json, 'file:///a.json', diagnose(json, 'json', 'a.json'));
  assert.equal(fix.title, 'Remove trailing comma');
  assert.equal(apply(json, fix.edit.changes['file:///a.json']), '{\n  "a": 1\n}');

  const open = '<a>\n  <b/>';
  const [close] = quickFixes(open, 'u', diagnose(open, 'xml'));
  assert.equal(close.title, 'Add </a>');
  assert.equal(apply(open, close.edit.changes.u), '<a>\n  <b/>\n</a>\n');

  const mismatch = '<a><b></a>';
  const [insert] = quickFixes(mismatch, 'u', diagnose(mismatch, 'xml'));
  assert.equal(apply(mismatch, insert.edit.changes.u), '<a><b></b></a>');
});

test('outline: JSON', () => {
  const symbols = outline('{"name": "x", "deps": {"a": 1}, "list": [{"id": 1}, 2]}', 'json', 'a.json');
  assert.deepEqual(names(symbols), ['name', ['deps', ['a']], ['list', [['[0]', ['id']]]]]);
  assert.equal(symbols[1].range.end.character, 30);
  assert.deepEqual(names(outline('{"a": 1}\n{"b": 2}\n', 'json', 'x.jsonl')), [['[0]', ['a']], ['[1]', ['b']]]);
});

test('outline: YAML, TOML, INI', () => {
  assert.deepEqual(names(outline('a: 1\nb:\n  c: 2\n  d:\n    e: |\n      f: no\n# g: no\nh: 3\n', 'yaml')), ['a', ['b', ['c', ['d', ['e']]]], 'h']);
  assert.deepEqual(names(outline('top = 1\n[server]\nport = 80\ns = """\nx = no\n"""\n[[item]]\nname = "a"\n', 'toml')), ['top', ['server', ['port', 's']], ['item', ['name']]]);
  assert.deepEqual(names(outline('; c\n[db]\nhost=x\n', 'ini', 'a.ini')), [['db', ['host']]]);
  assert.deepEqual(names(outline('export A=1\n# B=2\nC=3\n', 'ini', '.env')), ['A', 'C']);
});

test('outline: XML and SQL', () => {
  const xml = outline('<?xml version="1.0"?>\n<root>\n  <!-- <no/> -->\n  <item id="x"><b/></item>\n</root>\n', 'xml');
  assert.deepEqual(names(xml), [['root', [['item', ['b']]]]]);
  assert.equal(xml[0].children[0].detail, 'x');
  assert.equal(xml[0].range.end.line, 4);

  const sql = outline("-- CREATE TABLE no (x INT);\nCREATE TABLE users (\n  id INT,\n  email TEXT\n);\nCREATE VIEW v AS SELECT 1;\n", 'sql');
  assert.deepEqual(names(sql), [['users', ['id', 'email']], 'v']);
  assert.equal(sql[0].children[1].detail, 'TEXT');
  assert.deepEqual(sql[0].children[1].range.start, { line: 3, character: 2 });
  assert.equal(sqlDefinitions('create table if not exists "app"."t" (a int);')[0].name, 'app.t');
});

test('format: JSON keeps key order and numbers', () => {
  assert.equal(format('{"b":1.50,"a":[],"c":{"d":[1,{"e":null}]}}', 'json', 'a.json'),
    '{\n  "b": 1.50,\n  "a": [],\n  "c": {\n    "d": [\n      1,\n      {\n        "e": null\n      }\n    ]\n  }\n}\n');
  assert.equal(format('{"a":1}', 'json', 'a.json', { tabSize: 4, insertSpaces: false }), '{\n\t"a": 1\n}\n');
  assert.equal(format('{ "a" : 1 }\n\n[ 1, 2 ]\n', 'json', 'x.jsonl'), '{"a":1}\n[1,2]\n');
  assert.equal(format('{"a":1}\n', 'json', 'a.json'), '{\n  "a": 1\n}\n');
  assert.equal(format('{\n  "a": 1\n}\n', 'json', 'a.json'), null, 'already formatted');
  assert.equal(format('// c\n{"a":1}', 'json', 'tsconfig.json'), null, 'comments would be lost');
  assert.equal(format('{"a":', 'json', 'a.json'), null);
});

test('format: XML', () => {
  assert.equal(format('<?xml version="1.0"?><root><!-- c --><a x="1">  text </a><b/><c><d></d></c></root>', 'xml'),
    '<?xml version="1.0"?>\n<root>\n  <!-- c -->\n  <a x="1">  text </a>\n  <b/>\n  <c>\n    <d></d>\n  </c>\n</root>\n');
  assert.equal(format('<p>Some <b>bold</b> text</p>', 'xml'), null, 'mixed content');
  assert.equal(format('<a><b></a>', 'xml'), null);
});

test('CSV fields with offsets', () => {
  const rows = fieldsWithOffsets('a,"b\nc",d\n1,2,3');
  assert.deepEqual(rows.map((r) => r.map((f) => f.value)), [['a', 'b\nc', 'd'], ['1', '2', '3']]);
  assert.deepEqual(rows[0].map((f) => f.offset), [0, 2, 8]);
  assert.deepEqual(rows[1].map((f) => f.offset), [10, 12, 14]);
});
