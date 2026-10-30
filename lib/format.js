/**
 * Whole-document formatting for JSON and XML. Each formatter returns the new text, or null when it
 * won't format (the document doesn't parse, or formatting would lose something such as comments).
 */
import { parseJson } from './json.js';
import { parseXml } from './xml.js';

export function format(text, languageId, path = '', { tabSize = 2, insertSpaces = true } = {}) {
  const unit = insertSpaces ? ' '.repeat(tabSize) : '\t';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = null;
  if (languageId === 'json') out = formatJson(text, path, unit, eol);
  else if (languageId === 'xml') out = formatXml(text, unit, eol);
  return out === null || out === text ? null : out;
}

// ---- JSON ----

/** The data model as JSON text: key order and number spelling (e.g. 1.50, big integers) kept. */
function stringify(node, unit, eol, depth = 0) {
  if (node.type === 'number') return node.raw ?? String(node.value);
  if (node.type !== 'object' && node.type !== 'array') return JSON.stringify(node.value);
  const parts = node.type === 'object'
    ? node.entries.map(({ key, value }) => `${JSON.stringify(key)}:${unit ? ' ' : ''}${stringify(value, unit, eol, depth + 1)}`)
    : node.items.map((item) => stringify(item, unit, eol, depth + 1));
  const [open, close] = node.type === 'object' ? ['{', '}'] : ['[', ']'];
  if (!parts.length) return open + close;
  if (!unit) return `${open}${parts.join(',')}${close}`;
  const inner = unit.repeat(depth + 1);
  return `${open}${eol}${inner}${parts.join(`,${eol}${inner}`)}${eol}${unit.repeat(depth)}${close}`;
}

function formatJson(text, path, unit, eol) {
  try {
    if (/\.(jsonl|ndjson)$/i.test(path)) {
      // One compact record per line.
      const lines = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => stringify(parseJson(l), '', eol));
      return lines.length ? lines.join(eol) + eol : text;
    }
    // Strict parsing: JSON with comments or trailing commas is left alone rather than losing them.
    if (!text.trim()) return null;
    return stringify(parseJson(text), unit, eol) + eol;
  } catch {
    return null;
  }
}

// ---- XML ----

const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>|<\/?[A-Za-z_][\w:.-]*(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g;

function xmlTokens(text) {
  return [...text.matchAll(XML_TOKEN)].map(([raw]) => {
    if (raw.startsWith('<!--') || raw.startsWith('<?') || raw.startsWith('<!D')) return { kind: 'node', raw };
    if (raw.startsWith('<![CDATA[')) return { kind: 'text', raw };
    if (raw.startsWith('</')) return { kind: 'close', raw, name: /^<\/([^\s>]+)/.exec(raw)[1] };
    if (raw.startsWith('<')) return { kind: raw.endsWith('/>') ? 'empty' : 'open', raw, name: /^<([^\s/>]+)/.exec(raw)[1] };
    return { kind: 'text', raw };
  });
}

/**
 * Re-indents elements one per line. Elements holding only text stay on one line with their text
 * untouched; documents with mixed content or xml:space="preserve" are not formatted.
 */
function formatXml(text, unit, eol) {
  try {
    parseXml(text);
  } catch {
    return null;
  }
  if (/xml:space\s*=\s*["']preserve/.test(text)) return null;
  const tokens = xmlTokens(text).filter((t) => !(t.kind === 'text' && !t.raw.trim()));
  const lines = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const indent = unit.repeat(depth);
    if (t.kind === 'open') {
      // <a>text</a> (or <a></a>) stays on one line.
      let j = i + 1;
      while (tokens[j]?.kind === 'text') j++;
      if (tokens[j]?.kind === 'close' && tokens[j].name === t.name) {
        lines.push(indent + tokens.slice(i, j + 1).map((x) => x.raw).join(''));
        i = j;
        continue;
      }
      if (j > i + 1) return null; // text followed by child elements: mixed content
      lines.push(indent + t.raw);
      depth++;
    } else if (t.kind === 'close') {
      depth = Math.max(0, depth - 1);
      lines.push(unit.repeat(depth) + t.raw);
    } else if (t.kind === 'text') {
      if (depth > 0) return null; // text after a child element: mixed content
      lines.push(indent + t.raw.trim());
    } else lines.push(indent + t.raw);
  }
  return lines.join(eol) + eol;
}
