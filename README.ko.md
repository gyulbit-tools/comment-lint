# comment-lint

아무도 다시 돌아오지 않을 `TODO`를 찾아요. 이슈 링크, 항목 ID, 날짜 없이 일을 미루는 주석, 이미 지난 기한, 변경 기록처럼 길어진 주석 블록을 찾아 알려 줘요.

[English README](README.md)

```sh
npm install -g github:OWNER/comment-lint
```

설치하지 않고 쓰려면 저장소를 받아 `node comment_lint.mjs`로 실행해요. Node.js만 있으면 돼요(의존성 없음).

## 예시

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
$ comment-lint src --lang ko --today 2026-11-18
/work/project/src/app.py:2: [사람 확인] defer-no-basis: 미루는 주석의 표지(TODO)가 있고 근거(URL, 항목 ID, 날짜)가 없다 | 근거: README rules: defer-no-basis | # TODO: handle empty files
/work/project/src/app.py:5: [사람 확인] deadline-passed: 미루는 주석의 기한 2024-06-30이 지났다(FIXME) | 근거: README rules: deadline-passed | # FIXME: remove by 2024-06-30
/work/project/src/app.py:6: [사람 확인] defer-word: 미루는 뜻일 수 있는 낱말(for now), 근거 없음 | 근거: README rules: defer-word | # for now, no caching
COMMENT_LINT_SUMMARY 읽은 파일 1, 건너뛴 파일 0, 제외 폴더 0(기본 0) 파일 0, deps 미지정, 발견 3, 근거 있어 넘긴 미루는 주석 1, 읽기 실패 0, 읽기 불확실 0
```

4행은 `#42`가 근거라서(누군가 추적하고 있어서) 내지 않아요. 5행은 날짜가 있지만 기한이 지나서 내요. `--lang ko`를 빼면 같은 결과가 영어 문구로 나와요(기본값은 영어).

## 하는 일과 하지 않는 일

- 보고만 해요. 파일을 쓰거나, 이름을 바꾸거나, 지우지 않아요. 모든 발견은 사람이 보고 판단할 후보예요. 무엇을 고칠지는 정하지 않아요.
- 주석만 봐요. 문자열, 템플릿 리터럴, 정규식 리터럴, heredoc, here-string 안의 글은 주석이 아니에요.
- 주석이 지금 코드와 맞는지는 보지 않아요.

## 지원 언어

**소스 언어**(읽을 수 있는 주석 문법): `.py`(`#`, 문장 하나로 선 세 따옴표 문자열), `.js`, `.mjs`, `.cjs`, `.ts`(`//`, `/* */`), `.ps1`(`#`, `<# #>`), `.sh`(낱말 첫머리의 `#`), `.css`(`/* */`). 그 밖의 파일은 건너뛰고 요약에 수만 적어요. JSX는 맞게 읽는다고 약속하지 않아요.

**표지 언어**(주석에서 찾는 낱말): 영어와 한국어.

| 규칙 | 영어 | 한국어 |
|---|---|---|
| 표지 | `TODO`, `FIXME`, `HACK`, `XXX`(대문자만) | 같은 표지 |
| 강한 문구 | `temporary fix`(대소문자 무관) | 임시 처리, 나중에 고친다/고침/고치기/고칠 |
| 약한 낱말 | `for now`, `temporarily`, `fix later`(대소문자 무관). `later`, `todo`, `Todo`는 아래의 좁은 형태만 | 임시로, 일단, 추후, 당분간 |
| workaround | `workaround`, `work-around`, `work around`, 복수형 | 없음 |
| 기한 표지 | 날짜 앞 `until`, `by`, `deadline`, `due`, `before` | 날짜 뒤 까지, 전까지, 기한, 마감, 전에 / 날짜 앞 기한, 마감 |
| 경위 표지 | 날짜(`YYYY-MM-DD`), `changed`, `fixed`, `reverted`(대소문자 무관) | 날짜, 정정, 종전, 라운드, 옛 판 |

일상어이기도 한 영어 약한 낱말은 오탐을 줄이려고 좁게 찾아요. 걸린 것은 여전히 사람이 볼 후보일 뿐이에요.

