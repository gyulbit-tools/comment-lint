// Paired tests for comment_lint.mjs: every defect input must give its expected result, and its clean twin
// (a neighbouring input both the old and the new tool read right) must give its own expected result.
// Usage: node run_tests.mjs [--tool <path to comment_lint.mjs>]
// Fixtures are written to a fresh folder under the system temp folder and removed at the end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argTool = process.argv.indexOf('--tool');
const TOOL = argTool > 0 ? path.resolve(process.argv[argTool + 1]) : path.join(HERE, '..', 'comment_lint.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-lint-test-'));
delete process.env.COMMENT_LINT_LANG; // the in-process main() call below reads it too
let pass = 0, fail = 0, skip = 0;
const written = new Map();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The output language of a run: Korean unless the call says otherwise (the older tests read Korean text), and
// the environment variable is cleared so the machine running the tests cannot change a result.
// o.lang: 'ko' (default), 'en', or null for no --lang option at all; o.env adds environment variables.
function runRaw(args, o = {}) {
  const lang = o.lang === undefined ? 'ko' : o.lang;
  const env = { ...process.env }; delete env.COMMENT_LINT_LANG; Object.assign(env, o.env || {});
  const r = spawnSync(process.execPath, [TOOL, ...args, ...(lang ? ['--lang', lang] : [])], { encoding: 'utf8', env });
  let j = null; let parseError = null;
  try { j = JSON.parse(r.stdout); } catch (e) { parseError = e.message; }
  return { code: r.status, j, parseError, out: r.stdout, err: r.stderr };
}
// Every finding and summary of every JSON run is kept for the check that no finding has another grade than review.
const seenFindings = []; const seenSummaries = [];
function run(args, o = {}) {
  const r = runRaw([...args, '--json', '--today', '2026-11-18'], o);
  if (r.j) { seenFindings.push(...r.j.findings); seenSummaries.push({ n: r.j.findings.length, summary: r.j.summary }); }
  return r;
}
// The hash and modification time of every fixture are taken right after it is written; the read-only check
// compares them at the end and also looks for files the tests did not write (a rewrite with the same bytes
// changes the time, a new file is not in the list).
function write(rel, content) {
  const p = path.join(TMP, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content); written.set(p, { h: sha(fs.readFileSync(p)), t: fs.statSync(p).mtimeMs }); return p;
}
function filesUnder(dir) {
  const r = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) r.push(...filesUnder(p)); else r.push(p);
  }
  return r;
}
function check(name, ok, detail = '') {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`);
}
// A run that should print JSON but did not is a failure, never an empty result.
function rules(res) { return res.j ? res.j.findings.map((f) => `${f.line}:${f.confidence}:${f.rule}`) : ['JSON_PARSE_FAILED']; }
function unsure(res) { return res.j ? (res.j.readUncertain || []).length > 0 : null; }
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Each pair: defect input with its expected findings (line:confidence:rule) and whether the file is unsure,
// clean twin with its expected findings (default none) and unsure false.
const P = (name, ext, bad, want, good, goodWant = [], o = {}) => ({ name, ext, bad, want, good, goodWant, unc: !!o.unc });
const pairs = [
  P('py: # comment TODO vs # inside strings', '.py',
    'x = 1\n# TODO: remove this\n', ['2:review:defer-no-basis'],
    'a = "# TODO not a comment"\nb = \'http://x.example/#TODO\'\nc = "#fff"  # color value\n'),
  P('py: docstring TODO vs triple string passed as argument', '.py',
    'def f():\n    """Doc.\n    TODO handle empty input\n    """\n', ['3:review:defer-no-basis'],
    'print(\n    """\n    TODO text inside an argument\n    """)\nx = """TODO assigned"""\n'),
  P('py: past deadline vs future deadline', '.py',
    '# TODO: 2026-10-01까지\n', ['1:review:deadline-passed'],
    '# TODO: 2026-12-31까지\n'),
  P('py: weak words go to review, look-alikes do not', '.py',
    '# 일단 이렇게 둔다\n# for now skip audio\n', ['1:review:defer-word', '2:review:defer-word'],
    '# 일단락된 문제\n# 임시 폴더에 쓴다\n# formatted for nowhere\n'),
  P('py: workaround goes to review', '.py',
    '# workaround for ffmpeg 6 seek bug\n', ['1:review:workaround'],
    '# ffmpeg 6 seek 함정: -ss를 -i 앞에 둔다\n'),
  P('py: workaround as a word vs inside an identifier', '.py',
    '# workaround for X\n', ['1:review:workaround'],
    '# enable_workaround_flag is the old option name\n'),
  P('py: XXX after a sentence end vs without it or as a list bullet', '.py',
    '# note. XXX: c\n', ['1:review:defer-no-basis'],
    '# note XXX: d\n# - XXX: bullet\n'),
  P('py: XXX tag vs XXX placeholder', '.py',
    '# XXX: wrong on VFR\n', ['1:review:defer-no-basis'],
    '# output file_XXX.png and XXX.mp4 names\n'),
  P('js: // TODO vs // inside string, template, regex', '.js',
    'const a = 1; // TODO drop\n', ['1:review:defer-no-basis'],
    'const s = "// TODO no";\nconst t = `// TODO ${s} // TODO`;\nconst r = /\\/\\/ TODO/g;\nconst u = "http://x//TODO";\nconst d = 4 / 2; const e = d / 1;\n'),
  P('js: block comment TODO vs block markers in string', '.mjs',
    '/*\n * HACK keeps old order\n */\nexport const x = 1;\n', ['2:review:defer-no-basis'],
    'export const s = "/* HACK */";\nexport const re = /[/*]HACK/;\n'),
  P('js: regex after keyword is not a comment', '.js',
    'function f(x) { return /a/.test(x); } // FIXME slow\n', ['1:review:defer-no-basis'],
    'function f(x) { return /\\/\\/FIXME/.test(x); }\n'),
  P('ps1: # and <# #> vs strings, here-string, a#b', '.ps1',
    '<#\n TODO: rename\n#>\n$x = 1 # FIXME later\n', ['2:review:defer-no-basis', '4:review:defer-no-basis'],
    "$a = '<# TODO #>'\n$b = \"# FIXME `\" # TODO\"\n$h = @'\n# TODO inside here-string\n'@\nWrite-Output a#TODO\n"),
  P('sh: # comment vs $#, ${#x}, quotes, heredoc', '.sh',
    'echo hi # TODO quote args\n', ['1:review:defer-no-basis'],
    'echo $# ${#x} "# TODO" \'# FIXME\'\ncat <<EOF\n# TODO in heredoc\nEOF\n'),
  P('css: /* TODO */ vs strings and colors', '.css',
    '.a { color: red; } /* TODO theme token */\n', ['1:review:defer-no-basis'],
    '.a { color: #fff; content: "/* TODO */"; background: url(http://x//TODO); }\n'),
  P('history block: 9 lines, 3 marker lines vs 2 marker lines, 8 lines, one crowded line', '.py',
    '# 이 값의 경위\n# 2026-11-01 처음 넣음\n# 정정: 값을 바꿈\n# 3라운드에서 다시 봄\n# a\n# b\n# c\n# d\n# e\n', ['1:review:history-block'],
    '# 경위\n# 2026-11-01 처음\n# 정정\n# a\n# b\n# c\n# d\n# e\n# f\n\n# 2026-11-01 정정 3라운드 옛 판\n# a\n# b\n# c\n# d\n# e\n# f\n# g\n# h\n\n# 2026-11-01\n# 정정\n# 3라운드\n# a\n# b\n# c\n# d\n# e\n'),

  // ---- review round 1: JS ----
  P('js: regex after if (...) is not a comment', '.js',
    'if (ok) /[//]TODO/.test(s);\n', [],
    'if (ok) x = /[/]/.test(s);\n'),
  P('js: } then / is unsure, the comment after it is still read', '.js',
    'const n = {} / 2; // TODO real\n', ['1:review:defer-no-basis'],
    'const n = a / 2; // TODO real\n', ['1:review:defer-no-basis'], { unc: true }),
  P('js: i++ / 2 divides', '.js',
    'const y = i++ / 2; // TODO real\n', ['1:review:defer-no-basis'],
    'const y = i + 2; // TODO real\n', ['1:review:defer-no-basis']),
  P('ts: a! / b divides (non-null assertion)', '.ts',
    'const r = a! / b; // TODO real\n', ['1:review:defer-no-basis'],
    'const r = !/x/.test(a); // TODO real\n', ['1:review:defer-no-basis']),
  P('js: x.in / 2 divides (property, not keyword)', '.js',
    'const z = x.in / 2; // TODO real\n', ['1:review:defer-no-basis'],
    'const z = x.on / 2; // TODO real\n', ['1:review:defer-no-basis']),
  P('js: backslash before CRLF continues the string', '.js',
    'const s = "a\\\r\n// TODO";\r\n', [],
    'const s = "a\\n";\r\n// TODO: real\r\n', ['2:review:defer-no-basis']),
  P('js: U+2028 ends a line comment', '.js',
    '// ok const s = "TODO";\n', [],
    '// ok\nconst s = "TODO";\n'),
  P('js: unclosed block comment is unsure', '.js',
    '/* TODO never closed\nconst x = 1;\n', ['1:review:defer-no-basis'],
    '/* TODO: closed */\nconst x = 1;\n', ['1:review:defer-no-basis'], { unc: true }),
  // ---- CSS ----
  P('css: /* inside unquoted url( is not a comment', '.css',
    '.a { background: url(icons/*TODO*/x.svg); }\n', [],
    '.a { background: url("x.svg"); } /* TODO real */\n', ['1:review:defer-no-basis']),
  P('css: #333 is a color, not an item ID', '.css',
    '/* TODO: use #333 here */\n', ['1:review:defer-no-basis'],
    '/* TODO: use red here */\n', ['1:review:defer-no-basis']),
  // ---- Python ----
  P('py: """x""".lower() is an expression, not a docstring', '.py',
    'x = 1\n"""TODO""".lower()\n', [],
    'def f():\n    """TODO handle"""\n', ['2:review:defer-no-basis']),
  P('py: f-string with the outer quote inside a field is unsure', '.py',
    's = f"{mapping["# TODO"]}"\n', [],
    's = f"{d[\'# TODO\']}"\n', [], { unc: true }),
  P('py: # inside an f-string field is unsure and read as a comment', '.py',
    's = f"{1  # TODO real\n}"\n', ['1:review:defer-no-basis'],
    's = f"{n:#06x}"  # TODO real\n', ['1:review:defer-no-basis'], { unc: true }),
  P('py: backslash before CRLF continues the string', '.py',
    "s = 'a\\\r\n# TODO'\r\n", [],
    "s = 'a\\n'\r\n# TODO: real\r\n", ['2:review:defer-no-basis']),
  // ---- PowerShell ----
  P('ps1: indented \'@ does not end a here-string', '.ps1',
    "$s = @'\n  '@\n# TODO data\n'@\n# FIXME: real\n", ['5:review:defer-no-basis'],
    "$s = @'\n# TODO data\n'@\n# FIXME: real\n", ['4:review:defer-no-basis']),
  P('ps1: here-string without a closing line is unsure', '.ps1',
    "$h = @'\n# TODO body\n", ['2:review:defer-no-basis'],
    "$h = @'\n# TODO body\n'@\n", [], { unc: true }),
  P('ps1: 1# x is unsure and read as a comment', '.ps1',
    '$x = 1# TODO real\n', ['1:review:defer-no-basis'],
    '$x = 1 # TODO real\n', ['1:review:defer-no-basis'], { unc: true }),
  P('ps1: a<#x#>b is one word', '.ps1',
    'Write-Output a<#TODO#>b\n', [],
    'Write-Output a <#TODO#> b\n', ['1:review:defer-no-basis']),
  P('ps1: comment inside "$( )" is unsure and read', '.ps1',
    '$s = "$(1 # TODO real\n)"\n', ['1:review:defer-no-basis'],
    '$s = "$(1) # TODO not"\n', [], { unc: true }),
  P('ps1: double-quoted here-string body is not a comment', '.ps1',
    '$h = @"\n# TODO in body $x\n"@\n# FIXME: real\n', ['4:review:defer-no-basis'],
    '$h = @"\nplain\n"@\n', []),
  // ---- sh ----
  P('sh: heredoc delimiter with a dash (END-TEXT)', '.sh',
    'cat <<END-TEXT\ndata\nEND-TEXT\n# TODO: real\n', ['4:review:defer-no-basis'],
    'cat <<END\ndata\nEND\n# TODO: real\n', ['4:review:defer-no-basis']),
  P('sh: heredoc delimiter quoted with a backslash (<<\\EOF)', '.sh',
    'cat <<\\EOF\n# TODO data\nEOF\n', [],
    "cat <<'EOF'\n# TODO data\nEOF\n"),
  P('sh: $((1 << n)) is a shift, not a heredoc', '.sh',
    'v=$((1 << bits))\n# FIXME: real\n', ['2:review:defer-no-basis'],
    'v=$((1 + bits))\n# FIXME: real\n', ['2:review:defer-no-basis']),
  P('sh: <<< is a here-string, not a heredoc', '.sh',
    'cat <<< word\n# TODO: real\n', ['2:review:defer-no-basis'],
    'cat < word\n# TODO: real\n', ['2:review:defer-no-basis']),
  P('sh: heredoc without its delimiter line is unsure, later comments are read', '.sh',
    'cat <<EOF\n# TODO body\n', ['2:review:defer-no-basis'],
    'cat <<EOF\n# TODO body\nEOF\n', [], { unc: true }),
  P('sh: <<- strips leading tabs before the delimiter', '.sh',
    'cat <<-EOF\n\t# TODO in heredoc\n\tEOF\n# FIXME: real\n', ['4:review:defer-no-basis'],
    'cat <<EOF\n# TODO in heredoc\nEOF\n# FIXME: real\n', ['4:review:defer-no-basis']),
  P('sh: x\\ #y is one word', '.sh',
    'echo x\\ #TODO\n', [],
    'echo x #TODO\n', ['1:review:defer-no-basis']),
  P('sh: ${a}#x is one word', '.sh',
    'echo ${a}#TODO\n', [],
    'echo ${a} #TODO\n', ['1:review:defer-no-basis']),
  P('sh: comment inside "$( )" is unsure and read', '.sh',
    'x="$(echo ok # TODO real\n)"\n', ['1:review:defer-no-basis'],
    'x="$(echo ok) # TODO not"\n', [], { unc: true }),
  // ---- rules ----
  P('rule: temporary fixtures is not "temporary fix"', '.py',
    '# Load temporary fixtures for the test.\n', [],
    '# temporary fix: drop after upgrade\n', ['1:review:defer-no-basis']),
  P('rule: a quoted tag is review', '.py',
    '# 이 검색은 "TODO"라는 문자열을 찾는다.\n', ['1:review:defer-no-basis'],
    '# 이 검색은 문자열을 찾는다.\n'),
  P('rule: a tag as a file name or an object is review', '.py',
    '# see TODO.md for the list\n# skip TODO lines\n', ['1:review:defer-no-basis', '2:review:defer-no-basis'],
    '# TODO: see the list\n', ['1:review:defer-no-basis']),
  P('rule: XXX.mp4 as the first word is a name', '.py',
    '# XXX.mp4 is the output name\n', [],
    '# XXX! wrong name\n', ['1:review:defer-no-basis']),
  P('rule: "by" inside Ruby or nearby is not a deadline marker', '.py',
    '# workaround for Ruby 2025-03-01\n# TODO nearby 2026-01-01 fix\n', [],
    '# TODO: by 2026-01-01\n', ['1:review:deadline-passed']),
  P('rule: weak word or workaround next to a passed deadline stays review', '.py',
    '# 일단 2026-10-01까지 둔다\n# workaround until 2026-01-01\n', ['1:review:deadline-passed', '2:review:deadline-passed'],
    '# TODO: 2026-10-01까지\n', ['1:review:deadline-passed']),
  P('rule: an impossible date is not a date', '.py',
    '# TODO: by 2026-02-31\n#\n# FIXME: since 2026-88-77\n', ['1:review:defer-no-basis', '3:review:defer-no-basis'],
    '# TODO by 2028-02-29 then drop\n'),
  P('rule: mixed separators are not a README date form', '.py',
    '# TODO: by 2025/09-08\n', ['1:review:defer-no-basis'],
    '# TODO: by 2025/09/08\n', ['1:review:deadline-passed']),
  P('rule: technical names are not item IDs', '.py',
    '# TODO: support UTF-16LE\n#\n# TODO: verify SHA-256 sum\n', ['1:review:defer-no-basis', '3:review:defer-no-basis'],
    '# TODO(ABC-12) support UTF-16LE\n'),

  // ---- review round 2 ----
  P('rule: a negated strong phrase is review', '.py',
    '# This is not a temporary fix.\n# 임시 처리하지 않는다.\n# 나중에 고칠 필요 없다.\n',
    ['1:review:defer-no-basis', '2:review:defer-no-basis', '3:review:defer-no-basis'],
    '# 임시 처리: 업그레이드 뒤 지운다.\n# temporary fix until the parser lands\n', ['1:review:defer-no-basis', '2:review:defer-no-basis']),
  P('rule: a tag inside a sentence is review, also after a sentence end', '.py',
    '# Parse the literal TODO: prefix from the input.\n', ['1:review:defer-no-basis'],
    '# Breaks on empty input. TODO: handle it.\n', ['1:review:defer-no-basis']),
  P('rule: "before" with a past date may be a range, so the deadline is review', '.py',
    '# TODO: drop rows before 2024-01-01\n#\n# TODO 2024-01-01 전에 만든 행을 지운다\n', ['1:review:deadline-passed', '3:review:deadline-passed'],
    '# TODO: until 2024-01-01: drop rows\n#\n# TODO(2024-01-01까지)\n', ['1:review:deadline-passed', '3:review:deadline-passed']),
  P('rule: _by inside a name is not a deadline marker', '.py',
    '# TODO written_by 2026-11-01\n', [],
    '# TODO: by 2026-11-01\n', ['1:review:deadline-passed']),
  P('sh: $(...)#x and @(...)#x are one word', '.sh',
    'echo $(echo ok)#TODO:literal\nls @(a|b)#TODO:\n', [],
    'echo $(echo ok) #TODO: real\n', ['1:review:defer-no-basis']),
  P('sh: # right after an operator ) is unsure ([[ =~ (a|b)#x ]])', '.sh',
    '[[ $x =~ (a|b)#TODO: ]]\n', ['1:review:defer-no-basis'],
    '( cd x ) # TODO: real\n', ['1:review:defer-no-basis'], { unc: true }),
  P('ps1: # at the start of a line continued with a backtick is a comment', '.ps1',
    'Get-Item a `\n# TODO: real\n', ['2:review:defer-no-basis'],
    'Get-Item a `\n  -Force # TODO real\nWrite-Output a`#TODO\n', ['2:review:defer-no-basis']),

  // ---- review rounds 3 and 4: these pairs were written when a grade above review existed (removed in round 5,
  // 2026-11-19). Every tag form and deadline form in them is still found, all as review; the pairs now show that
  // each form is found on the same lines as before ----
  P('r3: a comment after code, a bullet, a strong phrase, a tag after a sentence are review', '.py',
    'x = 1  # TODO real\n# - TODO: bullet\n# 임시 처리: 업그레이드 뒤 지운다.\n# Breaks here. FIXME: x\n',
    ['1:review:defer-no-basis', '2:review:defer-no-basis', '3:review:defer-no-basis', '4:review:defer-no-basis'],
    '# TODO: handle it.\n# FIXME(alice): later\n', ['1:review:defer-no-basis', '2:review:defer-no-basis']),
  P('r3: a comment that names the tag itself is review', '.py',
    '# TODO 주석은 공개 문서에서 제외한다.\n# TODO는 이슈로 옮긴다.\n# TODO, FIXME 표지를 센다.\n# Preserve the error "Invalid input. TODO: missing field".\n',
    ['1:review:defer-no-basis', '2:review:defer-no-basis', '3:review:defer-no-basis', '4:review:defer-no-basis'],
    '# TODO: 공개 문서에서 뺀다.\n', ['1:review:defer-no-basis']),
  P('r3: a strong phrase inside a quoted message is review', '.js',
    '// Preserve the message "unsupported temporary fix" for older clients.\n', ['1:review:defer-no-basis'],
    '// Preserve the message for older clients.\n'),
  P('r3: a date that can name a data range is a review deadline', '.py',
    '# TODO: 2024-01-01까지 생성된 주문만 내보낸다.\n#\n# TODO 2024-01-01까지의 행만 남긴다.\n#\n# TODO until 2024-01-01 rows stay\n#\n# TODO: drop rows until 2024-01-01\n',
    ['1:review:deadline-passed', '3:review:deadline-passed', '5:review:deadline-passed', '7:review:deadline-passed'],
    '# TODO: 2024-01-01까지.\n#\n# TODO(by 2024-01-01): drop rows\n', ['1:review:deadline-passed', '3:review:deadline-passed']),
  P('r3: a deadline belongs to its own line, not to the next tag', '.py',
    '# TODO: by 2020-01-01: remove old endpoint.\n# FIXME: by 2099-01-01: remove replacement.\n', ['1:review:deadline-passed'],
    '# TODO: by 2020-01-01: remove old endpoint\n', ['1:review:deadline-passed']),
  P('r3: an item ID in backticks is a basis', '.js',
    '// TODO: remove after `#42` closes.\n', [],
    '// TODO: remove after (#42) closes.\n'),
  P('r3: a bare scheme and a color quoted in code are not a basis', '.py',
    '# TODO: reject the literal "https://" prefix when the host is empty.\ncolor = "#333"  # TODO: replace #333 with a theme token\n',
    ['1:review:defer-no-basis', '2:review:defer-no-basis'],
    '# TODO: see https://example.com/issue/1\nissue = 1  # TODO: see #333\n'),
  P('r3: the other two tags are review even as the bare first word', '.py',
    '# HACK: keeps old order\n# XXX: wrong on VFR\n#\n# HACK by 2020-01-01\n',
    ['1:review:defer-no-basis', '2:review:defer-no-basis', '4:review:deadline-passed'],
    '# FIXME: wrong on VFR\n#\n# TODO: by 2020-01-01\n', ['1:review:defer-no-basis', '3:review:deadline-passed']),
  P('r3: a block comment with code after it on the same line is review', '.js',
    '/* TODO real */ const x = 1;\n/*\n * FIXME: inner\n */ const y = 2;\n', ['1:review:defer-no-basis', '3:review:defer-no-basis'],
    '/* TODO: real */\nconst x = 1;\n/* FIXME: two */ // tail\n', ['1:review:defer-no-basis', '3:review:defer-no-basis']),
  P('r3: a CSS block comment before a rule on the same line is review', '.css',
    '/* TODO theme */ .a { color: red; }\n', ['1:review:defer-no-basis'],
    '/* TODO: theme */\n.a { color: red; }\n', ['1:review:defer-no-basis']),

  // ---- review round 4 (tag form, deadline phrase end, open sentence, string block) ----
  P('r4: a tag is found with or without ":" or "(" right after it; two tags on a line count by occurrence', '.py',
    '# TODO 목록은 상태별로 정렬해 표시한다.\n#\n# TODO is displayed as TODO in plain-text output.\n#\n# FIXME later\n#\n# TODO : spaced colon\n#\n# TODO: keep the TODO text in plain output\n',
    ['1:review:defer-no-basis', '3:review:defer-no-basis', '5:review:defer-no-basis', '7:review:defer-no-basis', '9:review:defer-no-basis'],
    '# TODO: remove this\n#\n# TODO(alice) remove this\n#\n# FIXME(ABC) drop\n',
    ['1:review:defer-no-basis', '3:review:defer-no-basis', '5:review:defer-no-basis']),
  P('r4: a past deadline is found whether or not a word follows the deadline phrase', '.py',
    '# TODO: 2024-01-01까지 로그 삭제\n#\n# TODO: 2024-01-01까지 이미 생성된 주문만 내보낸다.\n#\n# FIXME: by 2024-01-01 then remove\n#\n# TODO(until 2024-01-01 rows) keep\n',
    ['1:review:deadline-passed', '3:review:deadline-passed', '5:review:deadline-passed', '7:review:deadline-passed'],
    '# TODO(by 2024-01-01)\n\n# TODO: 2024-01-01까지\n\n# FIXME: by 2024-01-01.\n\n# TODO(by 2024-01-01) remove the shim\n\n# TODO: by 2024-01-01, then drop\n\n# TODO: until 2024-01-01: drop rows\n',
    [1, 3, 5, 7, 9, 11].map((k) => `${k}:review:deadline-passed`)),
  P('r4: a tag line that goes on from an open sentence above is review', '.py',
    '# Parse the literal\n# TODO: prefix from the input.\n# 이 함수는 입력 앞의\n# TODO: 접두어를 떼어 낸다.\n',
    ['2:review:defer-no-basis', '4:review:defer-no-basis'],
    '# Parse the input.\n# TODO: handle empty input\n#\n# 입력을 읽는다\n# TODO: 빈 입력을 처리한다.\n#\n# Steps:\n# FIXME: add step 3\ny = 1  # keep the literal\n# TODO: handle prefix\n',
    ['2:review:defer-no-basis', '5:review:defer-no-basis', '8:review:defer-no-basis', '10:review:defer-no-basis']),
  P('r4: a tag inside a docstring is review', '.py',
    'def f():\n    """Example configuration:\n\n    # TODO: set the project name\n    """\n    return 1\ndef g():\n    """TODO: handle"""\n',
    ['4:review:defer-no-basis', '8:review:defer-no-basis'],
    'def f():\n    # TODO: set the project name\n    return 1\n', ['2:review:defer-no-basis']),

  // ---- English weak words and history words ----
  P('en weak: temporarily vs temporary, identifiers and longer words', '.py',
    '# temporarily disable the cache\n', ['1:review:defer-word'],
    '# a temporary directory\n#\n# temporary_directory holds the files\n#\n# temporarily_disabled is the old flag name\n#\n# temporarilyx is not a word\n'),
  P('en weak: later after a work verb at the end of a clause vs runtime, version, order and position uses', '.py',
    '# handle the empty case later\n#\n# revisit this later, once the API lands\n#\n# do it later when we have time\n#\n# Clean up the helper later!\n#\n# Support streaming later if the parser allows\n',
    ['1:review:defer-word', '3:review:defer-word', '5:review:defer-word', '7:review:defer-word', '9:review:defer-word'],
    '# Try again later.\n#\n# the callback will be retried later\n#\n# Save the exception so we can chain it later.\n#\n# requires Python 3.8 or later\n#\n# support Python 3.8 or later\n#\n# support later versions of the parser\n#\n# sooner or later this fails\n#\n# versions 2 and later\n#\n# no later than the first call\n#\n# a later stage reads it\n#\n# add the later entry to the list\n#\n# do later_task() once\n#\n# translater\n#\n# later\n'),
  P('en weak: fix later is one finding, fix later versions is not a deferral', '.py',
    '# fix later\n#\n# Fix  later when the parser is rewritten\n', ['1:review:defer-word', '3:review:defer-word'],
    '# fix later versions of the parser\n#\n# fix later in the file\n#\n# fix laterals\n'),
  P('en weak: todo in tag form vs list, name, bullet and macro uses', '.py',
    '# todo: handle empty input\n#\n# Breaks here. todo(alice) fix it\n#\n# todo! handle it\n',
    ['1:review:defer-word', '3:review:defer-word', '5:review:defer-word'],
    '# todo list item component\n#\n# - todo: bullet\n#\n# see todo.md for the list\n#\n# the "todo: x" marker format\n#\n# use todo!() for unfinished code\n#\n# a todo app\n#\n# my_todo: field\n#\n# the todos array\n'),
  P('en weak: capitalised Todo in tag form vs list, plural, name and quoted uses', '.py',
    '# Todo: handle empty input\n#\n# Breaks here. Todo(alice) fix it\n#\n# Todo! handle it\n',
    ['1:review:defer-word', '3:review:defer-word', '5:review:defer-word'],
    '# Todo list item component\n#\n# - Todo: bullet\n#\n# the Todos array\n#\n# TodoItem component\n#\n# use Todo!() for unfinished code\n#\n# the "Todo: x" marker format\n#\n# a Todo app\n#\ns = "Todo: x"\n'),
  P('en weak: a basis exempts the new words', '.py',
    '# temporarily off\n#\n# do it later.\n', ['1:review:defer-word', '3:review:defer-word'],
    '# temporarily off, see https://example.com/issue/1\n#\n# do it later, see ABC-12.\n'),
  P('en weak: the new words next to a passed deadline are a deadline finding', '.py',
    '# temporarily off until 2026-10-01\n', ['1:review:deadline-passed'],
    '# temporarily off until 2026-12-31\n'),
  P('en history: changed, fixed, reverted on 3 lines vs fixed-size, fixed width, unchanged', '.py',
    '# How the default came about\n# Changed the default from 5 to 10\n# Fixed the off-by-one in the loop\n# Reverted after the outage\n# a\n# b\n# c\n# d\n# e\n', ['1:review:history-block'],
    '# Buffer layout\n# A fixed-size buffer holds the header\n# The fixed width of the field is 8\n# The value is unchanged between calls\n# Returns true if the file has changed\n# Stops when changed or closed\n# a\n# b\n# c\n# d\n# e\n'),
  P('history: the personal batch label (B plus a number) is not a marker', '.py',
    '# 경위\n# 묶음 B1\n# 묶음 B2\n# 묶음 B3\n# a\n# b\n# c\n# d\n# e\n', [],
    '# 경위\n# 정정 1\n# 종전 2\n# 3라운드\n# a\n# b\n# c\n# d\n# e\n', ['1:review:history-block']),
];

