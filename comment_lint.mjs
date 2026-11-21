#!/usr/bin/env node
// comment_lint.mjs: report-only comment checker. It reads source files and prints findings to stdout.
// It never writes, renames or deletes any file. Contract (exit codes, output format, rules): README.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_LANG = {
  '.py': 'py', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js',
  '.ps1': 'ps', '.sh': 'sh', '.css': 'css',
};
const DEFAULT_EXCLUDE_DIRS = ['node_modules', '.git'];

// Output language. Human-readable text exists in English (default) and Korean; keys, rule names and line prefixes
// never depend on it. A text that has both forms is U(english, korean) and is picked at output time with pick().
const LANGS = ['en', 'ko'];
const U = (en, ko) => ({ en, ko });
const pick = (t, lang) => (typeof t === 'string' ? t : t[lang]);

// ---------- comment extraction ----------
// Each scanner fills ctx.out with raw comment spans {kind: 'line'|'block'|'doc', a, b} (character offsets, b exclusive).
// Where the reading is ambiguous (regex or division, a heredoc delimiter, a here-string end, a comment inside a
// string substitution, an unclosed construct), the scanner calls ctx.unsure(offset, reason) and goes on with its
// best guess. The caller then marks every finding of that file as read-uncertain and reports the spots (README).

function eol(s, i) { const j = s.indexOf('\n', i); return j < 0 ? s.length : j; }
// JS ends a line comment at CR, LF, U+2028 and U+2029.
function jsEol(s, i) {
  for (let j = i; j < s.length; j++) { const c = s[j]; if (c === '\n' || c === '\r' || c === ' ' || c === ' ') return j; }
  return s.length;
}
// A backslash escapes the next character; before CRLF it escapes both (a line continuation).
function skipEsc(s, j) { return s[j + 1] === '\r' && s[j + 2] === '\n' ? j + 3 : j + 2; }

function makeCtx(s) {
  const ctx = { s, out: [], marks: [], strDepth: 0, heredocs: [] };
  ctx.unsure = (at, reason) => { ctx.marks.push({ at, reason }); };
  ctx.push = (kind, a, b) => {
    if (ctx.strDepth > 0) ctx.unsure(a, U('comment inside a string substitution', '문자열 안 치환식의 주석'));
    ctx.out.push({ kind, a, b });
  };
  return ctx;
}

// ---- Python ----
function scanPy(c) {
  const s = c.s, n = s.length; let i = 0; let depth = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === '#') { const j = eol(s, i); c.push('line', i, j); i = j; continue; }
    if (ch === '"' || ch === "'") {
      let k = i;
      while (k > 0 && i - k < 2 && /[rRbBfFuUtT]/.test(s[k - 1])) k--;
      if (k > 0 && /[A-Za-z0-9_]/.test(s[k - 1])) k = i;
      const fmt = /[fFtT]/.test(s.slice(k, i));
      const triple = s.startsWith(ch + ch + ch, i);
      const j = pyString(c, i, ch, triple, fmt);
      // Docstring-like only when the string is the whole statement: "x".lower() is an expression, not a comment.
      if (triple && depth === 0 && atStatementStart(s, k) && /^[ \t]*(#|;|\r?\n|$)/.test(s.slice(j, eol(s, j) + 1))) c.push('doc', k, j);
      i = j; continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    i++;
  }
}

// A triple-quoted string counts as a docstring-like comment block only when it is a statement of its own:
// nothing but whitespace before it on the line, outside brackets, and no backslash continuation above.
function atStatementStart(s, k) {
  const ls = s.lastIndexOf('\n', k - 1) + 1;
  if (s.slice(ls, k).trim() !== '') return false;
  if (ls === 0) return true;
  const prev = s.slice(s.lastIndexOf('\n', ls - 2) + 1, ls - 1).replace(/\r$/, '');
  return !prev.endsWith('\\');
}

function pyString(c, i, q, triple, fmt) {
  const s = c.s, n = s.length, ql = triple ? 3 : 1; let j = i + ql;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\') { j = skipEsc(s, j); continue; }
    if (triple ? s.startsWith(q + q + q, j) : ch === q) return j + ql;
    if (!triple && ch === '\n') { c.unsure(j, U('unclosed string', '닫히지 않은 문자열')); return j; }
    if (fmt && ch === '{') { if (s[j + 1] === '{') { j += 2; continue; } j = pyField(c, j + 1, q, triple); continue; }
    j++;
  }
  c.unsure(i, U('unclosed string', '닫히지 않은 문자열')); return n;
}

// An f-string replacement field. Python 3.12 allows the outer quote and '#' comments inside a field, older
// versions do not, so those spots are unsure. The format spec after a top-level ':' is literal text ({n:#x}).
function pyField(c, j, q, triple) {
  const s = c.s, n = s.length; let d = 0;
  while (j < n) {
    const ch = s[j];
    if (ch === '"' || ch === "'") {
      const t3 = s.startsWith(ch + ch + ch, j);
      if (ch === q && (!triple || t3)) c.unsure(j, U('same quote as the outer string inside an f-string field', 'f-string 치환식 안에 바깥과 같은 따옴표'));
      j = pyString(c, j, ch, t3, false); continue;
    }
    if (ch === '#') {
      c.unsure(j, U('# inside an f-string field', 'f-string 치환식 안의 #'));
      const e = eol(s, j); c.out.push({ kind: 'line', a: j, b: e }); j = e; continue;
    }
    if (ch === '\n' && !triple) c.unsure(j, U('line break inside an f-string field', 'f-string 치환식 안의 줄바꿈'));
    if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']') d = Math.max(0, d - 1);
    else if (ch === '}') { if (d === 0) return j + 1; d--; }
    else if (ch === ':' && d === 0) {
      let k = j + 1; let b = 0;
      while (k < n) {
        const x = s[k];
        if (x === '{') b++;
        else if (x === '}') { if (b === 0) return k + 1; b--; }
        else if (!triple && (x === q || x === '\n')) break;
        k++;
      }
      c.unsure(j, U('unclosed f-string field', '닫히지 않은 f-string 치환식')); return k;
    }
    j++;
  }
  c.unsure(j, U('unclosed f-string field', '닫히지 않은 f-string 치환식')); return n;
}

// ---- JS, TS ----
const JS_REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'yield', 'await', 'instanceof']);
// After the ')' that closes if (...), while (...), for (...) or with (...), a '/' starts a regex.
const JS_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

function scanJs(c) { jsCode(c, c.s.startsWith('#!') ? eol(c.s, 0) : 0, false); }

