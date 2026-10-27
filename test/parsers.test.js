import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError, toPlain } from '../lib/common.js';
import { parseJson } from '../lib/json.js';
import { parseYaml } from '../lib/yaml.js';
import { parseToml } from '../lib/toml.js';
import { parseXml } from '../lib/xml.js';
import { parseIni, flavourOf } from '../lib/ini.js';
import { parseCsv, detectDelimiter } from '../lib/csv.js';
import { readSchema } from '../lib/sql.js';

const yaml = (text) => parseYaml(text).map((d) => (d ? toPlain(d) : null));
const errorOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected an error');
};

// ---- JSON ----

test('json: values and key order', () => {
  const node = parseJson('{"b": 1, "a": [true, null, "x\\n"], "2": {"n": -1.5e2}}');
  assert.deepEqual(node.entries.map((e) => e.key), ['b', 'a', '2']);
  assert.deepEqual(toPlain(node), { b: 1, a: [true, null, 'x\n'], 2: { n: -150 } });
});

test('json: errors carry line and column', () => {
  const e = errorOf(() => parseJson('{\n  "a": 1,\n  "b" 2\n}'));
  assert.ok(e instanceof ParseError);
  assert.equal(e.line, 3);
  assert.equal(e.column, 7);
  assert.match(e.message, /Expected ':'/);
});

test('json: comments and trailing commas only with jsonc', () => {
  const src = '{\n  // comment\n  "a": 1, /* c */\n}';
  assert.throws(() => parseJson(src), /Comments are not allowed/);
  assert.deepEqual(toPlain(parseJson(src, { jsonc: true })), { a: 1 });
});

test('json: duplicate keys and junk after the root are errors', () => {
  assert.throws(() => parseJson('{"a":1,"a":2}'), /Duplicate key "a"/);
  assert.throws(() => parseJson('{} x'), /after the end/);
  assert.equal(parseJson('  '), null);
});

// ---- YAML ----

test('yaml: mappings, sequences and scalars', () => {
  assert.deepEqual(
    yaml(`name: demo
version: 1.2
count: 010
on: true
off: ~
empty:
list:
  - a
  - 2
  - - nested
inline: [1, two, {k: v}]
map: {a: 1, "b c": [x]}
`),
    [{ name: 'demo', version: 1.2, count: 10, on: true, off: null, empty: null, list: ['a', 2, ['nested']], inline: [1, 'two', { k: 'v' }], map: { a: 1, 'b c': ['x'] } }],
  );
});

test('yaml: sequence at the same indent as its key, and compact mappings', () => {
  assert.deepEqual(
    yaml(`steps:
- name: one
  run: echo 1
- name: two
  with:
    x: 1
after: done
`),
    [{ steps: [{ name: 'one', run: 'echo 1' }, { name: 'two', with: { x: 1 } }], after: 'done' }],
  );
});

test('yaml: comments, quotes and plain scalars with special characters', () => {
  assert.deepEqual(
    yaml(`# header
url: http://example.com:8080/path # trailing
hash: a#b
quoted: "a # not a comment"
single: 'it''s'
colon: "k: v"
escapes: "tab\\tnewline\\n\\u00e9"
apostrophe: don't
`),
    [{ url: 'http://example.com:8080/path', hash: 'a#b', quoted: 'a # not a comment', single: "it's", colon: 'k: v', escapes: 'tab\tnewline\né', apostrophe: "don't" }],
  );
});

test('yaml: block scalars with chomping', () => {
  const [doc] = yaml(`lit: |
  line 1
    indented

  line 3
fold: >
  a
  b

  c
strip: |-
  x

keep: |+
  y

end: 1
`);
  assert.equal(doc.lit, 'line 1\n  indented\n\nline 3\n');
  assert.equal(doc.fold, 'a b\nc\n');
  assert.equal(doc.strip, 'x');
  assert.equal(doc.keep, 'y\n\n');
  assert.equal(doc.end, 1);
});

test('yaml: block scalar inside a sequence item mapping', () => {
  assert.deepEqual(yaml('- run: |\n    npm test\n    npm run build\n  name: ci\n'), [[{ run: 'npm test\nnpm run build\n', name: 'ci' }]]);
});

