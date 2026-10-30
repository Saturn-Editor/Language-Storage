/**
 * SQL generation for the SQL Generator panel: SELECT, INSERT, UPDATE, DELETE and CREATE TABLE from a
 * plain spec, in one of a few dialects. No imports, because module.js also inlines this file into the
 * panel's page (which can't load modules); keep it self-contained.
 *
 * Values typed into the panel are turned into SQL by `literal`: NULL, numbers, booleans and
 * parameters (?, :name, $1, @name) are used as they are, "=expr" is a raw expression (=now()),
 * and anything else becomes a quoted string. In INSERT and UPDATE a blank value leaves the column
 * out (the panel pre-fills every column); "=''" is an empty string.
 */

export const DIALECTS = [
  { id: 'generic', label: 'Standard SQL' },
  { id: 'postgres', label: 'PostgreSQL' },
  { id: 'mysql', label: 'MySQL' },
  { id: 'sqlite', label: 'SQLite' },
  { id: 'sqlserver', label: 'SQL Server' },
];

export const DIALECT_TYPES = {
  generic: ['INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL(10, 2)', 'REAL', 'BOOLEAN', 'VARCHAR(255)', 'TEXT', 'DATE', 'TIME', 'TIMESTAMP'],
  postgres: ['INTEGER', 'BIGINT', 'SMALLINT', 'NUMERIC(10, 2)', 'DOUBLE PRECISION', 'BOOLEAN', 'VARCHAR(255)', 'TEXT', 'UUID', 'JSONB', 'DATE', 'TIMESTAMPTZ', 'BYTEA'],
  mysql: ['INT', 'BIGINT', 'TINYINT', 'DECIMAL(10, 2)', 'DOUBLE', 'BOOLEAN', 'VARCHAR(255)', 'TEXT', 'JSON', 'DATE', 'DATETIME', 'TIMESTAMP', 'BLOB'],
  sqlite: ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'],
  sqlserver: ['INT', 'BIGINT', 'SMALLINT', 'DECIMAL(10, 2)', 'FLOAT', 'BIT', 'NVARCHAR(255)', 'NVARCHAR(MAX)', 'UNIQUEIDENTIFIER', 'DATE', 'DATETIME2', 'VARBINARY(MAX)'],
};

export const OPERATORS = ['=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];
export const AGGREGATES = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];

const RESERVED = new Set(('select from where insert update delete into values set table create drop alter index view order by group having '
  + 'limit offset join inner left right full outer cross on as and or not null is in like between case when then else end distinct '
  + 'union all primary key foreign references default check unique user to column constraint grant desc asc top fetch').split(' '));