- `later`는 같은 문장에 일을 뜻하는 동사(`fix`, `handle`, `revisit`, `clean up`, `support`, `do` 등)가 앞서 있고, 그 낱말에서 절이 끝날 때(줄 끝, `,` `.` `;` `:` `!` `?` `)`)나 `when`, `once`, `if`, `maybe`, `too`, `again`이 뒤따를 때만 찾아요. `handle the empty case later`, `do it later when we have time`은 찾고, `try again later`, `retried later`, `3.8 or later`, `no later than Friday`, `support later versions`는 안 찾아요. `or`, `and` 바로 뒤의 `later`는 찾지 않아요.
- `fix later`는 따로 한 번만 내요(낱말 `later`가 또 나오지 않아요). `fix later versions`, `fix later in the file`은 안 찾아요.
- 소문자 `todo`와 첫 글자만 대문자인 `Todo`는(전부 대문자인 `TODO`는 표지) 표지 형태(`todo:`, `todo(`, `todo!`, `Todo:` 등)이고 주석의 첫 낱말이거나 문장 끝 뒤일 때만 찾아요. `todo list`, `todo.md`, `- todo: bullet`, `"todo: x"`, `my_todo:`, `todo!()` 매크로는 안 찾아요. `:`, `(`, `!`가 안 붙은 `todo`는 아직 못 찾아요.
- `temporarily`는 낱말 하나로 찾아서 "temporarily skips the check" 같은 단순 설명도 걸려요. 줄을 읽고 판단하세요.
- 경위 표지 `changed`는 `has`, `have`, `had`, `is`, `are`, `be`, `not`, `if`, `whether`, `when`, `until`, `once`, `ever`, `never` 바로 뒤에서는 세지 않아요("if the file has changed" 같은 상태 표현). `fixed-size`, `fixed width` 같은 말도 사건이 아니에요. 경위 블록은 여전히 주석 9줄 이상에 표지가 3줄 이상 있어야 해요.

영어에서 아직 못 찾는 것: `quick hack`, `soon`, `eventually`, `will fix`, 위 세 낱말 밖의 경위 낱말.

**출력 언어**: 영어(기본)와 한국어. `--lang en|ko` 옵션이나 환경변수 `COMMENT_LINT_LANG`(`en`, `ko`, `ko_KR.UTF-8` 같은 로캘 값)으로 골라요. 옵션이 환경변수보다 먼저예요. 다른 값은 인자 오류(종료 2)예요.

- 바뀌는 것: 사람이 읽는 문구뿐이에요. 텍스트 출력에서는 라벨(`[review]` 또는 `[사람 확인]`), 참조 라벨(`ref:` 또는 `근거:`), 메시지, 읽기 불확실 사유, 요약 줄의 문구예요. `--json`에서는 문자열 값 `message`, `reason`, `basis`, `summary.text`가 언어를 따라가요.
- 바뀌지 않는 것: 탐지(같은 줄을 같은 규칙 이름으로 찾아요), JSON 키와 구조, `ref`, `excerpt`, 종료 코드, `COMMENT_LINT_SUMMARY`, `READ_ERROR`, `READ_UNCERTAIN`, `DEPS_MISSING` 줄 머리예요. stderr의 오류 줄(`ARG_ERROR`, `PATH_ERROR`, `NO_FILES_READ`)은 영어만 있어요.
- 스크립트는 메시지 문구가 아니라 규칙 이름이나 JSON 키를 읽어야 해요.

## 사용법, 규칙, 출력

옵션(`--exclude`, `--exclude-from`, `--deps`, `--json`, `--today`, `--lang`), 규칙 표, 근거로 보는 것, 읽기 불확실, 종료 코드(0 완료, 2 인자 오류나 읽은 파일 0개, 3 일부 읽기 실패), 알려진 한계는 [README.md](README.md)에 있어요. 발견 수는 종료 코드를 바꾸지 않아요. CI에서 발견이 있으면 실패시키려면 `--json`의 `summary.review`를 보세요.

## 시험

```sh
node tests/run_tests.mjs
```

마지막 줄은 `RESULT pass=N fail=M`이고, 실패가 있으면 종료 1이에요. Windows의 Node.js 24에서 시험했어요.

## 라이선스

MIT. [LICENSE](LICENSE)를 보세요.
