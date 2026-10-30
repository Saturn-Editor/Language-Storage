import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSchema } from '../lib/sql.js';
import { generate, generateCreateTable, generateDelete, generateInsert, generateSelect, generateUpdate, literal, quoteName, suggestJoins } from '../lib/sqlgen.js';

const schema = readSchema(`
CREATE TABLE teams (id INT PRIMARY KEY, name TEXT, active BOOLEAN);
CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT, age INT, team_id INT REFERENCES teams(id));
CREATE TABLE memberships (user_id INT, team_id INT, FOREIGN KEY (user_id) REFERENCES users(id));
`);

test('identifiers are quoted only when needed, per dialect', () => {
  assert.equal(quoteName('users'), 'users');
  assert.equal(quoteName('order'), '"order"');
  assert.equal(quoteName('my table', 'mysql'), '`my table`');
  assert.equal(quoteName('key]', 'sqlserver'), '[key]]]');
});

test('literals', () => {
  assert.equal(literal('42'), '42');
  assert.equal(literal('42', 'TEXT'), "'42'");
  assert.equal(literal("O'Brien"), "'O''Brien'");
  assert.equal(literal('null'), 'NULL');
  assert.equal(literal(':id'), ':id');
  assert.equal(literal('$1'), '$1');
  assert.equal(literal('=now()'), 'now()');
  assert.equal(literal('true', 'BOOLEAN'), 'TRUE');
  assert.equal(literal('true', 'BIT', 'sqlserver'), '1');
  assert.equal(literal('true', 'TEXT'), "'true'");
});

test('select with joins, filters, grouping and ordering', () => {
  const spec = {
    table: 'users',
    columns: [{ column: 'teams.name' }, { column: 'users.id', fn: 'COUNT', as: 'members' }],
    joins: [{ type: 'LEFT', table: 'teams', left: 'teams.id', right: 'users.team_id' }],
    where: [{ column: 'users.age', op: '>=', value: '18' }, { column: 'teams.name', op: 'IN', value: 'a, b', conj: 'OR' }, { column: 'users.email', op: 'IS NOT NULL' }],
    groupBy: ['teams.name'],
    orderBy: [{ column: 'members', dir: 'DESC' }],
    limit: '10',
  };
  assert.equal(generateSelect(spec, 'postgres', schema), [
    'SELECT teams.name, COUNT(users.id) AS members',
    'FROM users',
    'LEFT JOIN teams ON teams.id = users.team_id',
    'WHERE users.age >= 18',
    "  OR teams.name IN ('a', 'b')",
    '  AND users.email IS NOT NULL',
    'GROUP BY teams.name',
    'ORDER BY members DESC',
    'LIMIT 10;',
  ].join('\n'));
});

test('select limits per dialect', () => {
  const base = { table: 't', limit: '5' };
  assert.equal(generateSelect(base, 'mysql'), 'SELECT *\nFROM t\nLIMIT 5;');
  assert.equal(generateSelect(base, 'sqlserver'), 'SELECT TOP 5 *\nFROM t;');
  assert.equal(generateSelect(base, 'generic'), 'SELECT *\nFROM t\nFETCH FIRST 5 ROWS ONLY;');
  assert.equal(generateSelect({ ...base, offset: '20' }, 'sqlserver'), 'SELECT *\nFROM t\nORDER BY (SELECT NULL)\nOFFSET 20 ROWS\nFETCH NEXT 5 ROWS ONLY;');
  assert.equal(generateSelect({ ...base, offset: '20' }, 'sqlite'), 'SELECT *\nFROM t\nLIMIT 5 OFFSET 20;');
  assert.equal(generateSelect({ table: 't', offset: '20' }, 'sqlite'), 'SELECT *\nFROM t\nLIMIT -1 OFFSET 20;');
  assert.equal(generateSelect({ table: 't', offset: '20' }, 'postgres'), 'SELECT *\nFROM t\nOFFSET 20;');
  assert.equal(generateSelect({}), '');
});

test('long column lists go one per line', () => {
  const columns = ['a_long_column_name', 'another_long_column', 'yet_another_column', 'and_one_more'].map((column) => ({ column }));
  assert.match(generateSelect({ table: 't', columns }), /^SELECT\n {2}a_long_column_name,\n {2}another_long_column,/);
});

