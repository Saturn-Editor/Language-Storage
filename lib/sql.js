/**
 * SQL helpers shared by the preview and the language server: a tokenizer that understands the
 * common dialects' strings, quoted identifiers and comments, and a schema reader that pulls tables,
 * views and indexes out of CREATE statements.
 */

export const KEYWORDS = [
  'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'AUTOINCREMENT', 'AUTO_INCREMENT', 'BEGIN', 'BETWEEN', 'BY',
  'CASCADE', 'CASE', 'CHECK', 'COLLATE', 'COLUMN', 'COMMIT', 'CONFLICT', 'CONSTRAINT', 'CREATE', 'CROSS',
  'DATABASE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DO', 'DROP', 'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXISTS',
  'EXPLAIN', 'FALSE', 'FETCH', 'FOREIGN', 'FROM', 'FULL', 'FUNCTION', 'GRANT', 'GROUP', 'HAVING', 'IF', 'IN',
  'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'LIMIT', 'NATURAL', 'NOT',
  'NOTHING', 'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PRIMARY', 'PROCEDURE',
  'REFERENCES', 'RENAME', 'REPLACE', 'RETURNING', 'REVOKE', 'RIGHT', 'ROLLBACK', 'SCHEMA', 'SELECT', 'SET',
  'TABLE', 'TEMPORARY', 'THEN', 'TO', 'TRANSACTION', 'TRIGGER', 'TRUE', 'TRUNCATE', 'UNION', 'UNIQUE', 'UPDATE',
  'UPSERT', 'USING', 'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
];

export const TYPES = [
  'BIGINT', 'BIGSERIAL', 'BINARY', 'BIT', 'BLOB', 'BOOLEAN', 'BOOL', 'BYTEA', 'CHAR', 'CLOB', 'DATE', 'DATETIME',
  'DECIMAL', 'DOUBLE', 'ENUM', 'FLOAT', 'INT', 'INTEGER', 'INTERVAL', 'JSON', 'JSONB', 'MEDIUMINT', 'MONEY',
  'NCHAR', 'NUMERIC', 'NVARCHAR', 'REAL', 'SERIAL', 'SMALLINT', 'TEXT', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ',
  'TINYINT', 'UUID', 'VARBINARY', 'VARCHAR',
];

export const FUNCTIONS = [
  'ABS', 'AVG', 'CAST', 'CEIL', 'COALESCE', 'CONCAT', 'COUNT', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'DATE_TRUNC',
  'DENSE_RANK', 'EXTRACT', 'FLOOR', 'GREATEST', 'IFNULL', 'LAG', 'LEAD', 'LEAST', 'LENGTH', 'LOWER', 'LTRIM',
  'MAX', 'MIN', 'NOW', 'NULLIF', 'RANK', 'ROUND', 'ROW_NUMBER', 'RTRIM', 'SUBSTRING', 'SUM', 'TRIM', 'UPPER',
];

/**
 * Splits SQL into tokens: { type: 'word' | 'ident' | 'string' | 'number' | 'punct' | 'comment', value, offset }.
 * `ident` covers "quoted", `backticked` and [bracketed] identifiers (value is unquoted).
 */
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const start = i;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      tokens.push({ type: 'comment', value: src.slice(start, i), offset: start });
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      tokens.push({ type: 'comment', value: src.slice(start, i), offset: start });
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < src.length && !(src[i] === "'" && src[i + 1] !== "'")) i += src[i] === "'" ? 2 : 1;
      i++;
      tokens.push({ type: 'string', value: src.slice(start + 1, i - 1).replace(/''/g, "'"), offset: start });
      continue;
    }
    // PostgreSQL dollar quoting: $$ ... $$ or $tag$ ... $tag$.
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i, i + 64));
    if (dollar) {
      const end = src.indexOf(dollar[0], i + dollar[0].length);
      i = end === -1 ? src.length : end + dollar[0].length;
      tokens.push({ type: 'string', value: src.slice(start + dollar[0].length, end === -1 ? src.length : end), offset: start });
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      const end = src.indexOf(close, i + 1);
      i = end === -1 ? src.length : end + 1;
      tokens.push({ type: 'ident', value: src.slice(start + 1, end === -1 ? src.length : end), offset: start });
      continue;
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i, i + 64));
    if (number) {
      i += number[0].length;
      tokens.push({ type: 'number', value: number[0], offset: start });
      continue;
    }
    const word = /^[A-Za-z_À-￿][\w$À-￿]*/.exec(src.slice(i, i + 256));
    if (word) {
      i += word[0].length;
      tokens.push({ type: 'word', value: word[0], offset: start });
      continue;
    }
    i++;
    tokens.push({ type: 'punct', value: ch, offset: start });
  }
  return tokens;
}

/** Tokens grouped into statements at top-level semicolons, without comments. */
export function statements(src) {
  const out = [];
  let current = [];
  for (const t of tokenize(src)) {
    if (t.type === 'comment') continue;
    if (t.type === 'punct' && t.value === ';') {
      if (current.length) out.push(current);
      current = [];
    } else current.push(t);
  }
  if (current.length) out.push(current);
  return out;
}