// The JSON of one run with every human-readable string value blanked: what is left (keys, rule names, lines,
// counts, flags) must be the same in both output languages.
const HUMAN_KEYS = new Set(['message', 'reason', 'basis', 'text']);
const blankHuman = (v) => JSON.stringify(v, (k, x) => (HUMAN_KEYS.has(k) && typeof x === 'string' ? '' : x));
const HANGUL = /[가-힣]/;
// Human-readable strings of an English run that contain Korean the fixture's own text does not have. A matched
// Korean marker word is quoted in the message, so a Korean word that is in the source is allowed.
function hangulInEnglish(j, src) {
  const bad = [];
  const foreign = (s) => (s.match(/[가-힣]+/g) || []).some((w) => !src.includes(w));
  for (const f of j.findings) { if (foreign(f.message) || foreign(f.ref)) bad.push(f.message); }
  for (const u of j.readUncertain) if (foreign(u.reason)) bad.push(u.reason);
  for (const e of j.exempt) if (foreign(e.basis)) bad.push(e.basis);
  if (foreign(j.summary.text)) bad.push(j.summary.text);
  return bad;
}
const langDiffs = []; const hangulHits = []; let langRuns = 0;

for (const t of pairs) {
  const id = crypto.randomBytes(4).toString('hex');
  const pb = write(`pairs/${id}/bad${t.ext}`, t.bad);
  const pg = write(`pairs/${id}/good${t.ext}`, t.good);
  const rb = run([pb]); const rg = run([pg]);
  for (const [which, p, ko] of [['bad', pb, rb], ['good', pg, rg]]) {
    const en = run([p], { lang: 'en' }); langRuns++;
    if (!ko.j || !en.j || blankHuman(ko.j) !== blankHuman(en.j) || ko.code !== en.code) langDiffs.push(`${t.name} (${which})`);
    if (en.j) hangulHits.push(...hangulInEnglish(en.j, which === 'bad' ? t.bad : t.good));
  }
  check(`[defect] ${t.name}`, rb.code === 0 && same(rules(rb), t.want) && unsure(rb) === t.unc,
    `code=${rb.code} got=${JSON.stringify(rules(rb))} want=${JSON.stringify(t.want)} unsure=${unsure(rb)} wantUnsure=${t.unc}`);
  check(`[clean]  ${t.name}`, rg.code === 0 && same(rules(rg), t.goodWant) && !unsure(rg),
    `code=${rg.code} got=${JSON.stringify(rules(rg))} want=${JSON.stringify(t.goodWant)} unsure=${unsure(rg)}`);
}