test('yaml: multi-line plain and quoted scalars fold', () => {
  assert.deepEqual(yaml('a: one\n  two\n\n  three\nb: "x\n  y"\n'), [{ a: 'one two\nthree', b: 'x y' }]);
});

test('yaml: anchors, aliases and merge keys', () => {
  assert.deepEqual(
    yaml(`base: &base
  image: node
  env: prod
svc:
  <<: *base
  env: dev
list: [*base]
`),
    [{ base: { image: 'node', env: 'prod' }, svc: { image: 'node', env: 'dev' }, list: [{ image: 'node', env: 'prod' }] }],
  );
});

test('yaml: tags', () => {
  const [doc] = parseYaml('a: !!str 123\nb: !Ref MyBucket\nc: !!int "7"\n');
  const value = (k) => doc.entries.find((e) => e.key === k).value;
  assert.deepEqual(value('a'), { type: 'string', value: '123' });
  assert.equal(value('b').tag, '!Ref');
  assert.equal(value('b').value, 'MyBucket');
  assert.equal(value('c').value, 7);
});

test('yaml: multiple documents', () => {
  assert.deepEqual(yaml('a: 1\n---\nb: 2\n---\n'), [{ a: 1 }, { b: 2 }, null]);
  assert.deepEqual(yaml('--- # first\nx: 1\n...\n'), [{ x: 1 }]);
});

test('yaml: top-level sequence and scalar', () => {
  assert.deepEqual(yaml('- a\n- b: 1\n  c: 2\n'), [['a', { b: 1, c: 2 }]]);
  assert.deepEqual(yaml('just text\n'), ['just text']);
  assert.deepEqual(yaml(''), []);
});

test('yaml: errors', () => {
  assert.equal(errorOf(() => parseYaml('a: 1\n  b: 2\n')).line, 2);
  assert.match(errorOf(() => parseYaml('a: 1\na: 2\n')).message, /Duplicate key "a"/);
  assert.match(errorOf(() => parseYaml('a: [1, 2\n')).message, /Unclosed/);
  assert.match(errorOf(() => parseYaml('a: *nope\n')).message, /Unknown alias/);
  assert.match(errorOf(() => parseYaml('a:\n\tb: 1\n')).message, /Tabs/);
  assert.match(errorOf(() => parseYaml('a: b: c\n')).message, /not allowed here/);
  assert.match(errorOf(() => parseYaml('a: "open\n')).message, /Unterminated/);
});

// ---- TOML ----

test('toml: values, tables and arrays of tables', () => {
  const doc = toPlain(
    parseToml(`title = "TOML" # comment
int = 1_000
hex = 0xff
float = 6.02e23
bool = true
date = 1979-05-27T07:32:00Z
arr = [1, 2,
  3,]
inline = { a = 1, b.c = "x" }
"quoted key" = 'literal\\n'
site."google.com" = true

[server]
host = "localhost"

[server.tls]
on = false

[[products]]
name = "Hammer"

[[products]]
name = "Nail"
`),
  );
  assert.deepEqual(doc, {
    title: 'TOML', int: 1000, hex: 255, float: 6.02e23, bool: true, date: '1979-05-27T07:32:00Z', arr: [1, 2, 3],
    inline: { a: 1, b: { c: 'x' } }, 'quoted key': 'literal\\n', site: { 'google.com': true },
    server: { host: 'localhost', tls: { on: false } }, products: [{ name: 'Hammer' }, { name: 'Nail' }],
  });
});

test('toml: multi-line strings', () => {
  const doc = toPlain(parseToml('a = """\nline 1\nline 2 \\\n   continued"""\nb = \'\'\'\nraw \\n\'\'\'\n'));
  assert.equal(doc.a, 'line 1\nline 2 continued');
  assert.equal(doc.b, 'raw \\n');
});

test('toml: errors', () => {
  assert.match(errorOf(() => parseToml('a = 1\na = 2\n')).message, /Duplicate key "a"/);
  assert.match(errorOf(() => parseToml('[t]\n[t]\n')).message, /more than once/);
  const e = errorOf(() => parseToml('a = 1\nb = \n'));
  assert.equal(e.line, 2);
  assert.match(e.message, /Expected a value/);
  assert.match(errorOf(() => parseToml('a = 01\n')).message, /Invalid value/);
});

// ---- XML ----

