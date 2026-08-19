// Duplicate keys in the client's inline style objects.
//
// These files carry large `const s = { ... }` style maps. A duplicate key is
// a WARNING in esbuild, not an error: the build succeeds and the later value
// silently wins. A scripted insert of `paddingBottom` landed on top of an
// existing one and quietly disabled the safe-area fix it was making, and the
// build shipped.
//
// esbuild only reports the first occurrence it meets per file, and only when
// someone reads the build log. This fails the suite instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'client', 'src');

// Blank out strings and comments so braces and colons inside them cannot be
// mistaken for structure. Length is preserved so offsets still line up with
// the original text for reporting line numbers.
function mask(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out.push(' '); i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') { out.push(' '); i++; }
        if (i < s.length) { out.push(s[i] === '\n' ? '\n' : ' '); i++; }
      }
      if (i < s.length) { out.push(' '); i++; }
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') { out.push(' '); i++; }
    } else if (c === '/' && s[i + 1] === '*') {
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        out.push(s[i] === '\n' ? '\n' : ' '); i++;
      }
      out.push(' '); out.push(' '); i += 2;
    } else {
      out.push(c); i++;
    }
  }
  return out.join('');
}

// Top-level keys of one object literal, ignoring anything nested inside it.
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    else if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
      if (m && (i === 0 || ' ,\n'.includes(body[i - 1]))) keys.push(m[1]);
    }
  }
  return keys;
}

function jsxFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsxFiles(p));
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no style object declares the same property twice', () => {
  const findings = [];
  for (const file of jsxFiles(SRC)) {
    const raw = fs.readFileSync(file, 'utf8');
    const masked = mask(raw);
    // Style entries are written at two-space indent inside `const s = {`.
    for (const m of masked.matchAll(/^  ([A-Za-z_$][\w$]*): \{/gm)) {
      const open = m.index + m[0].length - 1;
      let depth = 0, i = open;
      for (; i < masked.length; i++) {
        if (masked[i] === '{') depth++;
        else if (masked[i] === '}') { depth--; if (depth === 0) break; }
      }
      const keys = topLevelKeys(masked.slice(open + 1, i));
      const counts = keys.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
      for (const [k, n] of Object.entries(counts)) {
        if (n > 1) {
          findings.push(
            `${path.relative(SRC, file)}:${raw.slice(0, m.index).split('\n').length}` +
            `  ${m[1]}.${k} declared ${n}x`);
        }
      }
    }
  }
  assert.deepEqual(findings, [],
    'duplicate keys silently discard the earlier value:\n  ' + findings.join('\n  '));
});

test('the detector actually detects', () => {
  // A check that cannot fail is worse than no check. Prove it bites.
  const sample = `
const s = {
  ok: { paddingBottom: 4, color: 'red' },
  bad: {
    paddingBottom: 'calc(1px + var(--safe-bot))',
    borderRadius: '20px 20px 0 0',
    paddingBottom: 32,
  },
  // paddingBottom: 1, paddingBottom: 2   <- a comment must not trip it
  quoted: { content: 'paddingBottom: 1, paddingBottom: 2' },
  nested: { a: { dup: 1, dup: 2 }, dup: 3 },
}`;
  const masked = mask(sample);
  const found = [];
  for (const m of masked.matchAll(/^  ([A-Za-z_$][\w$]*): \{/gm)) {
    const open = m.index + m[0].length - 1;
    let depth = 0, i = open;
    for (; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') { depth--; if (depth === 0) break; }
    }
    const keys = topLevelKeys(masked.slice(open + 1, i));
    const counts = keys.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
    for (const [k, n] of Object.entries(counts)) if (n > 1) found.push(`${m[1]}.${k}`);
  }
  assert.deepEqual(found, ['bad.paddingBottom'],
    'the detector must catch the real duplicate and ignore comments, ' +
    'string contents, and keys nested one level down');
});
