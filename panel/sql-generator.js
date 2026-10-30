/*
 * The SQL Generator panel's page. module.js inlines lib/sqlgen.js before this script (for generate,
 * suggestJoins and the dialect lists) and sets INITIAL = { state, schema }. The module keeps the
 * state, because Saturn reloads the page when the theme changes.
 */
const MODES = [
  { id: 'select', label: 'Select' },
  { id: 'insert', label: 'Insert' },
  { id: 'update', label: 'Update' },
  { id: 'delete', label: 'Delete' },
  { id: 'create', label: 'Create table' },
];
const JOIN_TYPES = ['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'];
const VALUE_HINT = 'Values: 42, true, NULL, ? or :name stay as typed; =now() is an expression; anything else is quoted as text. Blank values are left out; =\'\' is an empty string.';

const BLANK = {
  where: () => ({ column: '', op: '=', value: '', conj: 'AND' }),
  column: () => ({ column: '', fn: '', as: '' }),
  join: () => ({ type: 'INNER', table: '', left: '', right: '' }),
  order: () => ({ column: '', dir: 'ASC' }),
  value: () => ({ column: '', value: '' }),
  group: () => '',
  createColumn: () => ({ name: '', type: '', primaryKey: false, notNull: false, unique: false, identity: false, default: '', references: '' }),
};

let schema = INITIAL.schema ?? { tables: [] };
const state = Object.assign({
  mode: 'select',
  dialect: 'generic',
  select: { table: '', distinct: false, columns: [], joins: [], where: [], groupBy: [], orderBy: [], limit: '', offset: '' },
  insert: { table: '', values: [], returning: false },
  update: { table: '', set: [], where: [], returning: false },
  delete: { table: '', where: [], returning: false },
  create: { table: '', ifNotExists: true, columns: [BLANK.createColumn()] },
}, INITIAL.state ?? {});

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// shortName comes from lib/sqlgen.js, which shares this script's scope.

// ---- State paths: "select.where.0.value" ----

function getPath(path) {
  return path.split('.').reduce((o, k) => o?.[k], state);
}
function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], state)[last] = value;
}

// ---- Schema helpers ----

const tableNamed = (name) => schema.tables.find((t) => t.name === name || shortName(t.name) === name);
const columnsOf = (name) => tableNamed(name)?.columns ?? [];

/** Column choices for the SELECT tab: qualified once there are joins. */
function selectColumns() {
  const s = state.select;
  const tables = [s.table, ...s.joins.map((j) => j.table)].filter(Boolean);
  if (tables.length <= 1) return columnsOf(s.table).map((c) => c.name);
  return tables.flatMap((t) => [`${shortName(t)}.*`, ...columnsOf(t).map((c) => `${shortName(t)}.${c.name}`)]);
}

function datalists() {
  const options = (id, values) => `<datalist id="${id}">${[...new Set(values)].map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
  const table = state[state.mode]?.table ?? '';
  return options('dl-tables', schema.tables.map((t) => t.name))
    + options('dl-select-columns', ['*', ...selectColumns()])
    + options('dl-columns', columnsOf(table).map((c) => c.name))
    + options('dl-types', DIALECT_TYPES[state.dialect] ?? DIALECT_TYPES.generic)
    + options('dl-refs', schema.tables.flatMap((t) => t.columns.map((c) => `${t.name}.${c.name}`)));
}

// ---- Form pieces ----

const input = (path, { list = '', placeholder = '', cls = '', rerender = false, label = '' } = {}) =>
  `<input data-path="${path}" value="${esc(getPath(path))}"${list ? ` list="${list}"` : ''} placeholder="${esc(placeholder)}"`
  + `${cls ? ` class="${cls}"` : ''}${rerender ? ' data-rerender' : ''} aria-label="${esc(label || placeholder)}" spellcheck="false" autocomplete="off">`;

const select = (path, options, { cls = '', rerender = false, label = '' } = {}) =>
  `<select data-path="${path}"${cls ? ` class="${cls}"` : ''}${rerender ? ' data-rerender' : ''} aria-label="${esc(label)}">`
  + options.map((o) => {
    const [value, text] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(value)}"${getPath(path) === value ? ' selected' : ''}>${esc(text)}</option>`;
  }).join('') + '</select>';