// Basis kinds one at a time: a lone kind must exempt the deferral by itself.
{
  const bad = run([write('basis/none.py', '# FIXME: breaks on empty list\n')]);
  check('[defect] basis: no basis is reported', same(rules(bad), ['1:review:defer-no-basis']), JSON.stringify(rules(bad)));
  const kinds = [
    ['URL', '# FIXME: see https://example.com/issue/1\n'],
    ['item ID with digits only after the key', '# TODO(ABC-12) later\n'],
    ['long item ID', '# TODO(PROJ-20240101-SAMPLE-ITEM) later\n'],
    ['#42', '# TODO(#42)\n'],
    ['repo#12', '# TODO see repo#12\n'],
    ['future deadline', '# HACK until 2026-12-31 then remove\n'],
    ['past date without a deadline marker (written date)', '# TODO 2026-10-01 추가함\n'],
  ];
  kinds.forEach(([k, src], n) => {
    const r = run([write(`basis/k${n}.py`, src)]);
    check(`[clean]  basis alone: ${k}`, r.code === 0 && same(rules(r), []) && r.j.summary.exemptByBasis === 1, `code=${r.code} ${JSON.stringify(rules(r))}`);
  });
  const long = run([write('basis/long.py', '# TODO(PROJ-20240101-SAMPLE-ITEM) later\n')]);
  const lb = long.j && long.j.exempt[0] && long.j.exempt[0].basis;
  check('[defect] basis: a long item ID is reported whole', lb === '항목 ID PROJ-20240101-SAMPLE-ITEM', JSON.stringify(lb));
  const short = run([write('basis/short.py', '# TODO(ABC-12) later\n')]);
  const sb = short.j && short.j.exempt[0] && short.j.exempt[0].basis;
  check('[clean]  basis: a short item ID is reported whole', sb === '항목 ID ABC-12', JSON.stringify(sb));
}