// Scans code until the end, or (nested) until the '}' that closes a template ${...}.
function jsCode(c, i, nested) {
  const s = c.s, n = s.length;
  let last = ''; let lastWord = ''; let dotted = false; let braces = 0; const parens = [];
  const isKeyword = () => last === 'w' && !dotted && JS_REGEX_KEYWORDS.has(lastWord);
  while (i < n) {
    const ch = s[i]; const d = s[i + 1];
    if (ch === '/' && d === '/') { const j = jsEol(s, i); c.push('line', i, j); i = j; continue; }
    if (ch === '/' && d === '*') {
      const k = s.indexOf('*/', i + 2);
      if (k < 0) c.unsure(i, U('unclosed block comment', '닫히지 않은 블록 주석'));
      const j = k < 0 ? n : k + 2; c.push('block', i, j); i = j; continue;
    }
    if (ch === '"' || ch === "'") { i = quoted(c, i, ch); last = '"'; continue; }
    if (ch === '`') { i = jsTemplate(c, i); last = '`'; continue; }
    if (ch === '{') { braces++; last = '{'; i++; continue; }
    if (ch === '}') {
      if (nested && braces === 0) return i + 1;
      braces = Math.max(0, braces - 1); last = '}'; i++; continue;
    }
    if (ch === '(') { parens.push(last === 'w' && !dotted && JS_PAREN_KEYWORDS.has(lastWord)); last = '('; i++; continue; }
    if (ch === ')') { last = parens.pop() ? 'kw)' : ')'; i++; continue; }
    if ((ch === '+' || ch === '-') && d === ch) { last = 'incdec'; i += 2; continue; }
    // A '!' right after an operand is the TS non-null assertion (a! / b), so a '/' after it divides.
    if (ch === '!' && d !== '=' && (last === ')' || last === ']' || (last === 'w' && !isKeyword()))) { last = ')'; i++; continue; }
    if (ch === '/') {
      if (last === '}') c.unsure(i, U('/ after } (regex or division, unclear)', '} 뒤의 / (정규식인지 나눗셈인지 모름)'));
      const regexOk = last === '' || last === 'kw)' || (last.length === 1 && '(,=:[!&|?{;+-*%<>~^'.includes(last)) || isKeyword();
      if (regexOk) {
        let j = i + 1; let inClass = false; let closed = false;
        while (j < n && s[j] !== '\n' && s[j] !== '\r' && s[j] !== ' ' && s[j] !== ' ') {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '[') inClass = true;
          else if (s[j] === ']') inClass = false;
          else if (s[j] === '/' && !inClass) { closed = true; break; }
          j++;
        }
        if (closed) { j++; while (j < n && /[a-z]/i.test(s[j])) j++; i = j; last = 'w'; lastWord = ''; dotted = false; continue; }
        c.unsure(i, U('regex not closed on the same line', '같은 줄에서 닫히지 않은 정규식'));
      }
      last = '/'; i++; continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i; while (j < n && /[A-Za-z0-9_$]/.test(s[j])) j++;
      dotted = last === '.'; lastWord = s.slice(i, j); last = 'w'; i = j; continue;
    }
    last = ch; i++;
  }
  if (nested) c.unsure(i, U('unclosed template substitution', '닫히지 않은 템플릿 치환식'));
  return n;
}

function jsTemplate(c, i) {
  const s = c.s, n = s.length; let j = i + 1;
  while (j < n) {
    if (s[j] === '\\') { j = skipEsc(s, j); continue; }
    if (s[j] === '`') return j + 1;
    if (s[j] === '$' && s[j + 1] === '{') { j = jsCode(c, j + 2, true); continue; }
    j++;
  }
  c.unsure(i, U('unclosed template string', '닫히지 않은 템플릿 문자열')); return n;
}

// A one-line quoted string (JS, CSS). An unescaped line break before the closing quote is unsure.
function quoted(c, i, q) {
  const s = c.s, n = s.length; let j = i + 1;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\') { j = skipEsc(s, j); continue; }
    if (ch === q) return j + 1;
    if (ch === '\n' || ch === '\r') { c.unsure(j, U('unclosed string', '닫히지 않은 문자열')); return j; }
    j++;
  }
  c.unsure(i, U('unclosed string', '닫히지 않은 문자열')); return n;
}

// ---- CSS ----
// Inside an unquoted url(...) a '/*' is part of the URL, not a comment.
function scanCss(c) {
  const s = c.s, n = s.length; let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === '/' && s[i + 1] === '*') {
      const k = s.indexOf('*/', i + 2);
      if (k < 0) c.unsure(i, U('unclosed block comment', '닫히지 않은 블록 주석'));
      const j = k < 0 ? n : k + 2; c.push('block', i, j); i = j; continue;
    }
    if (ch === '"' || ch === "'") { i = quoted(c, i, ch); continue; }
    if ((ch === 'u' || ch === 'U') && /^url\(/i.test(s.slice(i, i + 4)) && !(i > 0 && /[\w-]/.test(s[i - 1]))) {
      let k = i + 4; while (k < n && /\s/.test(s[k])) k++;
      if (s[k] !== '"' && s[k] !== "'") {
        const e = s.indexOf(')', k);
        if (e < 0) { c.unsure(i, U('unclosed url(', '닫히지 않은 url(')); return; }
        i = e + 1; continue;
      }
      i = k; continue;
    }
    i++;
  }
}

// ---- PowerShell ----
// The tokenizer takes U+2018-U+201B as ' and U+201C-U+201E as " (also in here-string markers), but Windows
// PowerShell 5.1 reads a UTF-8 file without a BOM in the ANSI code page, where they are not quotes. A file that
// has them is read both ways: the curly reading is kept, a comment only the plain reading finds is added, and
// every spot where the two differ is unsure (README "Uncertain reading").
const PS_Q = { sq: "'", dq: '"' };
const PS_Q_CURLY = { sq: "'‘’‚‛", dq: '"“”„' };
function scanPs(c) {
  c.psq = PS_Q;
  if (!/[‘-„]/.test(c.s)) { psCode(c, 0, false); return; }
  const plain = makeCtx(c.s); plain.psq = PS_Q; psCode(plain, 0, false);
  c.psq = PS_Q_CURLY; psCode(c, 0, false);
  const key = (x) => `${x.kind}:${x.a}:${x.b}`;
  const curly = new Set(c.out.map(key)); const flat = new Set(plain.out.map(key));
  const why = U('curly quote: a comment here depends on the file encoding and PowerShell version', '굽은 따옴표: 파일 인코딩과 PowerShell 판에 따라 여기 주석 읽기가 달라짐');
  for (const x of c.out) if (!flat.has(key(x))) c.unsure(x.a, why);
  for (const x of plain.out) {
    if (curly.has(key(x))) continue;
    c.unsure(x.a, why);
    if (!c.out.some((y) => x.a < y.b && y.a < x.b)) c.out.push(x);
  }
}