const check = (path, text) => `<label><input type="checkbox" data-path="${path}"${getPath(path) ? ' checked' : ''}> ${esc(text)}</label>`;
const remove = (path, index) => `<button class="remove" data-remove="${path}" data-index="${index}" title="Remove" aria-label="Remove">✕</button>`;

function section(title, path, kind, rows) {
  return `<section><h3>${esc(title)}<button class="link" data-add="${path}" data-kind="${kind}">+ Add</button></h3>${rows}</section>`;
}

function tableField(path) {
  const empty = schema.tables.length ? '' : '<p class="hint">No CREATE TABLE statements found in this project\'s .sql files, so type names yourself.</p>';
  return `<div class="row">${input(path, { list: 'dl-tables', placeholder: 'Table', rerender: true })}</div>${empty}`;
}

function whereRows(base, columnList) {
  return getPath(`${base}.where`).map((_, i) => {
    const p = `${base}.where.${i}`;
    const op = getPath(`${p}.op`);
    const conj = i ? select(`${p}.conj`, ['AND', 'OR'], { cls: 'narrow', label: 'And or or' }) : '<span class="narrow" style="flex:0 0 82px;color:var(--saturn-muted)">Where</span>';
    const value = op === 'IS NULL' || op === 'IS NOT NULL' ? ''
      : input(`${p}.value`, { placeholder: op === 'IN' || op === 'NOT IN' ? 'a, b, c' : op === 'BETWEEN' ? 'from, to' : 'Value' });
    return `<div class="row">${conj}${input(`${p}.column`, { list: columnList, placeholder: 'Column' })}${select(`${p}.op`, OPERATORS, { cls: 'narrow', rerender: true, label: 'Operator' })}${value}${remove(`${base}.where`, i)}</div>`;
  }).join('');
}

function valueRows(path) {
  return getPath(path).map((_, i) => `<div class="row">${input(`${path}.${i}.column`, { list: 'dl-columns', placeholder: 'Column' })}`
    + `${input(`${path}.${i}.value`, { placeholder: 'Value' })}${remove(path, i)}</div>`).join('');
}

function returningField(base) {
  if (!['postgres', 'sqlite', 'sqlserver'].includes(state.dialect)) return '';
  return `<div class="row">${check(`${base}.returning`, state.dialect === 'sqlserver' ? 'OUTPUT the affected rows' : 'RETURNING *')}</div>`;
}

// ---- Tabs ----

