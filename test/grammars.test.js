/**
 * Static checks on the TextMate grammars. Saturn-Core runs them with its own engine (Oniguruma), so
 * these only catch authoring mistakes: regexes that don't compile, end-pattern backreferences to
 * groups the begin pattern lacks, captures that don't exist, includes that point nowhere, and
 * variable-length lookbehinds (which Oniguruma rejects).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../saturn-language.json', import.meta.url), 'utf8'));

/** Compiles an Oniguruma pattern as a JS RegExp, translating the one inline flag we use. */
function compile(source) {
  const flags = source.startsWith('(?i)') ? 'i' : '';
  return new RegExp(flags ? source.slice(4) : source, flags);
}

const groupCount = (source) => new RegExp(`${compile(source).source}|`, compile(source).flags).exec('').length - 1;

/** Finds lookbehinds whose body contains a quantifier. */
function variableLookbehind(source) {
  for (const m of source.matchAll(/\(\?<[=!]/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let inClass = false;
    const start = i;
    for (; i < source.length && depth; i++) {
      const ch = source[i];
      if (ch === '\\') i++;
      else if (inClass) inClass = ch !== ']';
      else if (ch === '[') inClass = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const body = source.slice(start, i - 1).replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
    if (/[*+?]|\{\d+,\}/.test(body.replace(/\(\?:/g, '('))) return body;
  }
  return null;
}

function* rules(node, path) {
  if (Array.isArray(node)) {
    for (const [n, child] of node.entries()) yield* rules(child, `${path}[${n}]`);
  } else if (node && typeof node === 'object') {
    if ('match' in node || 'begin' in node || 'include' in node) yield [node, path];
    for (const [k, v] of Object.entries(node)) if (typeof v === 'object') yield* rules(v, `${path}.${k}`);
  }
}

for (const language of manifest.contributes.languages) {
  test(`grammar for ${language.id}`, () => {
    const grammar = JSON.parse(readFileSync(new URL(`../${language.grammar}`, import.meta.url), 'utf8'));
    assert.equal(grammar.scopeName, language.scopeName);
    let checked = 0;
    for (const [rule, path] of rules(grammar, language.id)) {
      if (rule.include) {
        if (rule.include.startsWith('#')) assert.ok(grammar.repository?.[rule.include.slice(1)], `${path}: missing ${rule.include}`);
        continue;
      }
      for (const key of ['match', 'begin', 'end']) {
        if (!(key in rule)) continue;
        const source = rule[key];
        // End patterns may refer back to begin captures; substitute something compilable.
        const compilable = key === 'end' ? source.replace(/\\([1-9])/g, '(?:x)') : source;
        assert.doesNotThrow(() => compile(compilable), `${path}.${key}: ${source}`);
        assert.equal(variableLookbehind(source), null, `${path}.${key}: variable-length lookbehind`);
        checked++;
      }
      if (rule.end) {
        const begins = groupCount(rule.begin);
        for (const m of rule.end.matchAll(/\\([1-9])/g)) assert.ok(Number(m[1]) <= begins, `${path}.end refers to \\${m[1]}`);
      }
      for (const [key, source] of [['captures', rule.match ?? rule.begin], ['beginCaptures', rule.begin], ['endCaptures', rule.end]]) {
        if (!rule[key] || !source) continue;
        const groups = groupCount(key === 'endCaptures' ? source.replace(/\\([1-9])/g, '(?:x)') : source);
        for (const n of Object.keys(rule[key])) assert.ok(Number(n) <= groups, `${path}.${key} has group ${n} of ${groups}`);
      }
    }
    assert.ok(checked > 0);
  });
}

test('scope names put the themed fallback outermost', () => {
  const themed = /^(comment|string|keyword|constant\.numeric|entity\.name\.function|entity\.name\.type|variable)(\.|$)/;
  for (const language of manifest.contributes.languages) {
    const text = readFileSync(new URL(`../${language.grammar}`, import.meta.url), 'utf8');
    for (const [, name] of text.matchAll(/"(?:name|contentName)": "([^"]+ [^"]+)"/g)) {
      assert.match(name.split(' ')[0], themed, `${language.id}: ${name}`);
    }
  }
});

test('previews and languages cover the same extensions', () => {
  const languageExts = manifest.contributes.languages.flatMap((l) => l.extensions).sort();
  const previewExts = manifest.contributes.previews.flatMap((p) => p.extensions).sort();
  assert.deepEqual(previewExts, languageExts);
});