// README promises that the old tool already kept: these pass on it, and a mutated copy shows each one can fail.
{
  const dl = run([write('cover/dl.py', '# TODO: 2026-10-01 전까지.\n# TODO: 기한 2026-10-01.\n# TODO: 2026-10-01 마감.\n# TODO: due 2026-10-01.\n# TODO: deadline: 2026-10-01.\n')]);
  check('[cover]  deadline marker words 전까지, 기한, 마감, due, deadline', same(rules(dl), [1, 2, 3, 4, 5].map((k) => `${k}:review:deadline-passed`)), JSON.stringify(rules(dl)));
  const fu = run([write('cover/fu.py', '# TODO: 2026-12-31 전까지.\n# TODO: 기한 2026-12-31.\n# TODO: 2026-12-31 마감.\n# TODO: due 2026-12-31.\n# TODO: deadline: 2026-12-31.\n')]);
  check('[cover]  the same markers with a future date are a basis', same(rules(fu), []) && fu.j.summary.exemptByBasis === 5, JSON.stringify(rules(fu)));
  const wk = run([write('cover/wk.py', '# 추후 지원한다\n# 당분간 끈다\n# 임시로 막는다\n')]);
  check('[cover]  weak words 추후, 당분간, 임시로', same(rules(wk), ['1:review:defer-word', '2:review:defer-word', '3:review:defer-word']), JSON.stringify(rules(wk)));
  const wa = run([write('cover/wa.py', '# work-around for the seek bug\n# work around the seek bug\n# workarounds below\n')]);
  check('[cover]  work-around, work around, workarounds', same(rules(wa), ['1:review:workaround', '2:review:workaround', '3:review:workaround']), JSON.stringify(rules(wa)));
  write('gx/a.py', '# TODO a\n'); write('gx/.git/b.py', '# TODO b\n');
  const g1 = run([path.join(TMP, 'gx')]);
  check('[cover]  .git under the input is a default-excluded folder', g1.code === 0 && g1.j.summary.read === 1 && g1.j.summary.excluded.defaultDirs === 1, JSON.stringify(g1.j && g1.j.summary));
  const g2 = run([path.join(TMP, 'gx', '.git')]);
  check('[cover]  .git given as the input is excluded', g2.code === 2 && g2.j && g2.j.summary.read === 0 && g2.j.summary.excluded.defaultDirs === 1, `code=${g2.code} ${JSON.stringify(g2.j && g2.j.summary)}`);
}