/** An identifier, quoted only when it has to be: "my table", `order`, [key]. */
export function quoteName(name, dialect = 'generic') {
  if (/^[A-Za-z_][\w$]*$/.test(name) && !RESERVED.has(name.toLowerCase())) return name;
  if (dialect === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  if (dialect === 'sqlserver') return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** A possibly qualified name ("schema.table", "table.column", "t.*"). */
export const quoteRef = (ref, dialect) => ref.split('.').map((part) => (part === '*' ? part : quoteName(part, dialect))).join('.');

const NUMERIC_TYPE = /int|dec|num|real|float|double|serial|money|bit/i;
const BOOLEAN_TYPE = /bool|^bit$/i;

/** A value typed into the panel as SQL; `type` is the column's type when known. */
export function literal(value, type = '', dialect = 'generic') {
  const v = String(value ?? '').trim();
  if (v.startsWith('=')) return v.slice(1).trim();
  if (/^null$/i.test(v)) return 'NULL';
  if (/^(\?|[:@][A-Za-z_]\w*|\$\d+)$/.test(v)) return v;
  if (/^(true|false)$/i.test(v) && (!type || BOOLEAN_TYPE.test(type))) {
    return dialect === 'sqlserver' || dialect === 'sqlite' ? (/^true$/i.test(v) ? '1' : '0') : v.toUpperCase();
  }
  if (/^-?\d+(\.\d+)?$/.test(v) && (!type || NUMERIC_TYPE.test(type))) return v;
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/** Joins items on one line if short, otherwise one per indented line. */
function list(items, indent = '  ') {
  const one = items.join(', ');
  return one.length <= 60 ? ` ${one}` : `\n${items.map((i) => indent + i).join(`,\n`)}`;
}

function whereClause(conditions = [], dialect, typeOf) {
  const parts = conditions.filter((c) => c.column).map((c, n) => {
    const column = quoteRef(c.column, dialect);
    const type = typeOf(c.column);
    const op = c.op || '=';
    let expr;
    if (op === 'IS NULL' || op === 'IS NOT NULL') expr = `${column} ${op}`;
    else if (op === 'IN' || op === 'NOT IN') expr = `${column} ${op} (${String(c.value ?? '').split(',').map((v) => literal(v.trim(), type, dialect)).join(', ')})`;
    else if (op === 'BETWEEN') {
      const [from = '', to = ''] = String(c.value ?? '').split(/,|\s+and\s+/i);
      expr = `${column} BETWEEN ${literal(from.trim(), type, dialect)} AND ${literal(to.trim(), type, dialect)}`;
    } else expr = `${column} ${op} ${literal(c.value, type, dialect)}`;
    return n === 0 ? expr : `${c.conj === 'OR' ? 'OR' : 'AND'} ${expr}`;
  });
  return parts.length ? `\nWHERE ${parts.join('\n  ')}` : '';
}

/** Looks up a column's type in the schema by "column" or "table.column". */
function typeLookup(schema, tables) {
  return (ref) => {
    const [a, b] = ref.includes('.') ? ref.split('.').slice(-2) : [null, ref];
    for (const t of schema?.tables ?? []) {
      if (a ? shortName(t.name) !== a && t.name !== a : !tables.includes(t.name)) continue;
      const c = t.columns.find((col) => col.name === b);
      if (c) return c.type;
    }
    return '';
  };
}

const shortName = (name) => name.split('.').pop();

export function generateSelect(spec, dialect = 'generic', schema = null) {
  if (!spec.table) return '';
  const tables = [spec.table, ...(spec.joins ?? []).map((j) => j.table)].filter(Boolean);
  const typeOf = typeLookup(schema, tables);
  const columns = (spec.columns ?? []).filter((c) => c.column).map((c) => {
    const ref = c.column === '*' ? '*' : quoteRef(c.column, dialect);
    const expr = c.fn ? `${c.fn}(${c.fn === 'COUNT' && c.distinct ? 'DISTINCT ' : ''}${ref})` : ref;
    return c.as ? `${expr} AS ${quoteName(c.as, dialect)}` : expr;
  });
  const limit = Number.parseInt(spec.limit, 10);
  const offset = Number.parseInt(spec.offset, 10);
  const top = dialect === 'sqlserver' && limit > 0 && !(offset > 0) ? ` TOP ${limit}` : '';
  let sql = `SELECT${spec.distinct ? ' DISTINCT' : ''}${top}${list(columns.length ? columns : ['*'])}`;
  sql += `\nFROM ${quoteRef(spec.table, dialect)}`;
  for (const j of spec.joins ?? []) {
    if (!j.table) continue;
    const on = j.left && j.right ? ` ON ${quoteRef(j.left, dialect)} = ${quoteRef(j.right, dialect)}` : '';
    sql += `\n${j.type || 'INNER'} JOIN ${quoteRef(j.table, dialect)}${j.type === 'CROSS' ? '' : on}`;
  }
  sql += whereClause(spec.where, dialect, typeOf);
  const groupBy = (spec.groupBy ?? []).filter(Boolean);
  if (groupBy.length) sql += `\nGROUP BY ${groupBy.map((g) => quoteRef(g, dialect)).join(', ')}`;
  const orderBy = (spec.orderBy ?? []).filter((o) => o.column).map((o) => `${quoteRef(o.column, dialect)}${o.dir === 'DESC' ? ' DESC' : ''}`);
  if (orderBy.length) sql += `\nORDER BY ${orderBy.join(', ')}`;
  if (dialect === 'sqlserver') {
    // Without an offset, TOP (above) does the limiting; OFFSET needs an ORDER BY.
    if (offset > 0) {
      if (!orderBy.length) sql += '\nORDER BY (SELECT NULL)';
      sql += `\nOFFSET ${offset} ROWS`;
      if (limit > 0) sql += `\nFETCH NEXT ${limit} ROWS ONLY`;
    }
  } else if (dialect === 'generic') {
    if (offset > 0) sql += `\nOFFSET ${offset} ROWS`;
    if (limit > 0) sql += `\nFETCH ${offset > 0 ? 'NEXT' : 'FIRST'} ${limit} ROWS ONLY`;
  } else {
    // MySQL and SQLite only take OFFSET after a LIMIT, so "no limit" is spelled as their maximum.
    if (limit > 0) sql += `\nLIMIT ${limit}`;
    else if (offset > 0 && dialect !== 'postgres') sql += `\nLIMIT ${dialect === 'mysql' ? '18446744073709551615' : '-1'}`;
    if (offset > 0) sql += `${limit > 0 || dialect !== 'postgres' ? ' ' : '\n'}OFFSET ${offset}`;
  }
  return `${sql};`;
}

function returning(dialect, when) {
  if (!when) return { output: '', suffix: '' };
  if (dialect === 'sqlserver') return { output: `\nOUTPUT ${when}.*`, suffix: '' };
  if (dialect === 'postgres' || dialect === 'sqlite') return { output: '', suffix: '\nRETURNING *' };
  return { output: '', suffix: '' };
}

export function generateInsert(spec, dialect = 'generic', schema = null) {
  const values = (spec.values ?? []).filter((v) => v.column && String(v.value ?? '').trim());
  if (!spec.table || !values.length) return '';
  const typeOf = typeLookup(schema, [spec.table]);
  const { output, suffix } = returning(dialect, spec.returning && 'INSERTED');
  return `INSERT INTO ${quoteRef(spec.table, dialect)} (${values.map((v) => quoteName(v.column, dialect)).join(', ')})${output}`
    + `\nVALUES (${values.map((v) => literal(v.value, typeOf(v.column), dialect)).join(', ')})${suffix};`;
}

const NO_WHERE = (verb) => `-- Warning: no WHERE clause, so this ${verb} every row\n`;

export function generateUpdate(spec, dialect = 'generic', schema = null) {
  const set = (spec.set ?? []).filter((v) => v.column && String(v.value ?? '').trim());
  if (!spec.table || !set.length) return '';
  const typeOf = typeLookup(schema, [spec.table]);
  const where = whereClause(spec.where, dialect, typeOf);
  const { output, suffix } = returning(dialect, spec.returning && 'INSERTED');
  const assignments = set.map((v) => `${quoteName(v.column, dialect)} = ${literal(v.value, typeOf(v.column), dialect)}`);
  return `${where ? '' : NO_WHERE('updates')}UPDATE ${quoteRef(spec.table, dialect)}\nSET${list(assignments)}${output}${where}${suffix};`;
}

export function generateDelete(spec, dialect = 'generic', schema = null) {
  if (!spec.table) return '';
  const where = whereClause(spec.where, dialect, typeLookup(schema, [spec.table]));
  const { output, suffix } = returning(dialect, spec.returning && 'DELETED');
  return `${where ? '' : NO_WHERE('deletes')}DELETE FROM ${quoteRef(spec.table, dialect)}${output}${where}${suffix};`;
}

const IDENTITY = {
  generic: 'GENERATED BY DEFAULT AS IDENTITY',
  postgres: 'GENERATED BY DEFAULT AS IDENTITY',
  mysql: 'AUTO_INCREMENT',
  sqlite: 'AUTOINCREMENT',
  sqlserver: 'IDENTITY(1, 1)',
};

export function generateCreateTable(spec, dialect = 'generic') {
  const columns = (spec.columns ?? []).filter((c) => c.name);
  if (!spec.table || !columns.length) return '';
  const keys = columns.filter((c) => c.primaryKey);
  const inlineKey = keys.length === 1;
  const lines = columns.map((c) => {
    let type = c.type || (dialect === 'sqlite' ? 'TEXT' : 'VARCHAR(255)');
    // SQLite only auto-increments an INTEGER PRIMARY KEY.
    if (dialect === 'sqlite' && c.identity) type = 'INTEGER';
    const parts = [quoteName(c.name, dialect), type];
    if (c.identity && dialect !== 'sqlite') parts.push(IDENTITY[dialect]);
    if (c.primaryKey && inlineKey) parts.push('PRIMARY KEY');
    if (c.identity && dialect === 'sqlite' && c.primaryKey && inlineKey) parts.push('AUTOINCREMENT');
    if (c.notNull && !(c.primaryKey && inlineKey)) parts.push('NOT NULL');
    if (c.unique && !c.primaryKey) parts.push('UNIQUE');
    if (String(c.default ?? '').trim()) parts.push(`DEFAULT ${String(c.default).trim()}`);
    if (c.references && c.references.includes('.')) {
      const at = c.references.lastIndexOf('.');
      parts.push(`REFERENCES ${quoteRef(c.references.slice(0, at), dialect)} (${quoteName(c.references.slice(at + 1), dialect)})`);
    }
    return parts.join(' ');
  });
  if (keys.length > 1) lines.push(`PRIMARY KEY (${keys.map((c) => quoteName(c.name, dialect)).join(', ')})`);
  const name = quoteRef(spec.table, dialect);
  const body = `(\n${lines.map((l) => `  ${l}`).join(',\n')}\n);`;
  if (!spec.ifNotExists) return `CREATE TABLE ${name} ${body}`;
  if (dialect === 'sqlserver') return `IF OBJECT_ID(N'${spec.table.replace(/'/g, "''")}', N'U') IS NULL\nCREATE TABLE ${name} ${body}`;
  return `CREATE TABLE IF NOT EXISTS ${name} ${body}`;
}

/** The statement for whichever tab the panel is on. */
export function generate(state, schema = null) {
  const dialect = state.dialect || 'generic';
  switch (state.mode) {
    case 'insert': return generateInsert(state.insert ?? {}, dialect, schema);
    case 'update': return generateUpdate(state.update ?? {}, dialect, schema);
    case 'delete': return generateDelete(state.delete ?? {}, dialect, schema);
    case 'create': return generateCreateTable(state.create ?? {}, dialect);
    default: return generateSelect(state.select ?? {}, dialect, schema);
  }
}

/**
 * Joins suggested for a table from foreign keys, in either direction:
 * { table, left: "orders.user_id", right: "users.id" } where `table` is the one to join.
 */
export function suggestJoins(schema, table) {
  const out = [];
  const keys = [];
  for (const t of schema?.tables ?? []) {
    for (const c of t.columns) {
      for (const note of c.notes ?? []) {
        const m = /^→ (.+)\.([^.]+)$/.exec(note);
        if (m) keys.push({ from: t.name, column: c.name, to: m[1], toColumn: m[2] });
      }
    }
    for (const constraint of t.constraints ?? []) {
      const m = /FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/i.exec(constraint);
      if (m) keys.push({ from: t.name, column: m[1].trim(), to: m[2], toColumn: m[3].trim() });
    }
  }
  const same = (a, b) => a.toLowerCase() === b.toLowerCase() || shortName(a).toLowerCase() === shortName(b).toLowerCase();
  for (const k of keys) {
    if (same(k.from, table)) out.push({ table: k.to, left: `${shortName(k.to)}.${k.toColumn}`, right: `${shortName(table)}.${k.column}` });
    else if (same(k.to, table)) out.push({ table: k.from, left: `${shortName(k.from)}.${k.column}`, right: `${shortName(table)}.${k.toColumn}` });
  }
  return out;
}
