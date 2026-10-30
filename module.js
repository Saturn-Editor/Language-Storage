import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
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

const PANEL_ID = 'storage.sqlGenerator';
// The page can't load modules, so the generator's source is inlined with its exports removed.
const generatorSource = readFileSync(join(here, 'lib', 'sqlgen.js'), 'utf8').replace(/^export /gm, '');
const panelHtml = readFileSync(join(here, 'panel', 'sql-generator.html'), 'utf8');
const panelScript = readFileSync(join(here, 'panel', 'sql-generator.js'), 'utf8');
/** JSON that is safe inside a <script> element. */
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

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

const MAX_SCHEMA_FILES = 200;
const MAX_SQL_BYTES = 2 * 1024 * 1024;

/** Tables from the project's .sql files (open editors' unsaved text first). Later files win on a repeated name. */
export async function projectSchema(saturn, projectPath) {
  const files = (await saturn.workspace.findFiles(projectPath, '**/*.{sql,ddl}')).slice(0, MAX_SCHEMA_FILES);
  const tables = new Map();
  for (const file of files) {
    try {
      const open = saturn.editor.file(projectPath, file);
      if (!open && (await stat(file)).size > MAX_SQL_BYTES) continue;
      for (const t of readSchema(open?.text ?? (await readFile(file, 'utf8'))).tables) tables.set(t.name.toLowerCase(), t);
    } catch {
      // Unreadable or unparseable files are skipped.
    }
  }
  return { tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Copies text with the platform's clipboard tool; rejects if none works. */
export function copyToClipboard(text, platform = process.platform, env = process.env) {
  const candidates = platform === 'darwin' ? [['pbcopy', []]]
    : platform === 'win32' ? [['clip', []]]
    : [...(env.WAYLAND_DISPLAY ? [['wl-copy', []]] : []), ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  // clip.exe reads UTF-16 with a byte-order mark; the others read UTF-8.
  const input = platform === 'win32' ? Buffer.from(`\uFEFF${text}`, 'utf16le') : Buffer.from(text, 'utf8');
  const attempt = ([command, args]) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
    child.stdin.end(input);
  });
  return candidates.reduce((chain, c) => chain.catch(() => attempt(c)), Promise.reject(new Error('no clipboard tool')));
}

const sqlFileName = (name) => (/\.(sql|ddl)$/i.test(name) ? name : `${name}.sql`);

/** The SQL Generator panel: its state per project lives here so theme reloads keep it. */
function registerSqlGenerator(saturn) {
  const states = new Map();
  const status = (projectPath, message, kind = 'info') => saturn.webviews.postMessage(PANEL_ID, { type: 'status', message, kind }, projectPath);

  const outputs = {
    async copy({ projectPath }, sql) {
      try {
        await copyToClipboard(sql);
        status(projectPath, 'Copied to the clipboard.');
      } catch {
        status(projectPath, 'Couldn\'t reach the clipboard: select the SQL and copy it yourself.', 'error');
      }
    },
    async newFile({ projectPath }, sql) {
      const name = await saturn.window.showInput(projectPath, { title: 'New SQL file', value: 'query.sql', placeholder: 'Path in the project, e.g. queries/report.sql' });
      if (!name?.trim()) return;
      const path = isAbsolute(name.trim()) ? name.trim() : join(projectPath, sqlFileName(name.trim()));
      if (relative(projectPath, path).startsWith('..')) return status(projectPath, 'Pick a path inside the project.', 'error');
      try {
        await writeFile(path, `${sql}\n`, { flag: 'wx' });
      } catch (e) {
        return status(projectPath, e.code === 'EEXIST' ? `${basename(path)} already exists: pick another name, or use Append.` : `Couldn't create ${basename(path)}: ${e.message}`, 'error');
      }
      saturn.workspace.openFile(projectPath, path, 1, 1);
      status(projectPath, `Created ${relative(projectPath, path)}.`);
    },
    async append({ projectPath }, sql) {
      const [path] = (await saturn.window.showOpenDialog(projectPath, { title: 'Append SQL to…', filters: [{ name: 'SQL', extensions: ['sql', 'ddl'] }] })) ?? [];
      if (!path) return;
      // Writing under unsaved edits would lose one side or the other.
      if (saturn.editor.file(projectPath, path)?.dirty) return status(projectPath, `${basename(path)} has unsaved changes: save it, then append.`, 'error');
      let existing = '';
      try {
        existing = await readFile(path, 'utf8');
      } catch {
        // A missing file is created by appendFile.
      }
      const separator = !existing ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
      try {
        await appendFile(path, `${separator}${sql}\n`);
      } catch (e) {
        return status(projectPath, `Couldn't write ${basename(path)}: ${e.message}`, 'error');
      }
      const line = (existing + separator).split('\n').length;
      saturn.workspace.openFile(projectPath, path, line, 1);
      status(projectPath, `Appended to ${basename(path)}.`);
    },
  };

  saturn.webviews.register(PANEL_ID, {
    async html(ctx) {
      const initial = { state: states.get(ctx.projectPath) ?? null, schema: await projectSchema(saturn, ctx.projectPath) };
      return `${panelHtml}\n<script>\nconst INITIAL = ${scriptJson(initial)};\n${generatorSource}\n${panelScript}</script>`;
    },
    async onMessage(message, ctx) {
      if (message?.type === 'state') states.set(ctx.projectPath, message.state);
      else if (typeof message?.sql === 'string' && Object.hasOwn(outputs, message.type)) await outputs[message.type](ctx, message.sql);
    },
  });

  // New or edited CREATE TABLEs show up in the panel.
  const refresh = async (projectPath) => saturn.webviews.postMessage(PANEL_ID, { type: 'schema', schema: await projectSchema(saturn, projectPath) }, projectPath);
  let timer;
  saturn.workspace.onDidChangeFiles(({ projectPath }) => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(projectPath).catch(() => undefined), 500);
  });
  saturn.editor.onDidChangeFile(({ projectPath, file }) => {
    if (file.languageId !== 'sql') return;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(projectPath).catch(() => undefined), 1000);
  });
  saturn.projects.onDidClose(({ projectPath }) => states.delete(projectPath));
}

export function activate(saturn) {
  registerSqlGenerator(saturn);

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