// Reporting added in round 1: the unsure spots in summary, JSON and text; the basis behind each exemption.
{
  const p = write('report/h.sh', 'cat <<EOF\n# TODO body\n');
  const r = run([p]);
  const u = r.j && r.j.readUncertain && r.j.readUncertain[0];
  check('[new]    unsure: JSON lists file, line and reason; summary says 읽기 불확실 1(file:line reason)',
    r.code === 0 && u && u.path === p && u.line === 1 && /EOF/.test(u.reason) && r.j.summary.uncertain === 1 && /읽기 불확실 1\(h\.sh:1 /.test(r.j.summary.text), JSON.stringify(r.j && [r.j.readUncertain, r.j.summary.text]));
  const t = runRaw([p, '--today', '2026-11-18']);
  check('[new]    unsure: text mode prints READ_UNCERTAIN path:line', t.out.includes(`READ_UNCERTAIN ${p}:1: `), t.out);
  const e = run([write('report/e.py', '# TODO(ABC-12) later\n#\n# TODO 2026-10-01 추가함\n')]);
  const bases = e.j && e.j.exempt ? e.j.exempt.map((x) => `${x.line}:${x.basis}`) : [];
  check('[new]    exempt: JSON lists the basis of each exemption', same(bases, ['1:항목 ID ABC-12', '3:날짜 2026-10-01']), JSON.stringify(bases));
  // Round 4: an item ID in backticks is counted and recorded, not only left without a finding.
  const bt = run([write('report/bt.js', '// TODO: remove after `#42` closes.\n')]);
  check('[new]    exempt: an item ID in backticks is counted in the summary and listed in exempt[]',
    bt.j && bt.j.findings.length === 0 && bt.j.summary.exemptByBasis === 1 && bt.j.exempt.length === 1 && bt.j.exempt[0].line === 1 && bt.j.exempt[0].basis === '항목 ID #42',
    JSON.stringify(bt.j && [bt.j.summary.exemptByBasis, bt.j.exempt]));
  // Round 4: every finding of an unsure file carries uncertainRead and the message suffix; a sure file's does not.
  const uf = run([write('report/uf.sh', 'cat <<EOF\n# TODO body\n')]);
  const f0 = uf.j && uf.j.findings[0];
  check('[new]    unsure: each finding of an unsure file has uncertainRead true and ends with (읽기 불확실 파일)',
    uf.j && uf.j.findings.length === 1 && f0.uncertainRead === true && f0.message.endsWith(' (읽기 불확실 파일)'), JSON.stringify(f0));
  const sf = run([write('report/sf.sh', 'cat <<EOF\n# TODO body\nEOF\n# TODO: real\n')]);
  const s0 = sf.j && sf.j.findings[0];
  check('[new]    unsure: a finding of a sure file has no uncertainRead and no suffix',
    sf.j && sf.j.findings.length === 1 && !s0.uncertainRead && !s0.message.includes('읽기 불확실 파일'), JSON.stringify(s0));
}

// Exclusion: relative glob, folder pattern covers the subtree, case-insensitive, applies to a file given directly.
{
  write('ex/keep.py', '# TODO a\n'); write('ex/Sub/deep/x.py', '# TODO b\n'); write('ex/node_modules/m.js', '// TODO c\n');
  write('ex/skip.ps1', '# TODO d\n');
  const r0 = run([path.join(TMP, 'ex')]);
  check('[clean]  exclude: without patterns all files except node_modules are read', r0.j && r0.j.summary.read === 3 && r0.j.summary.excluded.defaultDirs === 1, JSON.stringify(r0.j && r0.j.summary));
  const r1 = run([path.join(TMP, 'ex'), '--exclude', 'sub', '--exclude', '*.PS1']);
  check('[clean]  exclude: folder pattern and case-insensitive glob remove files', r1.j && r1.j.summary.read === 1 && r1.j.summary.excluded.dirs === 1 && r1.j.summary.excluded.files === 1, JSON.stringify(r1.j && r1.j.summary));
  const lst = write('ex-list.txt', '# comment line\nsub/**\n\n');
  const r2 = run([path.join(TMP, 'ex', 'Sub', 'deep', 'x.py'), '--exclude', 'x.py']);
  check('[clean]  exclude: applies to a file given directly (exit 2, nothing read, counted as excluded, no read error)',
    r2.code === 2 && r2.j && r2.j.summary.read === 0 && r2.j.summary.excluded.files === 1 && r2.j.readErrors.length === 0,
    `code=${r2.code} ${r2.parseError || JSON.stringify(r2.j && [r2.j.summary, r2.j.readErrors])}`);
  const r3 = run([path.join(TMP, 'ex'), '--exclude-from', lst]);
  check('[clean]  exclude-from: list file patterns apply', r3.j && r3.j.summary.read === 2, JSON.stringify(r3.j && r3.j.summary));
  write('emo/\u{1F600}.py', '# TODO e\n'); write('emo/ab.py', '# TODO f\n');
  const r4 = run([path.join(TMP, 'emo'), '--exclude', '?.py']);
  check('[defect] exclude: ? matches one character outside the BMP', r4.j && r4.j.summary.read === 1, JSON.stringify(r4.j && r4.j.summary));
  write('emo2/ab.py', '# TODO f\n'); write('emo2/c.py', '# TODO g\n');
  const r5 = run([path.join(TMP, 'emo2'), '--exclude', '??.py']);
  check('[clean]  exclude: ?? matches a two-letter name', r5.j && r5.j.summary.read === 1, JSON.stringify(r5.j && r5.j.summary));
  write('nm/a.js', '// TODO g\n'); write('nm/node_modules/x.js', '// TODO h\n');
  const r6 = run([path.join(TMP, 'nm', 'node_modules')]);
  check('[defect] exclude: node_modules given as the input is still a default-excluded folder', r6.code === 2 && r6.j && r6.j.summary.read === 0 && r6.j.summary.excluded.defaultDirs === 1, `code=${r6.code} ${JSON.stringify(r6.j && r6.j.summary)}`);
  const r7 = run([path.join(TMP, 'nm')]);
  check('[clean]  exclude: node_modules under the input is excluded', r7.code === 0 && r7.j.summary.read === 1 && r7.j.summary.excluded.defaultDirs === 1, JSON.stringify(r7.j && r7.j.summary));
}

// deps and list files: a missing list or a folder in the list slot is exit 2.
{
  const d = write('deps-list.txt', 'keep.py\nsub\\deep\\x.py\nmissing.py\n');
  const r = run([path.join(TMP, 'ex'), '--deps', d]);
  check('[clean]  deps: 3 entries, 2 matched, 1 missing', r.j && r.j.summary.deps.total === 3 && r.j.summary.deps.matched === 2 && r.j.depsMissing[0] === 'missing.py', JSON.stringify(r.j && [r.j.summary.deps, r.j.depsMissing]));
  const rt = runRaw([path.join(TMP, 'ex'), '--deps', d, '--today', '2026-11-18']);
  check('[cover]  deps: text mode prints DEPS_MISSING <entry> and 「deps 3개 중 2개 일치」', rt.code === 0 && rt.out.split('\n').includes('DEPS_MISSING missing.py') && rt.out.includes('deps 3개 중 2개 일치'), rt.out);
  check('[clean]  deps: list file not found is exit 2', run([path.join(TMP, 'ex'), '--deps', path.join(TMP, 'no-such-list.txt')]).code === 2);
  const r3 = run([path.join(TMP, 'ex'), '--deps', path.join(TMP, 'ex')]);
  check('[defect] deps: a folder in the list slot is exit 2', r3.code === 2, `code=${r3.code}`);
  const r4 = run([path.join(TMP, 'ex'), '--exclude-from', path.join(TMP, 'ex')]);
  check('[defect] exclude-from: a folder in the list slot is exit 2', r4.code === 2, `code=${r4.code}`);
  // List files use the source encodings: UTF-16 with BOM is read, text with NUL is exit 2, never silently ignored.
  const one = write('lst16/only.py', '# TODO only\n');
  const u16 = (t) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]);
  const e16 = run([one, '--exclude-from', write('lst16-ex.txt', u16('only.py\n'))]);
  check('[defect] exclude-from: a UTF-16 LE list with BOM applies (exit 2, file excluded)',
    e16.code === 2 && e16.j && e16.j.summary.read === 0 && e16.j.summary.excluded.files === 1, `code=${e16.code} ${JSON.stringify(e16.j && e16.j.summary)}`);
  const d16 = run([one, '--deps', write('lst16-deps.txt', u16('only.py\n'))]);
  check('[defect] deps: a UTF-16 LE list with BOM matches', d16.code === 0 && d16.j && d16.j.summary.deps.matched === 1 && d16.j.depsMissing.length === 0,
    `code=${d16.code} ${JSON.stringify(d16.j && [d16.j.summary.deps, d16.j.depsMissing])}`);
  const nb = runRaw([one, '--exclude-from', write('lst16-nobom.txt', Buffer.from('only.py\n', 'utf16le')), '--json']);
  check('[defect] exclude-from: a list with NUL (UTF-16 without BOM) is exit 2', nb.code === 2 && /ARG_ERROR .*NUL_IN_TEXT/.test(nb.err), `code=${nb.code} ${nb.err}`);
  const nbd = runRaw([one, '--deps', write('lst16-nobom-deps.txt', Buffer.from('only.py\n', 'utf16le')), '--json']);
  check('[defect] deps: a list with NUL (UTF-16 without BOM) is exit 2', nbd.code === 2 && /ARG_ERROR .*NUL_IN_TEXT/.test(nbd.err), `code=${nbd.code} ${nbd.err}`);
  const e8 = run([one, '--exclude-from', write('lst8-ex.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('only.py\r\n')]))]);
  check('[clean]  exclude-from: a UTF-8 list with BOM and CRLF applies', e8.code === 2 && e8.j && e8.j.summary.excluded.files === 1, `code=${e8.code} ${JSON.stringify(e8.j && e8.j.summary)}`);
}

// Arguments: option values, --today.
{
  const ok = path.join(TMP, 'ex', 'keep.py');
  const r1 = runRaw([ok, '--exclude', '--json']);
  check('[defect] args: an option cannot take the next option as its value', r1.code === 2, `code=${r1.code}`);
  check('[clean]  args: --exclude x --json is read', runRaw([ok, '--exclude', 'x', '--json']).code === 0);
  for (const bad of ['2026-02-31', '2026-99-99']) {
    const r = runRaw([ok, '--today', bad]);
    check(`[defect] args: --today ${bad} is exit 2`, r.code === 2, `code=${r.code}`);
  }
  check('[clean]  args: --today 2028-02-29 is accepted', runRaw([ok, '--today', '2028-02-29']).code === 0);
  check('[clean]  args: --today 2026-1-1 is exit 2', runRaw([ok, '--today', '2026-1-1']).code === 2);
}

// Exit codes and encodings: read failure 3, nothing readable 2, missing path 2, unknown option 2.
{
  write('enc/ok.py', '# fine\n');
  const pbad = write('enc/bad.py', Buffer.from([0x23, 0x20, 0xff, 0xfe, 0xfd, 0x0a, 0xc3]));
  const r = run([path.join(TMP, 'enc')]);
  check('[clean]  invalid UTF-8 file is exit 3 and listed', r.code === 3 && r.j && r.j.readErrors.length === 1 && r.j.readErrors[0].path === pbad, `code=${r.code}`);
  check('[clean]  readable file is exit 0', run([path.join(TMP, 'enc', 'ok.py')]).code === 0);
  const rt = runRaw([path.join(TMP, 'enc'), '--today', '2026-11-18']);
  check('[cover]  text mode prints READ_ERROR <path>: INVALID_UTF8', rt.code === 3 && rt.out.split('\n').includes(`READ_ERROR ${pbad}: INVALID_UTF8`), rt.out);
  const u16 = write('enc16/w.ps1', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# TODO: utf16\n', 'utf16le')]));
  const r5 = run([u16]);
  check('[clean]  UTF-16 LE with BOM is read', r5.code === 0 && same(rules(r5), ['1:review:defer-no-basis']), `code=${r5.code} ${JSON.stringify(rules(r5))}`);
  const be = Buffer.from('# TODO: utf16be\n', 'utf16le'); be.swap16();
  const r6 = run([write('enc16be/w.py', Buffer.concat([Buffer.from([0xfe, 0xff]), be]))]);
  check('[clean]  UTF-16 BE with BOM is read', r6.code === 0 && same(rules(r6), ['1:review:defer-no-basis']), `code=${r6.code} ${JSON.stringify(rules(r6))}`);
  const u32 = Buffer.alloc(4 * 7); [...'# TODO\n'].forEach((ch, k) => u32.writeUInt32LE(ch.codePointAt(0), 4 * k));
  const r7 = run([write('enc32/a.py', '# fine\n'), write('enc32/w.py', Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), u32]))]);
  check('[defect] UTF-32 LE BOM is a read failure (exit 3)', r7.code === 3 && r7.j && r7.j.readErrors.length === 1, `code=${r7.code} ${JSON.stringify(r7.j && r7.j.readErrors)}`);
  const r8 = run([write('encnul/a.py', '# fine\n'), write('encnul/w.py', Buffer.from('# TODO no bom\n', 'utf16le'))]);
  check('[defect] text with NUL (UTF-16 without BOM) is a read failure (exit 3)', r8.code === 3 && r8.j && r8.j.readErrors.length === 1, `code=${r8.code} ${JSON.stringify(r8.j && r8.j.readErrors)}`);
  write('mdonly/a.md', '# TODO\n');
  const md = run([path.join(TMP, 'mdonly')]);
  check('[cover]  only unsupported files: exit 2, JSON summary with 0 read and .md 1 skipped, NO_FILES_READ on stderr',
    md.code === 2 && md.j && md.j.summary.read === 0 && md.j.summary.skipped['.md'] === 1 && md.j.summary.exitCode === 2 &&
    /^COMMENT_LINT_SUMMARY /.test(md.j.summary.text) && /NO_FILES_READ/.test(md.err), `code=${md.code} ${md.parseError || JSON.stringify(md.j && md.j.summary)} err=${md.err}`);
  check('[clean]  missing path is exit 2', run([path.join(TMP, 'nope')]).code === 2);
  check('[clean]  unknown option is exit 2', run([path.join(TMP, 'enc', 'ok.py'), '--bogus']).code === 2);
}