// '#' and '<#' open a comment at the start of a token. Right after a bareword (a#b) they are part of the word.
// Right after a number, a variable, a closing bracket or a quote ($x = 1# c) the parser mode decides, so unsure.
function psCode(c, i, nested, limit = c.s.length) {
  const s = c.s; const { sq, dq } = c.psq; let depth = 0; let tokStart = i;
  const hashKind = (k) => {
    const tok = s.slice(tokStart, k);
    if (tok === '') return 'comment';
    if (/^[$\d]/.test(tok) || /[)\]]$/.test(tok) || sq.includes(tok.slice(-1)) || dq.includes(tok.slice(-1))) { c.unsure(k, U(`# right after token ${tok.slice(-20)} (comment or word, unclear)`, `토큰 ${tok.slice(-20)} 바로 뒤의 # (주석인지 낱말인지 모름)`)); return 'comment'; }
    return 'word';
  };
  while (i < limit) {
    const ch = s[i];
    if (ch === '`') {
      // A backtick before a line break continues the line; the next line starts a new token (`\n# c is a comment).
      const joins = s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n');
      i = skipEsc(s, i); if (joins) tokStart = i; continue;
    }
    if (ch === '<' && s[i + 1] === '#') {
      if (hashKind(i) === 'comment') {
        const k = s.indexOf('#>', i + 2);
        if (k < 0) c.unsure(i, U('unclosed block comment', '닫히지 않은 블록 주석'));
        const j = k < 0 ? s.length : k + 2; c.push('block', i, j); i = j; tokStart = i; continue;
      }
      i += 2; continue;
    }
    if (ch === '#') {
      if (hashKind(i) === 'comment') { const j = eol(s, i); c.push('line', i, j); i = j; tokStart = i; continue; }
      i++; continue;
    }
    if (/[\s;|&(){},]/.test(ch)) {
      if (ch === '(') depth++;
      else if (ch === ')') { if (nested && depth === 0) return i + 1; depth = Math.max(0, depth - 1); }
      i++; tokStart = i; continue;
    }
    if (ch === '$' && s[i + 1] === '{') {
      const k = s.indexOf('}', i + 2);
      if (k < 0) c.unsure(i, U('unclosed ${', '닫히지 않은 ${'));
      i = k < 0 ? s.length : k + 1; continue;
    }
    if (ch === '@' && i + 1 < s.length && (sq + dq).includes(s[i + 1]) && s.slice(i + 2, eol(s, i)).trim() === '') { i = psHereString(c, i); tokStart = i; continue; }
    if (sq.includes(ch)) { i = psSingle(c, i); continue; }
    if (dq.includes(ch)) { i = psDouble(c, i); continue; }
    i++;
  }
  if (nested) c.unsure(i, U('unclosed $( substitution', '닫히지 않은 $( 치환식'));
  return i;
}

// Any quote of the same kind closes the string, and two in a row are one escaped quote ('a’'b' is one string).
function psSingle(c, i) {
  const s = c.s, n = s.length, { sq } = c.psq; let j = i + 1;
  while (j < n) { if (sq.includes(s[j])) { if (j + 1 < n && sq.includes(s[j + 1])) { j += 2; continue; } return j + 1; } j++; }
  c.unsure(i, U('unclosed string', '닫히지 않은 문자열')); return n;
}

function psDouble(c, i) {
  const s = c.s, n = s.length, { dq } = c.psq; let j = i + 1;
  while (j < n) {
    const ch = s[j];
    if (ch === '`') { j = skipEsc(s, j); continue; }
    if (dq.includes(ch)) { if (j + 1 < n && dq.includes(s[j + 1])) { j += 2; continue; } return j + 1; }
    if (ch === '$' && s[j + 1] === '(') { c.strDepth++; j = psCode(c, j + 2, true); c.strDepth--; continue; }
    j++;
  }
  c.unsure(i, U('unclosed string', '닫히지 않은 문자열')); return n;
}

// The closing '@ or "@ (any quote of the opening kind) must start a line (no indent). Without one the body is read as code and the file is unsure.
function psHereString(c, i) {
  const s = c.s; const q = s[i + 1]; const expand = c.psq.dq.includes(q);
  const re = new RegExp('\\n[' + (expand ? c.psq.dq : c.psq.sq) + ']@', 'g'); re.lastIndex = i;
  const m = re.exec(s);
  if (!m) { c.unsure(i, U(`here-string with no closing ${q}@ line`, `닫는 ${q}@ 줄이 없는 here-string`)); return eol(s, i); }
  if (expand) {
    let k = s.indexOf('$(', i + 2);
    while (k >= 0 && k < m.index) {
      if (s[k - 1] === '`') { k = s.indexOf('$(', k + 2); continue; }
      c.strDepth++; k = psCode(c, k + 2, true, m.index); c.strDepth--;
      k = s.indexOf('$(', k);
    }
  }
  return m.index + m[0].length;
}

// ---- sh ----
// '#' opens a comment at the start of a word: after unescaped blank or an operator, not after x\ or ${a}.
function scanSh(c) {
  shCode(c, 0, false);
  for (const h of c.heredocs) c.unsure(h.at, U(`no body after heredoc marker ${h.marker}`, `heredoc 표지 ${h.marker} 뒤에 본문이 없음`));
}

// A '(' inside a word ($(, @(, x=() keeps the word going after its ')', so $(a)#x is one word. After an
// operator ')' (subshell, [[ =~ (a|b)#x ]]) a '#' with no blank before it is unsure: bash reads a comment
// after a subshell but not inside a [[ =~ regex.
function shCode(c, i, nested) {
  const s = c.s, n = s.length; const parens = []; let atTok = true;
  while (i < n) {
    const ch = s[i];
    if (ch === '\n') {
      i = c.heredocs.length ? shHeredocBodies(c, i + 1) : i + 1; atTok = true; continue;
    }
    if (ch === '\\') {
      const joinsLine = s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n');
      i = skipEsc(s, i); if (!joinsLine) atTok = false; continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; atTok = true; continue; }
    if (ch === '#') {
      if (atTok) { const j = eol(s, i); c.push('line', i, j); i = j; continue; }
      i++; continue;
    }
    if (ch === '$' && s[i + 1] === '(' && s[i + 2] === '(') { i = shArith(c, i, i + 3); atTok = false; continue; }
    if (ch === '(' && s[i + 1] === '(' && atTok) { i = shArith(c, i, i + 2); atTok = false; continue; }
    if (ch === '$' && s[i + 1] === '{') { i = shBraced(c, i); atTok = false; continue; }
    if (ch === '$' && s[i + 1] === "'") { i = shAnsiC(c, i + 1); atTok = false; continue; }
    if (ch === '<' && s[i + 1] === '<') {
      if (s[i + 2] === '<') { i += 3; atTok = true; continue; }
      i = shHeredocStart(c, i); atTok = true; continue;
    }
    if (ch === "'") {
      const k = s.indexOf("'", i + 1);
      if (k < 0) { c.unsure(i, U('unclosed string', '닫히지 않은 문자열')); i = n; } else i = k + 1;
      atTok = false; continue;
    }
    if (ch === '"') { i = shDouble(c, i); atTok = false; continue; }
    if (ch === '`') { i = shBacktick(c, i); atTok = false; continue; }
    if (ch === '(') { parens.push(!atTok); i++; atTok = true; continue; }
    if (ch === ')') {
      if (nested && parens.length === 0) return i + 1;
      const inWord = parens.pop(); i++; atTok = !inWord;
      if (atTok && s[i] === '#') c.unsure(i, U('# right after ) (comment or word, unclear)', ') 바로 뒤의 # (주석인지 낱말인지 모름)'));
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>') { i++; atTok = true; continue; }
    i++; atTok = false;
  }
  if (nested) c.unsure(i, U('unclosed $( substitution', '닫히지 않은 $( 치환식'));
  return n;
}

// $(( ... )) or (( ... )): arithmetic, where '<<' is a shift and '#' is a base (16#ff), never a comment.
function shArith(c, at, j) {
  const s = c.s; let d = 0;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '(') d++;
    else if (ch === ')') {
      if (d === 0) {
        if (s[j + 1] === ')') return j + 2;
        c.unsure(at, U('(( arithmetic not closed by ))', '(( 산술식이 ))로 끝나지 않음')); return j + 1;
      }
      d--;
    }
    j++;
  }
  c.unsure(at, U('unclosed (( arithmetic', '닫히지 않은 (( 산술식')); return s.length;
}

