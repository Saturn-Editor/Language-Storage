import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, detectDelimiter } from './lib/csv.js';
import { flavourOf, parseIni } from './lib/ini.js';
import { isJsonc, parseJson } from './lib/json.js';
import { countElements, describe, errorPage, page, renderDocuments, renderSchema, renderTable, renderTree, renderXml } from './lib/preview.js';
import { readSchema } from './lib/sql.js';
import { parseToml } from './lib/toml.js';
import { parseXml } from './lib/xml.js';
import { parseYaml } from './lib/yaml.js';

const here = dirname(fileURLToPath(import.meta.url));
const previewCss = readFileSync(join(here, 'preview.css'), 'utf8');

const wrap = (html) => `<style>${previewCss}</style>\n${html}`;

/** JSON Lines: one JSON value per non-blank line. */
function parseJsonLines(text) {
  return text.split(/\r?\n/).flatMap((line, n) => {
    if (!line.trim()) return [];
    try {
      return [parseJson(line)];
    } catch (e) {
      e.line = n + 1;
      throw e;
    }
  });
}

/** Each preview id's renderer: returns the page body, or throws a ParseError. */
const RENDERERS = {
  'storage.json': (text, path) => {
    if (/\.(jsonl|ndjson)$/i.test(path)) {
      const records = parseJsonLines(text);
      return page('JSON Lines', `${records.length.toLocaleString('en')} records`, renderDocuments(records, 'Record'));
    }
    const root = parseJson(text, { jsonc: isJsonc(path) });
    return page(isJsonc(path) ? 'JSON with Comments' : 'JSON', describe(root), root ? renderTree(root) : '<p class="data-empty">Empty</p>');
  },
  'storage.yaml': (text) => {
    const docs = parseYaml(text);
    if (docs.length <= 1) {
      const root = docs[0] ?? null;
      return page('YAML', describe(root), root ? renderTree(root) : '<p class="data-empty">Empty</p>');
    }
    return page('YAML', `${docs.length} documents`, renderDocuments(docs, 'Document'));
  },
  'storage.toml': (text) => {
    const root = parseToml(text);
    return page('TOML', describe(root), renderTree(root));
  },
  'storage.ini': (text, path) => {
    const flavour = flavourOf(path);
    const root = parseIni(text, flavour);
    const format = { env: 'Environment', properties: 'Properties', ini: 'INI' }[flavour];
    return page(format, describe(root), root.entries.length ? renderTree(root) : '<p class="data-empty">Empty</p>');
  },
  'storage.xml': (text) => {
    const doc = parseXml(text);
    const count = countElements(doc.root);
    return page('XML', doc.root ? `<${doc.root.name}> · ${count.toLocaleString('en')} elements` : 'Empty', renderXml(doc));
  },
  'storage.csv': (text, path) => {
    const delimiter = detectDelimiter(text, path);
    const rows = parseCsv(text, delimiter);
    const columns = rows.length ? Math.max(...rows.map((r) => r.length)) : 0;
    const name = { ',': 'CSV', '\t': 'TSV', ';': 'CSV (semicolons)', '|': 'CSV (pipes)' }[delimiter];
    return page(name, `${Math.max(0, rows.length - 1).toLocaleString('en')} rows × ${columns} columns`, renderTable(rows));
  },
  'storage.sql': (text) => {
    const schema = readSchema(text);
    const summary = [`${schema.tables.length} tables`, schema.views.length && `${schema.views.length} views`, `${schema.statements} statements`].filter(Boolean).join(' · ');
    return page('SQL schema', summary, renderSchema(schema));
  },
};

const FORMAT_NAMES = { 'storage.json': 'JSON', 'storage.yaml': 'YAML', 'storage.toml': 'TOML', 'storage.ini': 'INI', 'storage.xml': 'XML', 'storage.csv': 'CSV', 'storage.sql': 'SQL' };

const stem = (name) => basename(name, extname(name));
const withExtension = (ext) => ({ name }) => (/\.[^.]+$/.test(name) ? name : `${name}${ext}`);
/** A valid XML element name from a file name, for the template's root element. */
const elementName = (name) => stem(name).replace(/^[^A-Za-z_]+|[^\w.-]/g, '') || 'root';

const TEMPLATES = {
  'storage.jsonFile': { ext: '.json', content: () => '{\n  \n}\n' },
  'storage.yamlFile': { ext: '.yaml', content: ({ name }) => `# ${stem(name)}\n\n` },
  'storage.tomlFile': { ext: '.toml', content: ({ name }) => `# ${stem(name)}\n\n[${stem(name).replace(/[^A-Za-z0-9_-]/g, '_') || 'table'}]\n` },
  'storage.xmlFile': { ext: '.xml', content: ({ name }) => `<?xml version="1.0" encoding="UTF-8"?>\n<${elementName(name)}>\n</${elementName(name)}>\n` },
  'storage.csvFile': { ext: '.csv', content: () => 'id,name\n' },
  'storage.sqlFile': { ext: '.sql', content: ({ name }) => `-- ${stem(name)}\n\n` },
};

export function activate(saturn) {
  for (const [id, render] of Object.entries(RENDERERS)) {
    saturn.previews.registerRenderer(id, (text, ctx) => {
      try {
        return wrap(render(text, ctx.path));
      } catch (e) {
        const format = /\.(tsv|tab)$/i.test(ctx.path) ? 'TSV' : FORMAT_NAMES[id];
        return wrap(errorPage(format, e, text));
      }
    });
  }

  for (const [id, { ext, content }] of Object.entries(TEMPLATES)) {
    saturn.files.registerTemplate(id, { fileName: withExtension(ext), content });
  }
}