// Overlapping inputs are read once.
{
  const dir = path.join(TMP, 'ovl'); const f = write('ovl/a.py', '# TODO once\n');
  const r = run([dir, f]);
  check('[defect] overlap: a folder and a file in it are read once', r.j && r.j.summary.read === 1 && r.j.findings.length === 1, JSON.stringify(r.j && r.j.summary));
  const r2 = run([f]);
  check('[clean]  overlap: one input reads one file', r2.j && r2.j.summary.read === 1 && r2.j.findings.length === 1, JSON.stringify(r2.j && r2.j.summary));
}

// Broken link given directly next to a good file: the link is skipped, the good file is read.
{
  const tgt = path.join(TMP, 'jt-target'); fs.mkdirSync(tgt);
  const lnk = path.join(TMP, 'jl', 'link'); fs.mkdirSync(path.dirname(lnk), { recursive: true });
  let made = false;
  try { fs.symlinkSync(tgt, lnk, 'junction'); fs.rmSync(tgt, { recursive: true }); made = true; } catch { /* links not allowed here */ }
  if (made) {
    const ok = write('jl-ok/a.py', '# TODO linked\n');
    const r = run([ok, lnk]);
    check('[defect] broken link input is skipped, not a missing path', r.code === 0 && r.j && r.j.summary.read === 1 && r.j.summary.skipped['(symlink)'] === 1, `code=${r.code} ${r.err}`);
  } else { skip++; console.log('SKIP broken link input (cannot create a link here)'); }
}

