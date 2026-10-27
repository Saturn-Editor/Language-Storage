/**
 * INI-style files: .ini/.cfg/.conf ([section] and key = value), .properties (key=value, key: value,
 * "\" line continuations) and .env (KEY=value, optional "export", quoted values).
 * Parsing is lenient, as these formats have no single standard: lines that aren't understood are
 * reported as errors so the preview can point at them.
 */
import { ParseError, scalar } from './common.js';

export function flavourOf(path) {
  const name = path.toLowerCase();
  if (/(^|[\\/.])env(\.[\w-]+)?$/.test(name) || name.endsWith('.env')) return 'env';
  if (name.endsWith('.properties')) return 'properties';
  return 'ini';
}

const PROPERTIES_ESCAPES = { t: '\t', n: '\n', r: '\r', f: '\f' };

export function parseIni(text, flavour = 'ini') {
  const lines = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
  const root = { type: 'object', entries: [] };
  let section = root;
  const sections = new Map();

  const set = (target, key, value) => {
    const existing = target.entries.find((e) => e.key === key);
    // Later values win, as most readers of these formats behave.
    if (existing) existing.value = value;
    else target.entries.push({ key, value });
  };

  for (let n = 0; n < lines.length; n++) {
    const no = n + 1;
    let line = lines[n].trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || (flavour === 'properties' && line.startsWith('!'))) continue;

    if (flavour === 'ini' && line.startsWith('[')) {
      const m = /^\[([^\]]*)\]\s*(?:[;#].*)?$/.exec(line);
      if (!m) throw new ParseError('Expected a section header like [name]', no, 1);
      const name = m[1].trim();
      section = sections.get(name);
      if (!section) {
        section = { type: 'object', entries: [] };
        sections.set(name, section);
        root.entries.push({ key: name, value: section });
      }
      continue;
    }

    if (flavour === 'properties') {
      while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && n + 1 < lines.length) line = line.slice(0, -1) + lines[++n].trimStart();
      const m = /^((?:\\.|[^\\:=\s])+)\s*[:=\s]\s*([\s\S]*)$/.exec(line) ?? /^((?:\\.|[^\\:=\s])+)$/.exec(line);
      if (!m) throw new ParseError('Expected key=value', no, 1);
      const unescape = (s) => (s ?? '').replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, ch) => (hex ? String.fromCharCode(parseInt(hex, 16)) : (PROPERTIES_ESCAPES[ch] ?? ch)));
      set(section, unescape(m[1]), scalar('string', unescape(m[2])));
      continue;
    }

    if (flavour === 'env') {
      const m = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
      if (!m) throw new ParseError('Expected NAME=value', no, 1);
      let value = m[2];
      const q = value[0];
      if (q === '"' || q === "'" || q === '`') {
        // Quoted values may span lines.
        let body = value.slice(1);
        let end = closingIndex(body, q);
        while (end === -1 && n + 1 < lines.length) {
          body += `\n${lines[++n]}`;
          end = closingIndex(body, q);
        }
        if (end === -1) throw new ParseError('Unterminated quoted value', no, line.indexOf(q) + 1);
        value = body.slice(0, end);
        if (q === '"') value = value.replace(/\\([nrt"\\$])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
      } else {
        value = value.replace(/\s+#.*$/, '').trim();
      }
      set(section, m[1], scalar('string', value));
      continue;
    }

    const m = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) {
      // A bare key (e.g. "skip-networking" in my.cnf) is a flag.
      if (/^[\w.-]+$/.test(line)) set(section, line, scalar('boolean', true, ''));
      else throw new ParseError('Expected key = value', no, 1);
      continue;
    }
    let value = m[2].replace(/\s+[;#].*$/, '');
    if (/^"(?:[^"\\]|\\.)*"$/.test(value) || /^'[^']*'$/.test(value)) value = value.slice(1, -1);
    set(section, m[1], scalar('string', value));
  }
  return root;
}

function closingIndex(s, q) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && q === '"') i++;
    else if (s[i] === q) return i;
  }
  return -1;
}
