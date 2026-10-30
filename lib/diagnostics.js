/**
 * Problems in a document as LSP diagnostics (0-based ranges), and quick fixes for the ones that
 * have an obvious repair. Everything here is pure: the language server supplies the text.
 */
import { ParseError, lineIndex } from './common.js';
import { detectDelimiter, fieldsWithOffsets, parseCsv } from './csv.js';
import { flavourOf, parseIni } from './ini.js';
import { isJsonc, parseJson } from './json.js';
import { parseToml } from './toml.js';
import { parseXml } from './xml.js';
import { parseYaml } from './yaml.js';

const Severity = { Error: 1, Warning: 2 };
const SOURCE = 'storage';

const PARSERS = {
  json: (text, path) => {
    if (!/\.(jsonl|ndjson)$/i.test(path)) return parseJson(text, { jsonc: isJsonc(path) });
    text.split(/\r?\n/).forEach((line, n) => {
      if (!line.trim()) return;
      try {
        parseJson(line);
      } catch (e) {
        if (e instanceof ParseError) e.line = n + 1;
        throw e;
      }
    });
  },
  yaml: (text) => parseYaml(text),
  toml: (text) => parseToml(text),
  xml: (text) => parseXml(text),
  ini: (text, path) => parseIni(text, flavourOf(path)),
  csv: (text, path) => parseCsv(text, detectDelimiter(text, path)),
};
PARSERS.tsv = PARSERS.csv;

/** A parse error's range: from its position over the word there (or one character). */
function errorRange(lines, error) {
  const line = Math.max(0, error.line - 1);
  const lineText = lines[line] ?? '';
  const character = Math.min(Math.max(0, (error.column ?? 1) - 1), lineText.length);
  const word = /^[\w:.-]+|^./.exec(lineText.slice(character))?.[0] ?? '';
  return { start: { line, character }, end: { line, character: character + word.length } };
}

export function diagnose(text, languageId, path = '') {
  const parse = PARSERS[languageId];
  if (!parse) return [];
  const out = [];
  try {
    parse(text, path);
  } catch (e) {
    if (!(e instanceof ParseError)) return [];
    out.push({ range: errorRange(text.split(/\r?\n/), e), severity: Severity.Error, source: SOURCE, message: e.message });
  }
  if (languageId === 'csv' || languageId === 'tsv') out.push(...raggedRows(text, path));
  return out;
}

/** Rows whose field count differs from the header's. */
function raggedRows(text, path) {
  const rows = fieldsWithOffsets(text, detectDelimiter(text, path));
  const columns = rows[0]?.length ?? 0;
  if (columns < 2) return [];
  const { position } = lineIndex(text);
  return rows.slice(1).flatMap((row) => {
    if (row.length === columns || (row.length === 1 && row[0].value === '')) return [];
    const start = position(row[0].offset);
    const last = row[row.length - 1];
    return [{
      range: { start, end: position(last.offset + last.value.length) },
      severity: Severity.Warning,
      source: SOURCE,
      message: `Row has ${row.length} field${row.length === 1 ? '' : 's'}; the header has ${columns}`,
    }];
  });
}

/** Code actions (LSP CodeAction literals) that repair the given diagnostics. */
export function quickFixes(text, uri, diagnostics) {
  const index = lineIndex(text);
  const action = (title, diagnostic, edits) => ({
    title, kind: 'quickfix', isPreferred: true, diagnostics: [diagnostic], edit: { changes: { [uri]: edits } },
  });
  return diagnostics.flatMap((d) => {
    let m;
    if (/^Trailing comma before [}\]]$/.test(d.message)) {
      let at = index.offset(d.range.start) - 1;
      while (at >= 0 && /\s/.test(text[at])) at--;
      if (text[at] !== ',') return [];
      return [action('Remove trailing comma', d, [{ range: { start: index.position(at), end: index.position(at + 1) }, newText: '' }])];
    }
    if ((m = /^Missing closing tag (<\/[^>]+>)$/.exec(d.message))) {
      const end = index.position(text.length);
      const newText = `${text.length && !text.endsWith('\n') ? '\n' : ''}${m[1]}\n`;
      return [action(`Add ${m[1]}`, d, [{ range: { start: end, end }, newText }])];
    }
    if ((m = /^Closing tag <\/[^>]+> does not match <([^>]+)>$/.exec(d.message))) {
      return [action(`Insert </${m[1]}>`, d, [{ range: { start: d.range.start, end: d.range.start }, newText: `</${m[1]}>` }])];
    }
    return [];
  });
}