const isWord = (t, ...words) => t?.type === 'word' && words.includes(t.value.toUpperCase());
const nameOf = (t) => (t && (t.type === 'word' || t.type === 'ident') ? t.value : null);
const COLUMN_STOP = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY', 'INDEX', 'EXCLUDE', 'FULLTEXT', 'SPATIAL']);
const MODIFIERS = new Set(['TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'VIRTUAL', 'OR', 'REPLACE', 'MATERIALIZED', 'UNIQUE', 'CLUSTERED', 'NONCLUSTERED']);

/** Reads a possibly qualified name ("schema"."table") starting at tokens[i]; returns { name, next }. */
function qualifiedName(tokens, i) {
  let name = nameOf(tokens[i]);
  if (!name) return null;
  i++;
  while (tokens[i]?.value === '.' && nameOf(tokens[i + 1])) {
    name += `.${tokens[i + 1].value}`;
    i += 2;
  }
  return { name, next: i };
}

/** Splits the tokens inside parentheses at top-level commas. */
function splitTopLevel(tokens, open) {
  const parts = [];
  let part = [];
  let depth = 0;
  let i = open + 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '(') depth++;
    if (t.type === 'punct' && t.value === ')') {
      if (depth === 0) break;
      depth--;
    }
    if (depth === 0 && t.type === 'punct' && t.value === ',') {
      parts.push(part);
      part = [];
    } else part.push(t);
  }
  if (part.length) parts.push(part);
  return parts;
}

/** Joins tokens back into readable text ("VARCHAR(255)", "DEFAULT 'x'"). */
function text(tokens) {
  let out = '';
  for (const t of tokens) {
    const v = t.type === 'string' ? `'${t.value.replace(/'/g, "''")}'` : t.type === 'ident' ? `"${t.value}"` : t.value;
    const tight = /^[(),.]$/.test(v) || out.endsWith('(') || out.endsWith('.') || out === '';
    out += (tight ? '' : ' ') + v;
  }
  return out;
}

/**
 * Tables, views and indexes declared in the source:
 *   { tables: [{ name, columns: [{ name, type, notes: [] }], constraints: [text], line }],
 *     views: [{ name, line }], indexes: [{ name, table, line }], statements: n }
 */
export function readSchema(src) {
  const lineOf = (offset) => src.slice(0, offset).split('\n').length;
  const schema = { tables: [], views: [], indexes: [], statements: 0 };
  for (const tokens of statements(src)) {
    schema.statements++;
    if (!isWord(tokens[0], 'CREATE')) continue;
    let i = 1;
    while (isWord(tokens[i], ...MODIFIERS)) i++;
    const kind = tokens[i]?.value.toUpperCase();
    i++;
    if (isWord(tokens[i], 'IF')) i += isWord(tokens[i + 1], 'NOT') ? 3 : 2;
    const qn = qualifiedName(tokens, i);
    if (!qn) continue;
    const line = lineOf(tokens[0].offset);

    if (kind === 'VIEW') {
      schema.views.push({ name: qn.name, line });
    } else if (kind === 'INDEX') {
      const on = tokens.findIndex((t, n) => n > qn.next - 1 && isWord(t, 'ON'));
      schema.indexes.push({ name: qn.name, table: on === -1 ? '' : (qualifiedName(tokens, on + 1)?.name ?? ''), line });
    } else if (kind === 'TABLE') {
      const table = { name: qn.name, columns: [], constraints: [], line };
      const open = tokens.findIndex((t, n) => n >= qn.next && t.type === 'punct' && t.value === '(');
      if (open !== -1 && !isWord(tokens[qn.next], 'AS')) {
        for (const part of splitTopLevel(tokens, open)) {
          if (!part.length) continue;
          if (part[0].type === 'word' && COLUMN_STOP.has(part[0].value.toUpperCase())) {
            table.constraints.push(text(part));
            continue;
          }
          const name = nameOf(part[0]);
          if (!name) continue;
          // The type runs until the first constraint keyword.
          let n = 1;
          while (n < part.length && !isWord(part[n], 'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'DEFAULT', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'COLLATE', 'GENERATED', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'COMMENT', 'ON')) n++;
          const rest = text(part.slice(n));
          const notes = [];
          if (/\bPRIMARY\s+KEY\b/i.test(rest)) notes.push('primary key');
          if (/\bNOT\s+NULL\b/i.test(rest)) notes.push('not null');
          if (/\bUNIQUE\b/i.test(rest)) notes.push('unique');
          if (/\b(AUTO_?INCREMENT|IDENTITY)\b/i.test(rest)) notes.push('auto increment');
          const ref = /\bREFERENCES\s+([^\s(]+)(?:\s*\(\s*([^)]+?)\s*\))?/i.exec(rest);
          if (ref) notes.push(`→ ${ref[1].replace(/"/g, '')}${ref[2] ? `.${ref[2].replace(/"/g, '')}` : ''}`);
          const def = /\bDEFAULT\s+(.+?)(?=\s+(?:NOT|NULL|PRIMARY|UNIQUE|REFERENCES|CHECK|CONSTRAINT|COLLATE)\b|$)/i.exec(rest);
          if (def) notes.push(`default ${def[1]}`);
          table.columns.push({ name, type: text(part.slice(1, n)), notes });
        }
      }
      schema.tables.push(table);
    }
  }
  return schema;
}