function selectForm() {
  const s = state.select;
  const joined = new Set([s.table, ...s.joins.map((j) => j.table)].filter(Boolean).map((t) => shortName(t).toLowerCase()));
  const suggestions = s.table ? [s.table, ...s.joins.map((j) => j.table)].filter(Boolean)
    .flatMap((t) => suggestJoins(schema, t))
    .filter((j) => !joined.has(shortName(j.table).toLowerCase())) : [];
  const unique = suggestions.filter((j, i) => suggestions.findIndex((k) => k.table === j.table) === i);
  return tableField('select.table')
    + `<div class="row">${check('select.distinct', 'DISTINCT')}</div>`
    + section('Columns', 'select.columns', 'column', s.columns.length ? s.columns.map((_, i) => `<div class="row">`
      + `${select(`select.columns.${i}.fn`, [['', '—'], ...AGGREGATES], { cls: 'narrow', label: 'Aggregate' })}`
      + `${input(`select.columns.${i}.column`, { list: 'dl-select-columns', placeholder: 'Column' })}`
      + `${input(`select.columns.${i}.as`, { placeholder: 'As', cls: 'narrow' })}${remove('select.columns', i)}</div>`).join('')
      : '<p class="hint">All columns (*).</p>')
    + section('Joins', 'select.joins', 'join', s.joins.map((_, i) => {
      const p = `select.joins.${i}`;
      return `<div class="row">${select(`${p}.type`, JOIN_TYPES, { cls: 'narrow', label: 'Join type' })}${input(`${p}.table`, { list: 'dl-tables', placeholder: 'Table', rerender: true })}${remove('select.joins', i)}</div>`
        + (getPath(`${p}.type`) === 'CROSS' ? '' : `<div class="row"><span class="narrow" style="flex:0 0 82px;color:var(--saturn-muted)">on</span>${input(`${p}.left`, { list: 'dl-select-columns', placeholder: 'table.column' })}=${input(`${p}.right`, { list: 'dl-select-columns', placeholder: 'table.column' })}</div>`);
    }).join('') + (unique.length ? `<div class="chips"><span class="hint">Suggested:</span>${unique.map((j, i) => `<button data-suggest="${i}" title="${esc(`${j.left} = ${j.right}`)}">+ ${esc(shortName(j.table))}</button>`).join('')}</div>` : ''))
    + section('Where', 'select.where', 'where', whereRows('select', 'dl-select-columns'))
    + section('Group by', 'select.groupBy', 'group', s.groupBy.map((_, i) => `<div class="row">${input(`select.groupBy.${i}`, { list: 'dl-select-columns', placeholder: 'Column' })}${remove('select.groupBy', i)}</div>`).join(''))
    + section('Order by', 'select.orderBy', 'order', s.orderBy.map((_, i) => `<div class="row">${input(`select.orderBy.${i}.column`, { list: 'dl-select-columns', placeholder: 'Column' })}${select(`select.orderBy.${i}.dir`, ['ASC', 'DESC'], { cls: 'narrow', label: 'Direction' })}${remove('select.orderBy', i)}</div>`).join(''))
    + `<section><h3>Limit</h3><div class="row">${input('select.limit', { placeholder: 'Rows', label: 'Limit' })}${input('select.offset', { placeholder: 'Skip (offset)', label: 'Offset' })}</div></section>`
    + `<p class="hint">${VALUE_HINT}</p>`;
}

function insertForm() {
  return tableField('insert.table') + section('Values', 'insert.values', 'value', valueRows('insert.values'))
    + returningField('insert') + `<p class="hint">${VALUE_HINT}</p>`;
}

function updateForm() {
  return tableField('update.table') + section('Set', 'update.set', 'value', valueRows('update.set'))
    + section('Where', 'update.where', 'where', whereRows('update', 'dl-columns')) + returningField('update') + `<p class="hint">${VALUE_HINT}</p>`;
}

function deleteForm() {
  return tableField('delete.table') + section('Where', 'delete.where', 'where', whereRows('delete', 'dl-columns'))
    + returningField('delete') + `<p class="hint">${VALUE_HINT}</p>`;
}

function createForm() {
  return `<div class="row">${input('create.table', { placeholder: 'New table name' })}</div><div class="row">${check('create.ifNotExists', 'IF NOT EXISTS')}</div>`
    + section('Columns', 'create.columns', 'createColumn', state.create.columns.map((_, i) => {
      const p = `create.columns.${i}`;
      return `<div class="column-card"><div class="row">${input(`${p}.name`, { placeholder: 'Column name' })}${input(`${p}.type`, { list: 'dl-types', placeholder: 'Type' })}${remove('create.columns', i)}</div>`
        + `<div class="row flags">${check(`${p}.primaryKey`, 'Primary key')}${check(`${p}.identity`, 'Auto-increment')}${check(`${p}.notNull`, 'Not null')}${check(`${p}.unique`, 'Unique')}</div>`
        + `<div class="row">${input(`${p}.default`, { placeholder: 'Default (SQL, e.g. 0 or CURRENT_TIMESTAMP)' })}${input(`${p}.references`, { list: 'dl-refs', placeholder: 'References table.column' })}</div></div>`;
    }).join(''));
}

const FORMS = { select: selectForm, insert: insertForm, update: updateForm, delete: deleteForm, create: createForm };

