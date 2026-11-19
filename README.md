# comment-lint

Find the `TODO`s nobody will ever come back to: comments that put work off with no issue link, no ticket ID and no date, deadlines that have already passed, and comment blocks that have grown into a change log.

[한국어 README](README.ko.md)

```sh
npm install -g github:OWNER/comment-lint
```

Or without installing: clone the repository and run `node comment_lint.mjs`. It needs Node.js only (no dependencies).

## Example

```python
# src/app.py
def load(path):
    # TODO: handle empty files
    data = open(path).read()
    # TODO(#42): stream large files
    # FIXME: remove by 2024-06-30
    return data  # for now, no caching
```

```console
$ comment-lint src --today 2026-11-18
/work/project/src/app.py:2: [review] defer-no-basis: deferral tag (TODO) with no basis (URL, item ID, date) | ref: README rules: defer-no-basis | # TODO: handle empty files
/work/project/src/app.py:5: [review] deadline-passed: deadline 2024-06-30 of a deferring comment has passed (FIXME) | ref: README rules: deadline-passed | # FIXME: remove by 2024-06-30
/work/project/src/app.py:6: [review] defer-word: word that may mean a deferral (for now), no basis | ref: README rules: defer-word | # for now, no caching
COMMENT_LINT_SUMMARY files read 1, files skipped 0, excluded folders 0 (default 0) and files 0, deps not given, findings 3, deferrals skipped for a basis 1, read errors 0, read uncertain 0
```

Line 4 is not reported: `#42` is a basis (someone is tracking it). Line 5 has a date, but the deadline is in the past, so it is reported anyway.