function shBraced(c, i) {
  const k = c.s.indexOf('}', i + 2);
  if (k < 0) { c.unsure(i, U('unclosed ${', '닫히지 않은 ${')); return c.s.length; }
  return k + 1;
}

function shAnsiC(c, i) {
  const s = c.s; let j = i + 1;
  while (j < s.length) { if (s[j] === '\\') { j = skipEsc(s, j); continue; } if (s[j] === "'") return j + 1; j++; }
  c.unsure(i, U('unclosed string', '닫히지 않은 문자열')); return s.length;
}

function shBacktick(c, i) {
  const s = c.s; let j = i + 1;
  while (j < s.length) { if (s[j] === '\\') { j = skipEsc(s, j); continue; } if (s[j] === '`') return j + 1; j++; }
  c.unsure(i, U('unclosed ` substitution', '닫히지 않은 ` 치환')); return s.length;
}

function shDouble(c, i) {
  const s = c.s, n = s.length; let j = i + 1;
  while (j < n) {
    const ch = s[j];
    if (ch === '\\') { j = skipEsc(s, j); continue; }
    if (ch === '"') return j + 1;
    if (ch === '$' && s[j + 1] === '(' && s[j + 2] === '(') { j = shArith(c, j, j + 3); continue; }
    if (ch === '$' && s[j + 1] === '(') { c.strDepth++; j = shCode(c, j + 2, true); c.strDepth--; continue; }
    if (ch === '$' && s[j + 1] === '{') { j = shBraced(c, j); continue; }
    if (ch === '`') { j = shBacktick(c, j); continue; }
    j++;
  }
  c.unsure(i, U('unclosed string', '닫히지 않은 문자열')); return n;
}

// The delimiter is one shell word with its quotes removed (END-TEXT, 'EOF', "EOF", \EOF).
function shHeredocStart(c, i) {
  const s = c.s, n = s.length; let j = i + 2;
  const strip = s[j] === '-'; if (strip) j++;
  while (s[j] === ' ' || s[j] === '\t') j++;
  let marker = '';
  while (j < n && !/[\s;|&<>()]/.test(s[j])) {
    const ch = s[j];
    if (ch === "'" || ch === '"') {
      const k = s.indexOf(ch, j + 1);
      if (k < 0 || s.slice(j + 1, k).includes('\n')) { c.unsure(i, U('unclosed quote in heredoc marker', 'heredoc 표지의 따옴표가 닫히지 않음')); return j + 1; }
      marker += s.slice(j + 1, k); j = k + 1; continue;
    }
    if (ch === '\\') { marker += s[j + 1] || ''; j += 2; continue; }
    marker += ch; j++;
  }
  if (!marker) { c.unsure(i, U('no heredoc marker found after <<', '<< 뒤에서 heredoc 표지를 찾지 못함')); return j; }
  c.heredocs.push({ strip, marker, at: i });
  return j;
}

// Skips the pending heredoc bodies that start at j. A body whose delimiter line never comes is unsure,
// and reading resumes at that body's first line as code, so later comments are still seen.
function shHeredocBodies(c, j) {
  const s = c.s, n = s.length;
  for (const h of c.heredocs) {
    const bodyStart = j; let found = false;
    while (j < n) {
      const e = eol(s, j); let line = s.slice(j, e).replace(/\r$/, '');
      if (h.strip) line = line.replace(/^\t+/, '');
      j = e + 1;
      if (line === h.marker) { found = true; break; }
    }
    if (!found) { c.unsure(h.at, U(`end line of heredoc marker ${h.marker} not found`, `heredoc 표지 ${h.marker}의 끝 줄을 찾지 못함`)); c.heredocs.length = 0; return bodyStart; }
  }
  c.heredocs.length = 0; return Math.min(j, n);
}

function lineStarts(s) { const a = [0]; for (let i = 0; i < s.length; i++) if (s[i] === '\n') a.push(i + 1); return a; }
function lineOf(starts, idx) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

// Turn raw spans into comment blocks: consecutive full-line line comments join one block;
// a block comment or docstring is one block; a trailing comment after code is a block of its own.
// Returns the blocks and the unsure spots {line, reason}.
function analyze(s, lang) {
  const c = makeCtx(s);
  if (lang === 'py') scanPy(c);
  else if (lang === 'js') scanJs(c);
  else if (lang === 'css') scanCss(c);
  else if (lang === 'ps') scanPs(c);
  else scanSh(c);
  const starts = lineStarts(s); const blocks = [];
  const spans = c.out.sort((x, y) => x.a - y.a);
  spans.forEach((sp) => {
    const line = lineOf(starts, sp.a);
    const fullLine = s.slice(starts[line - 1], sp.a).trim() === '';
    const texts = s.slice(sp.a, sp.b).split('\n').map((t) => t.replace(/\r$/, ''));
    const lines = texts.map((t, k) => ({ no: line + k, text: t }));
    const prev = blocks[blocks.length - 1];
    if (sp.kind === 'line' && fullLine && prev && prev.kind === 'line' && prev.fullLine &&
        prev.lines[prev.lines.length - 1].no === line - 1) {
      prev.lines.push(...lines);
    } else {
      blocks.push({ kind: sp.kind, fullLine, lines });
    }
  });
  const unsure = []; const seen = new Set();
  for (const m of c.marks) {
    const line = lineOf(starts, Math.min(m.at, s.length)); const key = `${line}\u0000${m.reason.en}`;
    if (!seen.has(key)) { seen.add(key); unsure.push({ line, reason: m.reason }); }
  }
  unsure.sort((x, y) => x.line - y.line);
  // The source with every comment span cut out, so a rule can ask whether a value is used in code.
  let code = ''; let at = 0;
  for (const sp of c.out) { if (sp.a > at) code += s.slice(at, sp.a) + ' '; at = Math.max(at, sp.b); }
  code += s.slice(at);
  return { blocks, unsure, code };
}

function commentBlocks(s, lang) { return analyze(s, lang).blocks; }