// ---- Rendering ----

function render() {
  $('tabs').innerHTML = MODES.map((m) => `<button role="tab" data-mode="${m.id}" aria-selected="${state.mode === m.id}">${m.label}</button>`).join('');
  $('dialect').innerHTML = DIALECTS.map((d) => `<option value="${d.id}"${d.id === state.dialect ? ' selected' : ''}>${d.label}</option>`).join('');
  const focused = document.activeElement?.dataset?.path;
  $('form').innerHTML = FORMS[state.mode]() + datalists();
  if (focused) document.querySelector(`[data-path="${CSS.escape(focused)}"]`)?.focus();
  update();
}

let saveTimer;
function update() {
  $('sql').dataset.empty = state.mode === 'create' ? 'Name the table and its first column to start.' : 'Pick a table to start.';
  $('sql').textContent = generate(state, schema);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saturn.postMessage({ type: 'state', state }), 300);
}

/** A newly picked table fills in its columns where that's what you'd do next. */
function tableChanged(path) {
  const [mode] = path.split('.');
  const columns = columnsOf(state[mode].table);
  if (mode === 'insert' && columns.length && state.insert.values.every((v) => !v.value)) {
    state.insert.values = columns
      .filter((c) => !/serial|identity|auto_?increment/i.test(`${c.type} ${(c.notes ?? []).join(' ')}`))
      .map((c) => ({ column: c.name, value: '' }));
  }
  if ((mode === 'update' || mode === 'delete') && columns.length && !state[mode].where.length) {
    const key = columns.find((c) => (c.notes ?? []).includes('primary key')) ?? columns[0];
    state[mode].where = [{ ...BLANK.where(), column: key.name }];
  }
}

// ---- Events ----

document.addEventListener('input', (e) => {
  const path = e.target.dataset?.path;
  if (!path) return;
  setPath(path, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
  if (e.target.matches('select[data-rerender]') || e.target.type === 'checkbox') render();
  else update();
});

// Text fields that change the form (a table name) re-render once you leave them or pick from the list.
document.addEventListener('change', (e) => {
  if (e.target.matches('input[data-rerender]')) {
    if (/\.table$/.test(e.target.dataset.path)) tableChanged(e.target.dataset.path);
    render();
  }
});

document.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  const { mode, add, kind, remove: removePath, index, suggest, output } = button.dataset;
  if (mode) {
    state.mode = mode;
    render();
  } else if (add) {
    getPath(add).push(BLANK[kind]());
    render();
    const fields = document.querySelectorAll(`[data-path^="${CSS.escape(add)}."]`);
    [...fields].reverse().find((f) => /\.(column|name)$|\.\d+$/.test(f.dataset.path))?.focus();
  } else if (removePath) {
    getPath(removePath).splice(Number(index), 1);
    render();
  } else if (suggest !== undefined) {
    const s = state.select;
    const tables = [s.table, ...s.joins.map((j) => j.table)].filter(Boolean);
    const joined = new Set(tables.map((t) => shortName(t).toLowerCase()));
    const all = tables.flatMap((t) => suggestJoins(schema, t)).filter((j) => !joined.has(shortName(j.table).toLowerCase()));
    const j = all.filter((x, i) => all.findIndex((k) => k.table === x.table) === i)[Number(suggest)];
    if (j) s.joins.push({ type: 'INNER', table: j.table, left: j.left, right: j.right });
    render();
  } else if (output) {
    const sql = $('sql').textContent;
    if (!sql) return status('Nothing to send yet: pick a table first.', 'error');
    saturn.postMessage({ type: output, sql });
  }
});

$('dialect').addEventListener('change', (e) => {
  state.dialect = e.target.value;
  render();
});

function status(message, kind = 'info') {
  $('status').textContent = message;
  $('status').className = kind === 'error' ? 'error' : '';
}

saturn.onMessage((message) => {
  if (message?.type === 'schema') {
    schema = message.schema;
    render();
  } else if (message?.type === 'status') status(message.message, message.kind);
});

render();