The output is in English by default; `--lang ko` prints Korean (see [Languages](#languages)). `[review]` means "for a person to review". The rule name in each line (`defer-no-basis`, `deadline-passed`, ...) is the stable part, in either language; the rules table below explains each one. Use `--json` for machine-readable output.

## What it is and is not

- Report only. It never writes, renames or deletes a file. Every finding is a candidate for a person to review; the tool does not decide what to fix.
- It looks at comments only. Text inside strings, template literals, regex literals, heredocs and here-strings is not a comment.
- It does not check whether a comment still matches the code.

## Languages

There are two kinds of language here.

**Source languages** (comment syntax it can read):

| Extension | Comments |
|---|---|
| `.py` | `#`, and a triple-quoted string that stands as its own statement (docstring) |
| `.js`, `.mjs`, `.cjs`, `.ts` | `//`, `/* */` |
| `.ps1` | `#`, `<# #>` |
| `.sh` | `#` at the start of a word |
| `.css` | `/* */` |

Other files (`.md`, `.html`, `.json`, ...) are skipped and counted in the summary. JSX is not promised to be read correctly.

**Marker languages** (words it looks for in comments): English and Korean.

| Rule | English | Korean |
|---|---|---|
| Tags | `TODO`, `FIXME`, `HACK`, `XXX` (uppercase only) | same tags |
| Strong phrases | `temporary fix` (any case) | 임시 처리, 나중에 고친다 / 고침 / 고치기 / 고칠 |
| Weak words | `for now`, `temporarily`, `fix later` (any case); `later`, `todo` and `Todo` in the narrow forms below | 임시로, 일단, 추후, 당분간 |
| Workaround | `workaround`, `work-around`, `work around`, plurals | (none) |
| Deadline markers | `until`, `by`, `deadline`, `due`, `before` + date | 까지, 전까지, 기한, 마감, 전에 |
| History markers | dates (`YYYY-MM-DD`), `changed`, `fixed`, `reverted` (any case) | dates, 정정, 종전, 라운드, 옛 판 |

The English weak words that are also everyday words are matched narrowly, to keep false alarms down. A match is still only a candidate for a person to review.

- `later` counts only after a work verb in the same sentence (`fix`, `handle`, `revisit`, `clean up`, `support`, `do`, ...) and only where a clause ends on it (end of line, `,` `.` `;` `:` `!` `?` `)`) or `when`, `once`, `if`, `maybe`, `too`, `again` follows. So `handle the empty case later` and `do it later when we have time` are reported; `try again later`, `retried later`, `3.8 or later`, `no later than Friday` and `support later versions` are not. After `or` and `and` it never counts.
- `fix later` is reported on its own (the single word `later` is not reported a second time). `fix later versions` and `fix later in the file` are not.
- Lowercase `todo` and capitalised `Todo` (first letter only; all-caps `TODO` is a tag) count only in tag form (`todo:`, `todo(`, `todo!`) as the first word of a comment or after a sentence end. `todo list`, `todo.md`, `- todo: bullet`, `"todo: x"`, `my_todo:` and the `todo!()` macro are not. A `todo` or `Todo` with no `:`, `(` or `!` after it is not covered.
- `temporarily` is matched as a whole word, so it also finds plain descriptions such as "temporarily skips the check". Read the line before acting on it.
- `changed` as a history marker is not counted right after `has`, `have`, `had`, `is`, `are`, `be`, `not`, `if`, `whether`, `when`, `until`, `once`, `ever` or `never` (state wording: "if the file has changed"). `fixed-size` and `fixed width` style words are not events either. A history block still needs 9 or more comment lines, with markers on 3 or more of them.

Not covered in English today: `quick hack`, `soon`, `eventually`, `will fix`, and history words other than the three above.

**Output language**: English (default) or Korean. Choose with `--lang en|ko` or the `COMMENT_LINT_LANG` environment variable (`en`, `ko`, or a locale value such as `ko_KR.UTF-8`); the option wins over the variable. Any other value is an argument error (exit 2).

- What changes: the human-readable text only. In the text output that is the label (`[review]` or `[사람 확인]`), the reference label (`ref:` or `근거:`), the messages, the uncertain-reading reasons and the wording of the summary. In `--json` the string values `message`, `reason`, `basis` and `summary.text` follow the language too.
- What never changes: detection (the same lines are found, with the same rule names), JSON keys and structure, `ref`, `excerpt`, exit codes, and the `COMMENT_LINT_SUMMARY`, `READ_ERROR`, `READ_UNCERTAIN`, `DEPS_MISSING` line prefixes. The error lines on stderr (`ARG_ERROR`, `PATH_ERROR`, `NO_FILES_READ`) are English only.
- A script should read the rule name or the JSON keys, not the wording of a message.

## Usage

```text
comment-lint <file|folder>... [--exclude <glob>]... [--exclude-from <list>]
             [--deps <list>] [--json] [--today YYYY-MM-DD] [--lang en|ko]
```

- `--exclude <glob>` (repeatable), `--exclude-from <list file>` (one glob per line, empty lines and `#` lines ignored): matched against the path relative to each input root, case-insensitive, `\` read as `/`. `*` matches within one folder, `**` matches any depth, `?` one character. A matching folder excludes everything under it. When a file is given directly, its folder is the root.
- `--deps <list file>`: a list of files you expect to be read. The summary says how many matched, and each missing entry prints `DEPS_MISSING <entry>`. Missing entries do not change the exit code.
- `--json`: one JSON object instead of text lines.
- `--today`: the date used to decide whether a deadline has passed. A real `YYYY-MM-DD` only. Default: today (local time).
- `--lang en|ko`: output language, default `en`. `COMMENT_LINT_LANG` sets it when the option is absent (see [Languages](#languages)).
- `node_modules` and `.git` are always excluded. Symbolic links (and Windows junctions) are not followed.
- Encodings: UTF-8 (with or without BOM), UTF-16 LE or BE with BOM. Anything else is a read failure.

## Rules

| Rule | Reports |
|---|---|
| `defer-no-basis` | A comment line with a tag or a strong phrase, and no basis in the same paragraph. `XXX` is also a placeholder, so it counts only as the first word of the comment or as `XXX:`, `XXX(`, `XXX!` after a sentence end (`file_XXX.png` is a name). |
| `deadline-passed` | A tag, strong phrase, weak word or workaround next to a date in the past with a deadline marker on the same line. |
| `defer-word` | A weak word with no basis. These words often do not mean "later", so a person decides. |
| `workaround` | `workaround` with no basis. It may describe a real trap in an outside API, which is a comment worth keeping. Inside an identifier (`enable_workaround_flag`) it is not reported. |
| `history-block` | A comment block of 9 or more lines where 3 or more lines carry a history marker. A line counts once. |

A **paragraph** is the run of comment lines between empty comment lines. A **basis** is:

- a URL with a host (`https://example.com/issues/1`; the bare text `"https://"` is not a URL),
- an item ID: `ABC-12`, `PROJ-20240101-SAMPLE-ITEM` (two or more digits), `#12`, `` `#12` ``, `repo#12`,
- a real date in `YYYY-MM-DD`, `YYYY.MM.DD` or `YYYY/MM/DD` form: a future deadline, or a past date without a deadline marker (read as the day it was written).

Not item IDs: technical names of the same shape (`UTF-16`, `SHA-256`, `ISO-8601`, and other prefixes listed in the source), and `#333`-shaped hex colors in CSS files or when the same value is quoted in the file's code.

Deferrals skipped because of a basis are counted in the summary, and `--json` lists each one with the basis it found in `exempt[]`.

## Uncertain reading

Some spots can be read two ways (a `/` after `}` in JS, a `#` right after a number in PowerShell, a heredoc with no end line, an unclosed string, a comment inside a string substitution, ...). The tool takes the likelier reading and goes on, then marks the file: each finding in that file ends with `(file read with uncertainty)` (`(읽기 불확실 파일)` with `--lang ko`) and has `uncertainRead: true` in JSON, and each spot prints `READ_UNCERTAIN <path>:<line>: <reason>`. The aim is that a comment is never missed silently.

## Output and exit codes

Text output: one line per finding, then `READ_ERROR`, `READ_UNCERTAIN`, `DEPS_MISSING` lines, then one `COMMENT_LINT_SUMMARY` line.

`--json` prints `{findings[], readErrors[], readUncertain[], exempt[], depsMissing[], summary{...}}`. A finding is `{path, rel, line, confidence, rule, message, ref, excerpt}`; `message` is in the chosen output language. `confidence` is always `"review"`; `summary.certain` is always 0 (kept for readers of older output).

| Exit | Meaning |
|---|---|
| 0 | Check done, with or without findings |
| 2 | Argument error, missing path, unreadable list file, or no file read (`ARG_ERROR`, `PATH_ERROR`, `NO_FILES_READ` on stderr) |
| 3 | Some files or folders could not be read; the rest of the result is still printed |

Findings never change the exit code. To fail a CI step on findings, check `summary.review` in the JSON output.

## Known limits

Inputs that have to be built on purpose are not promised to be read correctly: line ends of U+2028 or CR alone, escaped CSS `url`, a regex right after `export default`, a variable named `of`, nested substitutions with comments inside, PowerShell arguments after `--%`, `)` inside sh `$(case ... esac)`, an input whose parent folder is a junction. Also out of scope: an unclosed `$(` in sh is not marked uncertain, `**#42**` is not read as a basis, IPv6 URLs are not read as a basis.

## Tests

```sh
node tests/run_tests.mjs [--tool <another comment_lint.mjs>]
```

Each defect input has a clean twin of the same shape. Fixtures are written to a new folder under the system temp folder and removed at the end. The last line is `RESULT pass=N fail=M`; any failure exits 1. Tested on Node.js 24 on Windows.

## License

MIT. See [LICENSE](LICENSE).