// A folder that cannot be listed: the error is a read failure (exit 3); other files and the summary remain.
// fs.readdirSync is replaced in this process, so the tool is imported and main() is called directly.
{
  write('locked/ok.py', '# TODO visible\n'); fs.mkdirSync(path.join(TMP, 'locked', 'deny'), { recursive: true });
  const mod = await import(pathToFileURL(TOOL).href);
  const realReaddir = fs.readdirSync;
  fs.readdirSync = function (p, ...rest) {
    if (String(p).endsWith(path.sep + 'deny')) { const e = new Error(`EACCES: permission denied, scandir '${p}'`); e.code = 'EACCES'; throw e; }
    return realReaddir.call(this, p, ...rest);
  };
  const outW = process.stdout.write; const errW = process.stderr.write; let out = ''; let code = null; let threw = null;
  process.stdout.write = (x) => { out += x; return true; }; process.stderr.write = () => true;
  try { code = mod.main([path.join(TMP, 'locked'), '--json', '--today', '2026-11-18']); } catch (e) { threw = e; } finally {
    fs.readdirSync = realReaddir; process.stdout.write = outW; process.stderr.write = errW;
  }
  let j = null; try { j = JSON.parse(out); } catch { /* checked below */ }
  check('[defect] unlistable subfolder: exit 3, other files read, error listed', !threw && code === 3 && j && j.summary.read === 1 && j.findings.length === 1 && j.readErrors.length === 1 && j.readErrors[0].reason === 'EACCES',
    threw ? `threw ${threw.code || threw.message}` : `code=${code} ${JSON.stringify(j && j.summary)}`);
}

// One grade only: every finding of every run above is review, and no summary counts another grade.
{
  const grades = [...new Set(seenFindings.map((f) => f.confidence))];
  check('[new]    one grade: every finding of all runs above has confidence review',
    seenFindings.length > 50 && grades.length === 1 && grades[0] === 'review', `findings=${seenFindings.length} grades=${JSON.stringify(grades)}`);
  const badSummary = seenSummaries.filter((x) => x.summary.certain !== 0 || x.summary.review !== x.n);
  check('[new]    one grade: JSON summary.certain is 0 and summary.review equals the finding count of each run',
    seenSummaries.length > 50 && badSummary.length === 0, JSON.stringify(badSummary.slice(0, 2)));
  const findingLines = (out) => out.split('\n').filter((l) => l.trim() && !l.startsWith('COMMENT_LINT_SUMMARY '));
  const t = runRaw([path.join(TMP, 'ex'), '--today', '2026-11-18']);
  check('[new]    one grade: text output labels findings 사람 확인 only and has no 확실',
    findingLines(t.out).length >= 2 && findingLines(t.out).every((l) => l.includes('[사람 확인]')) && !/(?<!불)확실/.test(t.out), t.out);
}

