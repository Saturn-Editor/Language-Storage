/**
 * HTML previews. The preview frame runs no scripts, so trees collapse with <details> elements and
 * everything else is static markup styled by preview.css.
 */
import { escapeHtml, ParseError } from './common.js';

/** Past this many rendered nodes or rows, the rest is summarised so huge files stay quick. */
const MAX_NODES = 5000;
const MAX_ROWS = 2000;
/** Containers this deep and shallower start expanded. */
const OPEN_DEPTH = 2;

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

export function page(format, summary, body) {
  return `<div class="data-view">\n<header class="data-head"><span class="data-format">${escapeHtml(format)}</span><span class="data-summary">${escapeHtml(summary)}</span></header>\n${body}\n</div>`;
}

/** An error box with the offending source lines, or a plain message for errors without a position. */
export function errorPage(format, error, text) {
  if (!(error instanceof ParseError)) {
    return page(format, 'Could not read this file', `<div class="data-error">${escapeHtml(error?.message ?? String(error))}</div>`);
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const from = Math.max(1, error.line - 2);
  const to = Math.min(lines.length, error.line + 2);
  const excerpt = [];
  for (let n = from; n <= to; n++) {
    const mark = n === error.line ? ' class="data-error-line"' : '';
    excerpt.push(`<div${mark}><span class="data-gutter">${n}</span>${escapeHtml(lines[n - 1]) || ' '}</div>`);
    if (n === error.line && error.column) {
      excerpt.push(`<div class="data-caret"><span class="data-gutter"></span>${' '.repeat(Math.max(0, error.column - 1))}^</div>`);
    }
  }
  return page(
    format,
    'Could not read this file',
    `<div class="data-error"><strong>Line ${error.line}, column ${error.column}:</strong> ${escapeHtml(error.message)}</div>\n<pre class="data-excerpt">${excerpt.join('')}</pre>`,
  );
}

export function describe(node) {
  if (!node) return 'Empty';
  if (node.type === 'object') return `Object · ${plural(node.entries.length, 'key')}`;
  if (node.type === 'array') return `Array · ${plural(node.items.length, 'item')}`;
  return node.type[0].toUpperCase() + node.type.slice(1);
}

// ---- Data trees (JSON, YAML, TOML, INI) ----

function scalarHtml(node) {
  const tag = node.tag ? `<span class="t-tag">${escapeHtml(node.tag)}</span> ` : '';
  switch (node.type) {
    case 'string':
      return `${tag}<span class="t-string">"${escapeHtml(node.value)}"</span>`;
    case 'number':
      return `${tag}<span class="t-number">${escapeHtml(node.raw ?? String(node.value))}</span>`;
    case 'boolean':
      return `${tag}<span class="t-boolean">${node.value}</span>`;
    case 'date':
      return `${tag}<span class="t-date">${escapeHtml(node.value)}</span>`;
    default:
      return `${tag}<span class="t-null">null</span>`;
  }
}

/** Renders a data model node as a collapsible tree. */
export function renderTree(root) {
  let budget = MAX_NODES;
  const label = (key, isIndex) => (key === null ? '' : `<span class="${isIndex ? 't-index' : 't-key'}">${escapeHtml(key)}</span><span class="t-punct">:</span> `);

  function item(key, node, depth, isIndex = false) {
    budget--;
    if (node.type !== 'object' && node.type !== 'array') return `<li>${label(key, isIndex)}${scalarHtml(node)}</li>`;
    const children = node.type === 'object' ? node.entries.map((e) => [e.key, e.value, false]) : node.items.map((v, n) => [String(n), v, true]);
    const brackets = node.type === 'object' ? ['{', '}'] : ['[', ']'];
    const tag = node.tag ? `<span class="t-tag">${escapeHtml(node.tag)}</span> ` : '';
    const count = node.type === 'object' ? plural(children.length, 'key') : plural(children.length, 'item');
    if (!children.length) return `<li>${label(key, isIndex)}${tag}<span class="t-punct">${brackets.join('')}</span></li>`;
    const inner = [];
    for (const [k, v, idx] of children) {
      if (budget <= 0) {
        inner.push(`<li class="t-more">… more not shown</li>`);
        break;
      }
      inner.push(item(k, v, depth + 1, idx));
    }
    const open = depth < OPEN_DEPTH ? ' open' : '';
    return `<li><details${open}><summary>${label(key, isIndex)}${tag}<span class="t-meta">${brackets[0]} ${count} ${brackets[1]}</span></summary><ul>${inner.join('')}</ul></details></li>`;
  }

  return `<ul class="tree">${item(null, root, 0)}</ul>`;
}

/** Several YAML documents (or JSON Lines records) as numbered sections. */
export function renderDocuments(nodes, name) {
  return nodes
    .map((node, n) => `<section class="data-doc"><h2>${escapeHtml(name)} ${n + 1}<span class="data-summary">${escapeHtml(describe(node))}</span></h2>${node ? renderTree(node) : '<p class="data-empty">Empty</p>'}</section>`)
    .join('\n');
}

// ---- XML ----

export function renderXml({ prolog, root, epilog }) {
  let budget = MAX_NODES;
  const attrs = (el) => el.attributes.map((a) => ` <span class="x-attr">${escapeHtml(a.name)}</span>=<span class="t-string">"${escapeHtml(a.value)}"</span>`).join('');
  const open = (el) => `<span class="t-punct">&lt;</span><span class="x-tag">${escapeHtml(el.name)}</span>${attrs(el)}<span class="t-punct">&gt;</span>`;
  const close = (el) => `<span class="t-punct">&lt;/</span><span class="x-tag">${escapeHtml(el.name)}</span><span class="t-punct">&gt;</span>`;

  function node(n, depth) {
    budget--;
    switch (n.type) {
      case 'text':
        return `<li class="x-text">${escapeHtml(n.value.trim())}</li>`;
      case 'cdata':
        return `<li class="x-text"><span class="t-meta">CDATA</span> ${escapeHtml(n.value)}</li>`;
      case 'comment':
        return `<li class="x-comment">&lt;!--${escapeHtml(n.value)}--&gt;</li>`;
      case 'pi':
        return `<li class="x-comment">&lt;?${escapeHtml(n.target)} ${escapeHtml(n.value)}?&gt;</li>`;
      case 'doctype':
        return `<li class="x-comment">&lt;!DOCTYPE ${escapeHtml(n.value)}&gt;</li>`;
    }
    if (!n.children.length) {
      return `<li><span class="t-punct">&lt;</span><span class="x-tag">${escapeHtml(n.name)}</span>${attrs(n)}<span class="t-punct"> /&gt;</span></li>`;
    }
    const only = n.children.length === 1 ? n.children[0] : null;
    if (only && only.type === 'text' && !only.value.trim().includes('\n') && only.value.trim().length <= 120) {
      return `<li>${open(n)}<span class="x-value">${escapeHtml(only.value.trim())}</span>${close(n)}</li>`;
    }
    const inner = [];
    for (const child of n.children) {
      if (budget <= 0) {
        inner.push(`<li class="t-more">… more not shown</li>`);
        break;
      }
      inner.push(node(child, depth + 1));
    }
    const count = n.children.filter((c) => c.type === 'element').length;
    const meta = count ? ` <span class="t-meta">${plural(count, 'child', 'children')}</span>` : '';
    return `<li><details${depth < OPEN_DEPTH + 1 ? ' open' : ''}><summary>${open(n)}${meta}</summary><ul>${inner.join('')}</ul></details>${close(n)}</li>`;
  }

  const all = [...prolog, ...(root ? [root] : []), ...epilog].filter((n) => !(n.type === 'pi' && n.target === 'xml'));
  return `<ul class="tree xml">${all.map((n) => node(n, 0)).join('')}</ul>`;
}

export function countElements(el) {
  return el ? 1 + el.children.reduce((sum, c) => sum + (c.type === 'element' ? countElements(c) : 0), 0) : 0;
}

// ---- CSV ----

const NUMERIC = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/;

export function renderTable(rows) {
  if (!rows.length) return '<p class="data-empty">Empty</p>';
  const [header, ...body] = rows;
  const width = Math.max(...rows.slice(0, MAX_ROWS + 1).map((r) => r.length));
  const numeric = Array.from({ length: width }, (_, c) => {
    const values = body.slice(0, MAX_ROWS).map((r) => (r[c] ?? '').trim()).filter(Boolean);
    return values.length > 0 && values.every((v) => NUMERIC.test(v));
  });
  const cell = (tag, value, c) => `<${tag}${numeric[c] ? ' class="num"' : ''}>${escapeHtml(value ?? '')}</${tag}>`;
  const head = `<tr><th class="row-no">#</th>${Array.from({ length: width }, (_, c) => cell('th', header[c], c)).join('')}</tr>`;
  const shown = body.slice(0, MAX_ROWS).map((r, n) => `<tr><td class="row-no">${n + 1}</td>${Array.from({ length: width }, (_, c) => cell('td', r[c], c)).join('')}</tr>`);
  const more = body.length > MAX_ROWS ? `<p class="t-more">Showing the first ${plural(MAX_ROWS, 'row')} of ${body.length.toLocaleString('en')}.</p>` : '';
  return `<div class="table-wrap"><table class="grid"><thead>${head}</thead><tbody>${shown.join('')}</tbody></table></div>${more}`;
}

// ---- SQL ----

export function renderSchema(schema) {
  const parts = [];
  for (const t of schema.tables) {
    const rows = t.columns
      .map((c) => `<tr><td class="s-col">${escapeHtml(c.name)}</td><td class="s-type">${escapeHtml(c.type)}</td><td class="s-notes">${c.notes.map((n) => `<span class="s-note${n === 'primary key' ? ' s-pk' : ''}">${escapeHtml(n)}</span>`).join(' ')}</td></tr>`)
      .join('');
    const constraints = t.constraints.length ? `<ul class="s-constraints">${t.constraints.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : '';
    parts.push(
      `<section class="s-table"><h2><span class="s-kind">TABLE</span> ${escapeHtml(t.name)} <span class="data-summary">line ${t.line}</span></h2>${
        rows ? `<table class="grid"><thead><tr><th>Column</th><th>Type</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="data-empty">No columns listed</p>'
      }${constraints}</section>`,
    );
  }
  if (schema.views.length) {
    parts.push(`<section class="s-table"><h2>Views</h2><ul class="s-list">${schema.views.map((v) => `<li>${escapeHtml(v.name)} <span class="data-summary">line ${v.line}</span></li>`).join('')}</ul></section>`);
  }
  if (schema.indexes.length) {
    parts.push(
      `<section class="s-table"><h2>Indexes</h2><ul class="s-list">${schema.indexes
        .map((x) => `<li>${escapeHtml(x.name)}${x.table ? ` <span class="t-meta">on ${escapeHtml(x.table)}</span>` : ''} <span class="data-summary">line ${x.line}</span></li>`)
        .join('')}</ul></section>`,
    );
  }
  if (!parts.length) parts.push('<p class="data-empty">No CREATE TABLE, VIEW or INDEX statements in this file.</p>');
  return parts.join('\n');
}