function stripDelims(t) {
  return t.replace(/^\s*(<#|#+|\/\/+|\/\*+|\*+(?!\/)|[rRbBfFuU]{0,2}("""|'''))?/, '')
    .replace(/(\*\/|#>|"""|''')\s*$/, '').trim();
}

// ---------- rules ----------
// Where each rule is described (the README rules table).
const RULE_REF = {
  defer: 'README rules: defer-no-basis',
  deadline: 'README rules: deadline-passed',
  weak: 'README rules: defer-word',
  workaround: 'README rules: workaround',
  history: 'README rules: history-block',
};

const TAG_RE = /(?<![A-Za-z0-9_])(TODO|FIXME|HACK|XXX)(?![A-Za-z0-9_])/g;
const STRONG_PHRASES = [
  { name: () => 'temporary fix', re: /(?<![A-Za-z])temporary fix(?![A-Za-z])/gi },
  { name: () => '임시 처리', re: /임시 ?처리/g },
  { name: (m) => m[0], re: /나중에 ?고(?:친다|침|치기|칠)/g },
];
// The bare word is far too common ("retry later", "3.8 or later", "later than", "a later stage"). It counts only when
// a work verb comes before it in the same sentence (fix it, handle, revisit, clean up, support ...) and a clause ends
// on it (end of line, ',', '.', ';', ':', '!', '?', ')') or a deferral continuation follows (when, once, if, maybe,
// too, again). It never counts after 'or', 'and' or 'fix' (the last one belongs to FIX_LATER).
const LATER_VERBS = 'fix|handle|revisit|address|implement|improve|refactor|clean ?up|tidy|polish|optimi[sz]e|add|remove|' +
  'support|do|finish|complete|rewrite|redo|write|test|document|simplify|split|replace|resolve|solve|tackle|cover|' +
  'look (?:at|into)|deal with|think about|come back|circle back|sort (?:it |this |that )?out|figure (?:it |this |that )?out';
const LATER = new RegExp('(?<![A-Za-z0-9_])(?:' + LATER_VERBS + ')(?![A-Za-z0-9_])[^.;:!?]{0,40}?' +
  '(?<![A-Za-z0-9_])(?<!\\b(?:or|and|fix)\\s+)later(?![A-Za-z0-9_])' +
  '(?=\\s*$|\\s*[.,;:!?)\\]]|\\s+(?:when|once|if|maybe|too|again)(?![A-Za-z0-9_]))', 'gi');
// The two-word form followed by a noun names a version or a position (fix + later versions), not a deferral.
const FIX_LATER = /(?<![A-Za-z0-9_])fix\s+later(?![A-Za-z0-9_])(?!\s+(?:than|versions?|releases?|stages?|steps?|entr(?:y|ies)|ones?|in|on)(?![A-Za-z0-9_]))/gi;
// A weak word may carry ok(clean, match): the extra test that keeps look-alikes out.
const WEAK = [
  { name: () => 'for now', re: /(?<![A-Za-z])for now(?![A-Za-z])/gi },
  { name: () => 'temporarily', re: /(?<![A-Za-z0-9_])temporarily(?![A-Za-z0-9_])/gi },
  { name: () => 'fix later', re: FIX_LATER },
  { name: () => 'later', re: LATER },
  { name: () => 'todo', re: /(?<![A-Za-z0-9_])[Tt]odo(?![A-Za-z0-9_])/g, ok: isLowerTodoHit },
  { name: () => '임시로', re: /임시로/g },
  { name: () => '일단', re: /(?<![가-힣])일단(?![락위])/g },
  { name: () => '추후', re: /추후/g },
  { name: () => '당분간', re: /당분간/g },
];
// Inside an identifier (letters, digits or '_' on either side, e.g. enable_workaround_flag) is a name, not the word.
const WORKAROUND = /(?<![A-Za-z0-9_])work[- ]?arounds?(?![A-Za-z0-9_])/gi;

// Lowercase 'todo' and capitalised 'Todo' are ordinary words (a todo list, todo.md), so they count only in tag form
// ('todo:', 'todo(', 'todo!'; the same with 'Todo') as the first word of the comment or after a sentence end, and never as a name or the todo!() macro.
function isLowerTodoHit(clean, m) {
  const before = clean.slice(0, m.index); const after = clean.slice(m.index + m[0].length);
  if (/["'`「『“‘/.@-]$/.test(before)) return false;
  if (!/^\s*[:(!]/.test(after) || /^!\s*\(/.test(after)) return false;
  return before.trim() === '' || /[.;:!?。]\s+$/.test(before);
}

// Every finding is for a person to review: the tool only finds candidates. A tag is
// reported wherever it appears, with one exception: the three-X tag is also a placeholder (file_XXX.png), so it
// counts only as the bare first word of the comment, or after a sentence end as a tag form (the tag, then ':',
// '(' or '!'), and never as a name (a file name, a quoted tag).
function isTagHit(clean, m) {
  const name = m[1];
  if (name !== 'XXX') return true;
  const before = clean.slice(0, m.index); const after = clean.slice(m.index + name.length);
  const nameLike = /["'`「『“‘/.-]$/.test(before) || /^(?:[./-][A-Za-z0-9]|["'`」』”’])/.test(after);
  if (nameLike) return false;
  return before.trim() === '' || (/^\s*[:(!]/.test(after) && /[.;:!?。]\s+$/.test(before));
}

// A URL needs a host after the scheme: the bare text "https://" is a value the code checks, not a link.
const BASIS_URL = /https?:\/\/[A-Za-z0-9][^\s"'`<>)\]]*/;
// Item IDs like ABC-12 or PROJ-20240101-SAMPLE-ITEM (the whole ID is the basis). Technical names with the
// same shape (UTF-16, SHA-256, ISO-8601) are not items.
const ITEM_ID_G = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]+)-\d{2,}(?:-[A-Z0-9]+)*(?![A-Za-z0-9])/g;
const NOT_ITEM_PREFIX = new Set(['UTF', 'UCS', 'SHA', 'ISO', 'IEC', 'IEEE', 'HTTP', 'HTTPS', 'MD', 'AES', 'RSA',
  'CRC', 'MP', 'ECMA', 'CP', 'BT', 'X86', 'TLS', 'SSL', 'USB', 'PCI', 'DDR']);
const HASH_REF_G = /(?:^|[\s(\[`'"])(#(\d+))(?![\w])|(?<![\w.-])([\w.-]+#\d+)(?![\w])/g;
// Dates in the README forms only (one separator, two-digit month and day), and only real ones.
const DATE_G = /(?<!\d)(\d{4})([-./])(\d{2})\2(\d{2})(?!\d)/g;
// 'before' and 전에 also mark a range of data (rows before 2024-01-01); a past date next to them is still reported.
const DEADLINE_AFTER = /^\s*(?:까지|전까지|기한|마감)/;
const DEADLINE_BEFORE = /(?:(?<![A-Za-z0-9_])(?:until|by|deadline|due)|기한|마감)\s*[:：]?\s*$/i;
const RANGE_AFTER = /^\s*전에/;
const RANGE_BEFORE = /(?<![A-Za-z0-9_])before\s*[:：]?\s*$/i;

// English event words count as whole words. Not events: 'fixed-size' and 'fixed width' style compounds, and the
// state wording of 'changed' right after has, have, had, is, are, be, not, if, whether, when, until, once, ever, never.
const HISTORY_MARKERS = new RegExp('(?<!\\d)\\d{4}-\\d{2}-\\d{2}(?!\\d)|정정|종전|라운드|옛 ?판|' +
  '(?<![A-Za-z0-9_-])(?:(?<!\\b(?:has|have|had|is|are|be|not|if|whether|when|until|once|ever|never)\\s+)changed|reverted|fixed(?!\\s+(?:size|width|height|length|point|rate|number|string|set|amount|order|schema|window|delay|interval|offset)(?![A-Za-z0-9_])))(?![A-Za-z0-9_-])', 'gi');

function matchAll(re, text) { re.lastIndex = 0; const r = []; let m; while ((m = re.exec(text))) { r.push(m); if (m[0] === '') re.lastIndex++; } return r; }

function realDate(y, mo, d) {
  const Y = Number(y), M = Number(mo), D = Number(d);
  if (M < 1 || M > 12 || D < 1) return false;
  const leap = (Y % 4 === 0 && Y % 100 !== 0) || Y % 400 === 0;
  return D <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][M - 1];
}

// The basis window for a marker is its paragraph: the block lines between empty comment lines.
function paragraphOf(block, idx) {
  const L = block.lines; let a = idx, b = idx;
  while (a > 0 && stripDelims(L[a - 1].text) !== '') a--;
  while (b < L.length - 1 && stripDelims(L[b + 1].text) !== '') b++;
  return L.slice(a, b + 1).map((x) => x.text).join('\n');
}

// Returns what counts as the basis in the paragraph, or null. A #333-shaped ref is a color in CSS, and in any
// language when the same value is quoted in the file's code ("#333").
function basisOf(para, lang, date, code = '') {
  const u = BASIS_URL.exec(para); if (u) { const url = u[0].slice(0, 80); return U(`URL ${url}`, `URL ${url}`); }
  for (const m of matchAll(ITEM_ID_G, para)) if (!NOT_ITEM_PREFIX.has(m[1])) return U(`item ID ${m[0]}`, `항목 ID ${m[0]}`);
  for (const m of matchAll(HASH_REF_G, para)) {
    if (m[1] && [3, 4, 6, 8].includes(m[2].length) &&
        (lang === 'css' || code.includes(`"${m[1]}"`) || code.includes(`'${m[1]}'`))) continue;
    const id = m[1] || m[3]; return U(`item ID ${id}`, `항목 ID ${id}`);
  }
  return date ? U(`date ${date}`, `날짜 ${date}`) : null;
}

function firstRealDate(text) {
  for (const m of matchAll(DATE_G, text)) if (realDate(m[1], m[3], m[4])) return m[0];
  return null;
}

// The ignore marker: written inside a comment, it removes every finding of that comment block (the consecutive
// comment lines that make one block; a single-line comment is its own block). Text after the marker is free
// (a reason). The comment scanners decide what is a comment, so the same words inside a string are no marker.
// The dropped findings are counted in stats.ignored and shown in the summary (README). The rules never read the
// reason, so an item ID, a tag or a date written there changes no count.
const IGNORE_MARK = /(?<![A-Za-z0-9_-])comment-lint\s*:\s*ignore(?![A-Za-z0-9_-])/i;

function checkBlock(block, today, emitAll, stats, lang = 'py', code = '') {
  if (!stats.exempt) stats.exempt = [];
  const marked = block.lines.some((ln) => IGNORE_MARK.test(ln.text));
  const emit = marked ? () => { stats.ignored = (stats.ignored || 0) + 1; } : emitAll;
  if (marked) {
    const cut = (t) => { const m = IGNORE_MARK.exec(t); return m ? t.slice(0, m.index + m[0].length) : t; };
    block = { ...block, lines: block.lines.map((ln) => ({ ...ln, text: cut(ln.text) })) };
  }
  block.lines.forEach((ln, idx) => {
    const clean = stripDelims(ln.text);
    if (!clean) return;
    const tags = new Set(); const weak = new Set();
    for (const m of matchAll(TAG_RE, clean)) if (isTagHit(clean, m)) tags.add(m[1]);
    for (const r of STRONG_PHRASES) for (const m of matchAll(r.re, clean)) tags.add(r.name(m));
    for (const r of WEAK) for (const m of matchAll(r.re, clean)) if (!r.ok || r.ok(clean, m)) weak.add(r.name(m));
    const wa = matchAll(WORKAROUND, clean).length > 0;
    if (!tags.size && !weak.size && !wa) return;
    // A deadline belongs to its own line: a date on a neighbouring line never makes this line's deadline.
    let passed = null;
    for (const m of matchAll(DATE_G, clean)) {
      if (!realDate(m[1], m[3], m[4])) continue;
      const v = Number(m[1] + m[3] + m[4]);
      if (v >= today) continue;
      const after = clean.slice(m.index + m[0].length, m.index + m[0].length + 12);
      const before = clean.slice(Math.max(0, m.index - 14), m.index);
      if (DEADLINE_AFTER.test(after) || DEADLINE_BEFORE.test(before) || RANGE_AFTER.test(after) || RANGE_BEFORE.test(before)) {
        passed = m[0]; break;
      }
    }
    const markers = [...tags, ...weak];
    if (passed) {
      const mk = markers.join(', ') || 'workaround';
      emit(ln.no, 'deadline-passed', U(`deadline ${passed} of a deferring comment has passed (${mk})`, `미루는 주석의 기한 ${passed}이 지났다(${mk})`), RULE_REF.deadline, ln.text);
      return;
    }
    const basis = basisOf(paragraphOf(block, idx), lang, firstRealDate(clean) || firstRealDate(paragraphOf(block, idx)), code);
    if (basis) { stats.exemptByBasis++; stats.exempt.push({ line: ln.no, basis }); return; }
    if (tags.size) { const tg = [...tags].join(', '); emit(ln.no, 'defer-no-basis', U(`deferral tag (${tg}) with no basis (URL, item ID, date)`, `미루는 주석의 표지(${tg})가 있고 근거(URL, 항목 ID, 날짜)가 없다`), RULE_REF.defer, ln.text); }
    else if (weak.size) { const wk = [...weak].join(', '); emit(ln.no, 'defer-word', U(`word that may mean a deferral (${wk}), no basis`, `미루는 뜻일 수 있는 낱말(${wk}), 근거 없음`), RULE_REF.weak, ln.text); }
    if (wa) emit(ln.no, 'workaround', U('workaround: check whether it is a temporary bypass or a "why" comment worth keeping (an outside trap)', 'workaround: 임시 우회인지, 지킬 「왜」 주석(외부 함정)인지 확인'), RULE_REF.workaround, ln.text);
  });
  if (block.lines.length >= 9) {
    // Markers on the same line describe one event, so a line counts once.
    const hitLines = block.lines.filter((ln) => matchAll(HISTORY_MARKERS, ln.text).length > 0);
    if (hitLines.length >= 3) {
      const first = block.lines[0].no; const lastNo = block.lines[block.lines.length - 1].no;
      const found = [...new Set(hitLines.flatMap((ln) => matchAll(HISTORY_MARKERS, ln.text).map((m) => m[0])))];
      const fs6 = found.slice(0, 6).join(', ');
      emit(first, 'history-block', U(`comment block lines ${first}-${lastNo} (${block.lines.length} lines) has history markers on ${hitLines.length} lines: ${fs6}`, `주석 블록 ${first}-${lastNo}행(${block.lines.length}줄)에 경위 표지가 ${hitLines.length}줄: ${fs6}`), RULE_REF.history, block.lines[0].text);
    }
  }
}

// ---------- files, globs, CLI ----------
function globToRegex(g) {
  // Code points, so '?' matches one character even outside the BMP.
  const p = [...g.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')];
  let r = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { r += '(?:.*/)?'; i += 2; } else { r += '.*'; i += 1; }
    } else if (c === '*') r += '[^/]*';
    else if (c === '?') r += '[^/]';
    else r += c.replace(/[.+^${}()|[\]]/g, '\\$&');
  }
  return new RegExp('^' + r + '$', 'iu');
}

function isExcluded(rel, regs) {
  const parts = rel.split('/');
  for (let k = 1; k <= parts.length; k++) {
    const pre = parts.slice(0, k).join('/');
    if (regs.some((re) => re.test(pre))) return true;
  }
  return false;
}

function normRel(p) { return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''); }

function codeError(code) { const e = new Error(code); e.code = code; return e; }

// Known encodings only: UTF-8 (BOM optional), UTF-16 LE or BE with BOM. UTF-32 and text with NUL are read failures.
function decode(buf) {
  if (buf.length >= 4 && ((buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0) ||
      (buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff))) throw codeError('UNSUPPORTED_UTF32');
  let s;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    try { s = new TextDecoder('utf-16le', { fatal: true }).decode(buf.subarray(2)); } catch { throw codeError('INVALID_UTF16'); }
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    try { s = new TextDecoder('utf-16be', { fatal: true }).decode(buf.subarray(2)); } catch { throw codeError('INVALID_UTF16'); }
  } else {
    try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw codeError('INVALID_UTF8'); }
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  }
  if (s.includes('\u0000')) throw codeError('NUL_IN_TEXT');
  return s;
}

function usage() {
  return [
    'usage: node comment_lint.mjs <file|folder>... [--exclude <glob>]... [--exclude-from <list>]',
    '                             [--deps <list>] [--json] [--today YYYY-MM-DD] [--lang en|ko]',
    'Output language: en (default) or ko; --lang wins over the COMMENT_LINT_LANG environment variable.',
    'Report-only. Never writes files. Exit 0 done, 2 argument/path error or no file read, 3 some files unreadable.',
  ].join('\n');
}

function parseArgs(argv) {
  const o = { inputs: [], exclude: [], excludeFrom: [], deps: null, json: false, today: null, lang: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--exclude') o.exclude.push(need());
    else if (a === '--exclude-from') o.excludeFrom.push(need());
    else if (a === '--deps') o.deps = need();
    else if (a === '--json') o.json = true;
    else if (a === '--lang') {
      const v = need().toLowerCase();
      if (!LANGS.includes(v)) throw new Error('--lang must be en or ko');
      o.lang = v;
    }
    else if (a === '--today') {
      o.today = need(); const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.today);
      if (!m || !realDate(m[1], m[2], m[3])) throw new Error('--today must be a real date YYYY-MM-DD');
    }
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.inputs.push(a);
  }
  return o;
}

// A list file must be a readable file in a source encoding (decode); anything else is an argument error (exit 2).
function readList(file, what) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { error: e.code === 'ENOENT' ? `${what} not found: ${file}` : `${what} unreadable: ${file} (${e.code || e.message})` }; }
  if (!st.isFile()) return { error: `${what} is not a file: ${file}` };
  try {
    return { lines: decode(fs.readFileSync(file)).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) };
  } catch (e) { return { error: `${what} unreadable: ${file} (${e.code || e.message})` }; }
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`ARG_ERROR ${e.message}\n${usage()}\n`); return 2; }
  if (o.help) { process.stdout.write(usage() + '\n'); return 0; }
  if (!o.inputs.length) { process.stderr.write(`ARG_ERROR no input\n${usage()}\n`); return 2; }
  // --lang wins over COMMENT_LINT_LANG; a locale-style value (ko_KR.UTF-8) is read by its language part.
  let lang = o.lang;
  if (!lang) {
    const ev = (process.env.COMMENT_LINT_LANG || '').trim();
    if (ev) {
      const m = /^(en|ko)(?:[-_.].*)?$/i.exec(ev);
      if (!m) { process.stderr.write(`ARG_ERROR COMMENT_LINT_LANG must be en or ko, got "${ev}"\n`); return 2; }
      lang = m[1].toLowerCase();
    } else lang = 'en';
  }
  const en = lang === 'en';
  const globs = [...o.exclude];
  for (const f of o.excludeFrom) {
    const r = readList(f, 'exclude list');
    if (r.error) { process.stderr.write(`ARG_ERROR ${r.error}\n`); return 2; }
    globs.push(...r.lines);
  }
  let deps = null;
  if (o.deps !== null) {
    const r = readList(o.deps, 'deps list');
    if (r.error) { process.stderr.write(`ARG_ERROR ${r.error}\n`); return 2; }
    deps = r.lines;
  }
  const regs = globs.map(globToRegex);
  const now = new Date();
  const today = o.today ? Number(o.today.replace(/-/g, '')) : now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();

  const files = []; const skipped = {}; const excluded = { dirs: 0, files: 0, defaultDirs: 0 };
  const readErrors = []; const seen = new Set();
  const fileKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  for (const inp of o.inputs) {
    const abs = path.resolve(inp);
    let top;
    try { top = fs.lstatSync(abs); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { process.stderr.write(`PATH_ERROR not found: ${inp}\n`); return 2; }
      readErrors.push({ path: abs, reason: e.code || e.message }); continue;
    }
    // An input inside a default-excluded folder (or that folder itself) is excluded like one met while walking.
    if (abs.split(/[\\/]/).some((part) => DEFAULT_EXCLUDE_DIRS.includes(part.toLowerCase()))) { excluded.defaultDirs++; continue; }
    const root = top.isDirectory() ? abs : path.dirname(abs);
    const visit = (p, known) => {
      const rel = normRel(path.relative(root, p));
      let ls = known;
      if (!ls) { try { ls = fs.lstatSync(p); } catch (e) { readErrors.push({ path: p, reason: e.code || e.message }); return; } }
      if (ls.isSymbolicLink()) { skipped['(symlink)'] = (skipped['(symlink)'] || 0) + 1; return; }
      if (ls.isDirectory()) {
        if (rel && DEFAULT_EXCLUDE_DIRS.includes(path.basename(p).toLowerCase())) { excluded.defaultDirs++; return; }
        if (rel && isExcluded(rel, regs)) { excluded.dirs++; return; }
        let entries;
        try { entries = fs.readdirSync(p).sort(); } catch (e) { readErrors.push({ path: p, reason: e.code || e.message }); return; }
        for (const e of entries) visit(path.join(p, e));
        return;
      }
      if (isExcluded(rel, regs)) { excluded.files++; return; }
      const ext = path.extname(p).toLowerCase();
      if (!EXT_LANG[ext]) { const k = ext || '(no ext)'; skipped[k] = (skipped[k] || 0) + 1; return; }
      if (seen.has(fileKey(p))) return;
      seen.add(fileKey(p));
      files.push({ abs: p, rel, root, lang: EXT_LANG[ext] });
    };
    visit(abs, top);
  }

  const findings = []; const readUncertain = []; const exempt = []; let uncertainFiles = 0;
  const stats = { exemptByBasis: 0, exempt: [], ignored: 0 }; let read = 0;
  for (const f of files) {
    let s;
    try { s = decode(fs.readFileSync(f.abs)); } catch (e) { readErrors.push({ path: f.abs, reason: e.code || e.message }); continue; }
    read++;
    // The confidence field stays in the output for outside readers; it is always 'review' (README).
    const emit = (line, rule, message, ref, text) => findings.push({
      path: f.abs, rel: f.rel, line, confidence: 'review', rule, message: pick(message, lang), ref, excerpt: text.trim().slice(0, 120),
    });
    const { blocks, unsure, code: codeText } = analyze(s, f.lang);
    const start = findings.length;
    stats.exempt = [];
    for (const b of blocks) checkBlock(b, today, emit, stats, f.lang, codeText);
    for (const x of stats.exempt) exempt.push({ path: f.abs, rel: f.rel, line: x.line, basis: pick(x.basis, lang) });
    if (unsure.length) {
      uncertainFiles++;
      for (let k = start; k < findings.length; k++) {
        const x = findings[k];
        x.uncertainRead = true; x.message += en ? ' (file read with uncertainty)' : ' (읽기 불확실 파일)';
      }
      for (const u of unsure) readUncertain.push({ path: f.abs, rel: f.rel, line: u.line, reason: pick(u.reason, lang) });
    }
  }
  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));

  let depsInfo = en ? 'deps not given' : 'deps 미지정'; let depsMissing = [];
  if (deps) {
    const readSet = new Set(files.filter((f) => !readErrors.some((r) => r.path === f.abs))
      .flatMap((f) => [f.rel.toLowerCase(), normRel(f.abs).toLowerCase()]));
    depsMissing = deps.filter((d) => !readSet.has(normRel(d).toLowerCase()));
    const matched = deps.length - depsMissing.length;
    depsInfo = en ? `deps ${matched} of ${deps.length} matched` : `deps ${deps.length}개 중 ${matched}개 일치`;
  }
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  const skippedText = Object.entries(skipped).sort().map(([k, v]) => `${k} ${v}`).join(', ');
  const sp = en ? ' ' : '';
  const firstPerFile = [];
  for (const u of readUncertain) if (!firstPerFile.some((x) => x.path === u.path)) firstPerFile.push(u);
  const moreFiles = firstPerFile.length - 5;
  const uncertainText = firstPerFile.length
    ? `${sp}(${firstPerFile.slice(0, 5).map((u) => `${u.rel}:${u.line} ${u.reason}`).join('; ')}${moreFiles > 0 ? (en ? `; ${moreFiles} more files` : `; 외 ${moreFiles}개 파일`) : ''})`
    : '';
  const skippedPart = skippedText ? `${sp}(${skippedText})` : '';
  const excludedDirs = excluded.dirs + excluded.defaultDirs;
  const summary = en
    ? `COMMENT_LINT_SUMMARY files read ${read}, files skipped ${skippedTotal}${skippedPart}, ` +
      `excluded folders ${excludedDirs} (default ${excluded.defaultDirs}) and files ${excluded.files}, ${depsInfo}, ` +
      `findings ${findings.length}, ignored ${stats.ignored}, deferrals skipped for a basis ${stats.exemptByBasis}, read errors ${readErrors.length}, ` +
      `read uncertain ${uncertainFiles}${uncertainText}`
    : `COMMENT_LINT_SUMMARY 읽은 파일 ${read}, 건너뛴 파일 ${skippedTotal}${skippedPart}, ` +
      `제외 폴더 ${excludedDirs}(기본 ${excluded.defaultDirs}) 파일 ${excluded.files}, ${depsInfo}, ` +
      `발견 ${findings.length}, 무시 ${stats.ignored}, 근거 있어 넘긴 미루는 주석 ${stats.exemptByBasis}, 읽기 실패 ${readErrors.length}, ` +
      `읽기 불확실 ${uncertainFiles}${uncertainText}`;
  const code = read === 0 ? 2 : readErrors.length ? 3 : 0;

  if (o.json) {
    process.stdout.write(JSON.stringify({
      findings, readErrors, readUncertain, exempt, depsMissing,
      summary: { read, skipped, excluded, deps: deps ? { total: deps.length, matched: deps.length - depsMissing.length } : null,
        certain: 0, review: findings.length, exemptByBasis: stats.exemptByBasis, ignored: stats.ignored, uncertain: uncertainFiles, exitCode: code, text: summary },
    }, null, 2) + '\n');
  } else {
    for (const x of findings) process.stdout.write(`${x.path}:${x.line}: ${en ? '[review]' : '[사람 확인]'} ${x.rule}: ${x.message} | ${en ? 'ref' : '근거'}: ${x.ref} | ${x.excerpt}\n`);
    for (const r of readErrors) process.stdout.write(`READ_ERROR ${r.path}: ${r.reason}\n`);
    for (const u of readUncertain) process.stdout.write(`READ_UNCERTAIN ${u.path}:${u.line}: ${u.reason}\n`);
    for (const d of depsMissing) process.stdout.write(`DEPS_MISSING ${d}\n`);
    process.stdout.write(summary + '\n');
  }
  if (read === 0) process.stderr.write('NO_FILES_READ\n');
  return code;
}

export { analyze, commentBlocks, checkBlock, globToRegex, isExcluded, stripDelims, main };

// Node runs the real path of the main module (links resolved), so both sides are compared as real paths: started
// through a link (a Windows junction, npm link, a global bin symlink) the plain paths differ and main() would not run.
const realOr = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
if (process.argv[1] && realOr(process.argv[1]) === realOr(fileURLToPath(import.meta.url))) {
  // A reader that closes the pipe early (| head) must not turn a finished run into a failure.
  process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
  process.exitCode = main(process.argv.slice(2));
}