test('insert, update and delete', () => {
  assert.equal(generateInsert({ table: 'users', values: [{ column: 'email', value: 'a@b.c' }, { column: 'age', value: '30' }], returning: true }, 'postgres', schema),
    "INSERT INTO users (email, age)\nVALUES ('a@b.c', 30)\nRETURNING *;");
  assert.equal(generateInsert({ table: 'users', values: [{ column: 'email', value: "=''" }, { column: 'age', value: ' ' }] }, 'generic', schema),
    "INSERT INTO users (email)\nVALUES ('');");
  assert.equal(generateInsert({ table: 'users', values: [{ column: 'email', value: '' }] }), '');
  assert.equal(generateInsert({ table: 'users', values: [{ column: 'email', value: 'x' }], returning: true }, 'sqlserver', schema),
    "INSERT INTO users (email)\nOUTPUT INSERTED.*\nVALUES ('x');");
  assert.equal(generateUpdate({ table: 'users', set: [{ column: 'age', value: '31' }], where: [{ column: 'id', op: '=', value: ':id' }] }, 'generic', schema),
    'UPDATE users\nSET age = 31\nWHERE id = :id;');
  assert.match(generateUpdate({ table: 'users', set: [{ column: 'age', value: '1' }] }), /^-- Warning: no WHERE clause, so this updates every row\n/);
  assert.equal(generateDelete({ table: 'users', where: [{ column: 'age', op: 'BETWEEN', value: '1, 9' }] }, 'generic', schema),
    'DELETE FROM users\nWHERE age BETWEEN 1 AND 9;');
  assert.match(generateDelete({ table: 'users' }), /^-- Warning: no WHERE clause, so this deletes every row\nDELETE FROM users;$/);
});

test('create table per dialect', () => {
  const spec = {
    table: 'orders',
    ifNotExists: true,
    columns: [
      { name: 'id', type: 'BIGINT', primaryKey: true, identity: true },
      { name: 'user_id', type: 'INT', notNull: true, references: 'users.id' },
      { name: 'status', type: 'TEXT', default: "'new'", unique: true },
      { name: '' },
    ],
  };
  assert.equal(generateCreateTable(spec, 'postgres'), [
    'CREATE TABLE IF NOT EXISTS orders (',
    '  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,',
    '  user_id INT NOT NULL REFERENCES users (id),',
    "  status TEXT UNIQUE DEFAULT 'new'",
    ');',
  ].join('\n'));
  assert.match(generateCreateTable(spec, 'sqlite'), /id INTEGER PRIMARY KEY AUTOINCREMENT,/);
  assert.match(generateCreateTable(spec, 'mysql'), /id BIGINT AUTO_INCREMENT PRIMARY KEY,/);
  assert.match(generateCreateTable(spec, 'sqlserver'), /^IF OBJECT_ID\(N'orders', N'U'\) IS NULL\nCREATE TABLE orders \(\n {2}id BIGINT IDENTITY\(1, 1\) PRIMARY KEY,/);
  const composite = generateCreateTable({ table: 'm', columns: [{ name: 'a', type: 'INT', primaryKey: true, notNull: true }, { name: 'b', type: 'INT', primaryKey: true }] });
  assert.equal(composite, 'CREATE TABLE m (\n  a INT NOT NULL,\n  b INT,\n  PRIMARY KEY (a, b)\n);');
});

test('generate picks the tab, and joins are suggested from foreign keys both ways', () => {
  assert.equal(generate({ mode: 'delete', dialect: 'mysql', delete: { table: 'order', where: [{ column: 'id', value: '1' }] } }), 'DELETE FROM `order`\nWHERE id = 1;');
  assert.deepEqual(suggestJoins(schema, 'users'), [
    { table: 'teams', left: 'teams.id', right: 'users.team_id' },
    { table: 'memberships', left: 'memberships.user_id', right: 'users.id' },
  ]);
  assert.deepEqual(suggestJoins(schema, 'teams'), [{ table: 'users', left: 'users.team_id', right: 'teams.id' }]);
});