test('xml: elements, attributes, text and entities', () => {
  const { root, prolog } = parseXml('<?xml version="1.0"?>\n<!-- c -->\n<a x="1 &amp; 2"><b>t &lt; u</b><c/><![CDATA[<raw>]]></a>');
  assert.equal(prolog.length, 2);
  assert.equal(root.name, 'a');
  assert.deepEqual(root.attributes, [{ name: 'x', value: '1 & 2' }]);
  assert.equal(root.children[0].children[0].value, 't < u');
  assert.equal(root.children[1].name, 'c');
  assert.equal(root.children[2].type, 'cdata');
});

test('xml: well-formedness errors', () => {
  const e = errorOf(() => parseXml('<a>\n  <b>\n</a>'));
  assert.equal(e.line, 3);
  assert.match(e.message, /does not match <b>/);
  assert.match(errorOf(() => parseXml('<a x=1/>')).message, /must be quoted/);
  assert.match(errorOf(() => parseXml('<a/><b/>')).message, /one root/);
  assert.match(errorOf(() => parseXml('<a>')).message, /Missing closing tag/);
});

// ---- INI / properties / env ----

test('ini: sections, comments and bare keys', () => {
  assert.deepEqual(toPlain(parseIni('top = 1\n; comment\n[db]\nhost = "x" ; note\nport: 5432\nflag\n\n[db]\nuser=me\n')), {
    top: '1', db: { host: 'x', port: '5432', flag: true, user: 'me' },
  });
});

test('properties and env flavours', () => {
  assert.deepEqual(toPlain(parseIni('a.b=1\nc: two \\\n  lines\nd e\n# x\n', 'properties')), { 'a.b': '1', c: 'two lines', d: 'e' });
  assert.deepEqual(toPlain(parseIni('export A=1\nB="x\\ny" # c\nC=plain # comment\nD=\'multi\nline\'\n', 'env')), { A: '1', B: 'x\ny', C: 'plain', D: 'multi\nline' });
  assert.equal(flavourOf('/p/.env'), 'env');
  assert.equal(flavourOf('/p/.env.local'), 'env');
  assert.equal(flavourOf('/p/app.properties'), 'properties');
  assert.equal(flavourOf('/p/setup.cfg'), 'ini');
});

// ---- CSV ----

test('csv: quoted fields, newlines and delimiter detection', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n"multi\nline",2\n'), [['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', '2']]);
  assert.deepEqual(parseCsv('a,b\r\n1,\r\n'), [['a', 'b'], ['1', '']]);
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a,b', 'x.tsv'), '\t');
  assert.throws(() => parseCsv('"open'), /Unterminated/);
});

// ---- SQL ----

test('sql: schema from CREATE statements', () => {
  const schema = readSchema(`-- users
CREATE TABLE IF NOT EXISTS public.users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  "display name" TEXT DEFAULT 'anon',
  CONSTRAINT email_ok CHECK (email LIKE '%@%')
);
CREATE TABLE orders (id INT, user_id INT REFERENCES users(id), total NUMERIC(10, 2));
CREATE UNIQUE INDEX idx_email ON users (email);
CREATE VIEW v AS SELECT 1; -- ; in a comment
INSERT INTO users VALUES ('a;b');
CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;
`);
  assert.equal(schema.tables.length, 2);
  const [users, orders] = schema.tables;
  assert.equal(users.name, 'public.users');
  assert.equal(users.line, 2);
  assert.deepEqual(users.columns.map((c) => [c.name, c.type]), [['id', 'SERIAL'], ['email', 'VARCHAR(255)'], ['display name', 'TEXT']]);
  assert.deepEqual(users.columns[0].notes, ['primary key']);
  assert.deepEqual(users.columns[1].notes, ['not null', 'unique']);
  assert.deepEqual(users.columns[2].notes, ["default 'anon'"]);
  assert.equal(users.constraints.length, 1);
  assert.deepEqual(orders.columns[1].notes, ['→ users.id']);
  assert.equal(orders.columns[2].type, 'NUMERIC(10, 2)');
  assert.deepEqual(schema.indexes, [{ name: 'idx_email', table: 'users', line: 9 }]);
  assert.deepEqual(schema.views.map((v) => v.name), ['v']);
  assert.equal(schema.statements, 6);
});