// Output language: English by default, Korean by --lang ko or COMMENT_LINT_LANG; detection and JSON structure never change.
{
  check('[new]    lang: all pairs give the same JSON structure, rules, lines and exit code in en and ko (human strings blanked)',
    langRuns > 100 && langDiffs.length === 0, `runs=${langRuns} ${langDiffs.slice(0, 5).join('; ')}`);
  check('[new]    lang: no English-run message, ref, reason, basis or summary text contains Korean',
    hangulHits.length === 0, hangulHits.slice(0, 3).join(' | '));

  const sel = write('lang/sel.py', '# TODO: remove this\n');
  const txt = (r) => r.out.trim().split('\n');
  const dflt = runRaw([sel, '--today', '2026-11-18'], { lang: null });
  check('[new]    lang: no option and no variable prints English', dflt.code === 0 && dflt.out.includes(': [review] defer-no-basis: ') && dflt.out.includes(' | ref: README rules: ') && !HANGUL.test(txt(dflt)[0].split(' | ')[0]) && /^COMMENT_LINT_SUMMARY files read 1, /.test(txt(dflt)[1]), dflt.out);
  const ko1 = runRaw([sel, '--today', '2026-11-18'], { lang: 'ko' });
  check('[new]    lang: --lang ko prints Korean', ko1.code === 0 && ko1.out.includes(': [사람 확인] defer-no-basis: ') && ko1.out.includes(' | 근거: README rules: ') && /^COMMENT_LINT_SUMMARY 읽은 파일 1, /.test(txt(ko1)[1]), ko1.out);
  const ev = (v, lang, a = [sel, '--today', '2026-11-18']) => runRaw(a, { lang, env: { COMMENT_LINT_LANG: v } });
  check('[new]    lang: COMMENT_LINT_LANG=ko prints Korean', ev('ko', null).out.includes('[사람 확인]'));
  check('[new]    lang: COMMENT_LINT_LANG=KO_kr.UTF-8 (a locale value) prints Korean', ev('KO_kr.UTF-8', null).out.includes('[사람 확인]'));
  check('[new]    lang: COMMENT_LINT_LANG=en prints English', ev('en', null).out.includes('[review]'));
  check('[new]    lang: an empty COMMENT_LINT_LANG prints English', ev('', null).out.includes('[review]'));
  check('[new]    lang: --lang en wins over COMMENT_LINT_LANG=ko', ev('ko', 'en').out.includes('[review]'));
  check('[new]    lang: --lang ko wins over COMMENT_LINT_LANG=en', ev('en', 'ko').out.includes('[사람 확인]'));
  check('[new]    lang: --lang EN is accepted (case-insensitive)', runRaw([sel, '--today', '2026-11-18'], { lang: 'EN' }).out.includes('[review]'));
  const badEnv = ev('fr', null);
  check('[defect] lang: an unknown COMMENT_LINT_LANG is exit 2 with ARG_ERROR', badEnv.code === 2 && /ARG_ERROR COMMENT_LINT_LANG must be en or ko/.test(badEnv.err), `code=${badEnv.code} ${badEnv.err}`);
  const badFlag = runRaw([sel, '--lang', 'fr'], { lang: null });
  check('[defect] lang: --lang fr is exit 2 with ARG_ERROR', badFlag.code === 2 && /ARG_ERROR --lang must be en or ko/.test(badFlag.err), `code=${badFlag.code} ${badFlag.err}`);
  check('[defect] lang: --lang without a value is exit 2', runRaw([sel, '--lang'], { lang: null }).code === 2);
  check('[clean]  lang: --help works and names --lang, also with a bad COMMENT_LINT_LANG',
    (() => { const h = runRaw(['--help'], { lang: null, env: { COMMENT_LINT_LANG: 'fr' } }); return h.code === 0 && h.out.includes('--lang en|ko') && !HANGUL.test(h.out); })());

  // English text: every message, label and summary part.
  const all = write('lang/all.py', '# TODO: remove this\n#\n# FIXME: by 2026-10-01\n#\n# for now skip audio\n#\n# workaround for X\n#\n# temporarily off\n');
  const en = runRaw([all, '--today', '2026-11-18'], { lang: 'en' });
  const exp = [
    `${all}:1: [review] defer-no-basis: deferral tag (TODO) with no basis (URL, item ID, date) | ref: README rules: defer-no-basis | # TODO: remove this`,
    `${all}:3: [review] deadline-passed: deadline 2026-10-01 of a deferring comment has passed (FIXME) | ref: README rules: deadline-passed | # FIXME: by 2026-10-01`,
    `${all}:5: [review] defer-word: word that may mean a deferral (for now), no basis | ref: README rules: defer-word | # for now skip audio`,
    `${all}:7: [review] workaround: workaround: check whether it is a temporary bypass or a "why" comment worth keeping (an outside trap) | ref: README rules: workaround | # workaround for X`,
    `${all}:9: [review] defer-word: word that may mean a deferral (temporarily), no basis | ref: README rules: defer-word | # temporarily off`,
    'COMMENT_LINT_SUMMARY files read 1, files skipped 0, excluded folders 0 (default 0) and files 0, deps not given, findings 5, deferrals skipped for a basis 0, read errors 0, read uncertain 0',
  ];
  check('[new]    lang en: finding lines and summary line, exact text', JSON.stringify(txt(en)) === JSON.stringify(exp), en.out);
  const ko = runRaw([all, '--today', '2026-11-18'], { lang: 'ko' });
  check('[new]    lang ko: the Korean lines are the ones the tool printed before (summary line exact)',
    txt(ko).at(-1) === 'COMMENT_LINT_SUMMARY 읽은 파일 1, 건너뛴 파일 0, 제외 폴더 0(기본 0) 파일 0, deps 미지정, 발견 5, 근거 있어 넘긴 미루는 주석 0, 읽기 실패 0, 읽기 불확실 0' &&
    txt(ko)[0] === `${all}:1: [사람 확인] defer-no-basis: 미루는 주석의 표지(TODO)가 있고 근거(URL, 항목 ID, 날짜)가 없다 | 근거: README rules: defer-no-basis | # TODO: remove this` &&
    txt(ko)[1].includes('미루는 주석의 기한 2026-10-01이 지났다(FIXME)') && txt(ko)[2].includes('미루는 뜻일 수 있는 낱말(for now), 근거 없음') && txt(ko)[3].includes('임시 우회인지'), ko.out);

  const hb = run([write('lang/hist.py', '# How it came about\n# Changed the default\n# Fixed the leak\n# Reverted after the outage\n# a\n# b\n# c\n# d\n# e\n')], { lang: 'en' });
  check('[new]    lang en: history-block message', hb.j && hb.j.findings.length === 1 && hb.j.findings[0].message === 'comment block lines 1-9 (9 lines) has history markers on 3 lines: Changed, Fixed, Reverted', JSON.stringify(hb.j && hb.j.findings));
  const fl = run([write('lang/fixlater.py', '# fix later\n')], { lang: 'en' });
  check('[new]    lang en: fix later is named once, without a second "later"', fl.j && fl.j.findings.length === 1 && / \(fix later\), /.test(fl.j.findings[0].message), JSON.stringify(fl.j && fl.j.findings));

  // English unsure reasons, suffix, exempt basis, deps and the skipped part of the summary.
  const hp = write('lang/h.sh', 'cat <<EOF\n# TODO body\n');
  const eu = runRaw([hp, '--today', '2026-11-18'], { lang: 'en' });
  check('[new]    lang en: unsure reason, finding suffix and summary part',
    eu.out.includes(`READ_UNCERTAIN ${hp}:1: end line of heredoc marker EOF not found\n`) && eu.out.includes('with no basis (URL, item ID, date) (file read with uncertainty) |') &&
    / read uncertain 1 \(h\.sh:1 end line of heredoc marker EOF not found\)$/m.test(eu.out), eu.out);
  const ee = run([write('lang/e.py', '# TODO(ABC-12) soon\n#\n# TODO 2026-10-01 added\n#\n# TODO see https://example.com/x\n')], { lang: 'en' });
  const eb = ee.j ? ee.j.exempt.map((x) => `${x.line}:${x.basis}`) : [];
  check('[new]    lang en: exempt basis labels', same(eb, ['1:item ID ABC-12', '3:date 2026-10-01', '5:URL https://example.com/x']), JSON.stringify(eb));
  write('lang/dep/a.py', '# fine\n'); write('lang/dep/b.py', '# fine\n');
  const dl = write('lang-deps.txt', 'a.py\nmissing.py\n');
  const ed = runRaw([path.join(TMP, 'lang', 'dep'), '--deps', dl, '--exclude', 'b.py', '--today', '2026-11-18'], { lang: 'en' });
  check('[new]    lang en: deps part, DEPS_MISSING line and excluded part of the summary',
    ed.code === 0 && ed.out.split('\n').includes('DEPS_MISSING missing.py') && /, deps 1 of 2 matched, /.test(ed.out) && /excluded folders 0 \(default 0\) and files 1, /.test(ed.out), ed.out);
  const md = write('lang/note.md', '# TODO\n');
  const sk = runRaw([path.join(TMP, 'lang', 'sel.py'), md, '--today', '2026-11-18'], { lang: 'en' });
  check('[new]    lang en: skipped part of the summary', / files skipped 1 \(\.md 1\), /.test(sk.out), sk.out);
  const many = [1, 2, 3, 4, 5, 6, 7].map((k) => write(`lang/many/u${k}.sh`, 'cat <<EOF\nx\n'));
  const mEn = runRaw([path.join(TMP, 'lang', 'many')], { lang: 'en' }); const mKo = runRaw([path.join(TMP, 'lang', 'many')], { lang: 'ko' });
  check('[new]    lang: the "more files" tail of the uncertain part, en and ko', many.length === 7 && /; 2 more files\)$/m.test(mEn.out) && /; 외 2개 파일\)$/m.test(mKo.out), mEn.out + mKo.out);
}

// Text mode ends with the summary line; read-only check; self-check.
{
  for (const lang of ['en', 'ko']) {
    const t = runRaw([path.join(TMP, 'ex'), '--today', '2026-11-18'], { lang });
    const lines = t.out.trim().split('\n');
    check(`[clean]  text output (${lang}): findings then COMMENT_LINT_SUMMARY as last line`, lines.at(-1).startsWith('COMMENT_LINT_SUMMARY ') && lines.length === 4, t.out);
  }
  const changed = [...written].filter(([p, w]) => !fs.existsSync(p) || sha(fs.readFileSync(p)) !== w.h || fs.statSync(p).mtimeMs !== w.t).map(([p]) => p);
  check(`[clean]  read-only: none of ${written.size} fixtures changed or was rewritten since it was written`, changed.length === 0, changed.join(', '));
  const extra = filesUnder(TMP).filter((p) => !written.has(p));
  check('[clean]  read-only: no file appeared in the test folder that the tests did not write', extra.length === 0, extra.join(', '));
  const selfEn = runRaw([TOOL, path.join(HERE, 'run_tests.mjs')], { lang: 'en' });
  check('[self]   self-check: the tool and this test file have no findings and no unsure reading', selfEn.code === 0 && / findings 0, /.test(selfEn.out) && /read uncertain 0$/m.test(selfEn.out), selfEn.out);
  const selfKo = runRaw([TOOL, path.join(HERE, 'run_tests.mjs')], { lang: 'ko' });
  check('[self]   self-check (ko): same result in Korean', selfKo.code === 0 && / 발견 0,/.test(selfKo.out) && /읽기 불확실 0$/m.test(selfKo.out), selfKo.out);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`RESULT pass=${pass} fail=${fail}${skip ? ` skip=${skip}` : ''}`);
process.exitCode = fail ? 1 : 0;
