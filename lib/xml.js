/**
 * A small, non-validating XML parser. It checks well-formedness (matching tags, quoted attributes,
 * one root element) and returns a tree:
 *   { type: 'element', name, attributes: [{ name, value }], children: [node] }
 *   { type: 'text' | 'cdata' | 'comment', value }
 *   { type: 'pi', target, value }
 */
import { errorAt } from './common.js';

const NAME = /^[A-Za-z_:À-￿][\w.:·À-￿-]*/;
const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s, fail = () => {}) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);?/g, (m, e) => {
    if (!m.endsWith(';')) return fail(`Unescaped '&'`) ?? m;
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    // Entities declared in a DTD are left as written.
    return ENTITIES[e] ?? m;
  });
}

/** Returns { prolog: [nodes before the root], root, epilog: [nodes after] }. */
export function parseXml(text) {
  const src = text.replace(/^﻿/, '');
  let i = 0;
  const fail = (message, at = i) => {
    throw errorAt(src, at, message);
  };

  function name() {
    const m = NAME.exec(src.slice(i));
    if (!m) fail(i >= src.length ? 'Unexpected end of file' : `Expected a name but found '${src[i]}'`);
    i += m[0].length;
    return m[0];
  }
  const spaces = () => {
    while (/\s/.test(src[i] ?? '')) i++;
  };

  /** Comments, CDATA, processing instructions and doctypes; null when none starts here. */
  function special() {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) fail('Unterminated comment');
      const node = { type: 'comment', value: src.slice(i + 4, end) };
      i = end + 3;
      return node;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i);
      if (end === -1) fail('Unterminated CDATA section');
      const node = { type: 'cdata', value: src.slice(i + 9, end) };
      i = end + 3;
      return node;
    }
    if (src.startsWith('<?', i)) {
      const start = i;
      i += 2;
      const target = name();
      const end = src.indexOf('?>', i);
      if (end === -1) fail('Unterminated processing instruction', start);
      const node = { type: 'pi', target, value: src.slice(i, end).trim() };
      i = end + 2;
      return node;
    }
    if (src.startsWith('<!DOCTYPE', i) || src.startsWith('<!doctype', i)) {
      const start = i;
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '[') depth++;
        else if (src[i] === ']') depth--;
        else if (src[i] === '>' && depth <= 0) break;
      }
      if (i >= src.length) fail('Unterminated DOCTYPE', start);
      i++;
      return { type: 'doctype', value: src.slice(start + 9, i - 1).trim() };
    }
    return null;
  }

  function element() {
    const start = i++;
    const tag = name();
    const attributes = [];
    const seen = new Set();
    for (;;) {
      const before = i;
      spaces();
      if (src.startsWith('/>', i)) {
        i += 2;
        return { type: 'element', name: tag, attributes, children: [] };
      }
      if (src[i] === '>') {
        i++;
        break;
      }
      if (i >= src.length) fail(`Unclosed tag <${tag}>`, start);
      if (i === before) fail(`Expected whitespace before an attribute in <${tag}>`);
      const attrAt = i;
      const attr = name();
      if (seen.has(attr)) fail(`Duplicate attribute "${attr}"`, attrAt);
      seen.add(attr);
      spaces();
      if (src[i] !== '=') fail(`Attribute "${attr}" needs a value`);
      i++;
      spaces();
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`Attribute "${attr}" value must be quoted`);
      const end = src.indexOf(q, i + 1);
      if (end === -1) fail(`Unterminated attribute value`);
      const raw = src.slice(i + 1, end);
      if (raw.includes('<')) fail(`'<' is not allowed in attribute values`, i + 1 + raw.indexOf('<'));
      attributes.push({ name: attr, value: decodeEntities(raw, (m) => fail(m, i + 1)) });
      i = end + 1;
    }

    const children = [];
    for (;;) {
      if (i >= src.length) fail(`Missing closing tag </${tag}>`, start);
      if (src.startsWith('</', i)) {
        const closeAt = i;
        i += 2;
        const closing = name();
        spaces();
        if (src[i] !== '>') fail(`Expected '>' to end </${closing}>`);
        i++;
        if (closing !== tag) fail(`Closing tag </${closing}> does not match <${tag}>`, closeAt);
        return { type: 'element', name: tag, attributes, children };
      }
      const s = special();
      if (s) {
        if (s.type === 'doctype') fail('A DOCTYPE is only allowed before the root element');
        children.push(s);
        continue;
      }
      if (src[i] === '<') {
        children.push(element());
        continue;
      }
      const end = src.indexOf('<', i);
      const raw = src.slice(i, end === -1 ? src.length : end);
      const textAt = i;
      i += raw.length;
      if (raw.trim()) children.push({ type: 'text', value: decodeEntities(raw, (m) => fail(m, textAt)) });
    }
  }

  const prolog = [];
  const epilog = [];
  let root = null;
  for (;;) {
    spaces();
    if (i >= src.length) break;
    const s = special();
    if (s) {
      (root ? epilog : prolog).push(s);
      continue;
    }
    if (src[i] !== '<') fail('Text is not allowed outside the root element');
    if (root) fail('Only one root element is allowed');
    root = element();
  }
  if (!root && prolog.some((n) => n.type !== 'pi' || n.target !== 'xml')) fail('No root element');
  return { prolog, root, epilog };
}
