# REA에서 가져올 설계 — 적용 설계서

> 상태: **설계(Design)** · 2026-10-15 · `/sc:design` 산출물 · 대상: gitpervisor (Tauri 2 + React)
> 출처: **morluto/rea v6.5.0 분석(2026-10-15)**에서 나온 적용 후보 6개다. 후보마다 설계안을 쓰고 반론 검토를 거쳤다. 이 문서는 그 둘을 대조해서 최종 판정을 내린다.
> 근거는 이 날짜 기준 코드 실측이고 `파일:줄`로 인용한다. 추정인 곳은 "추정" 또는 "미실측"이라고 적었다.
> 원칙은 하나다. **REA의 장치를 옮기는 게 아니라, 그 장치가 막는 결함이 여기 실제로 있는 곳만 고친다.** 6개 가운데 전면 적용은 없다. 4개는 축소 적용, 2개는 보류다.

| # | 후보 | 판정 | 한 줄 이유 | 규모 |
|---|---|---|---|---|
| 1 | IPC 에러 retryable / remediation / 잘림 continuation | **축소 적용**: `RepoStatus.errorCode` 하나 | 결함은 타임아웃을 문자열로 비교하는 1곳뿐이다. 나머지는 이미 `code` 유니온과 `truncated`로 처리된다 | S |
| 2 | IPC 커맨드 효과 테이블 | **축소 적용**: 잘못 분류된 4건 수정 + `onError` 재조회 | 테이블을 두면 래퍼 선택과 같은 정보를 두 번 적게 된다. 결함은 M2 이전 코드 4줄이다 | S |
| 3 | e2e 드라이버 가드(발견 / 포트 / LPT) | **축소 적용**: 등록 1:1 검사와 ONLY 오타 검사, 포트 필수 | LPT 배분은 이미 있다. 나머지 두 구멍은 지금도 ALL GREEN을 거짓으로 만든다 | S |
| 4 | 결과 status / limitations 계약 | **축소 적용**: git grep 오류를 Err로 올리고 정의 캐시가 실패를 기억하지 않게 | 전역 계약은 필요 없다. 실패가 "없음"으로 바뀌는 곳 몇 개만 관례에 맞춘다 | S~M |
| 5 | 프로세스 간 저장 락 | **보류** | 남은 경쟁은 설치본을 두 번 띄우는 경우뿐이고, 파일 락은 거기서 마지막에 쓴 쪽이 이기는 결과를 바꾸지 못한다 | — |
| 6 | PID 소유권 재검증, Windows Job Object | **보류** | 오발이 나려면 300ms 안에 PID 공간이 한 바퀴 돌아야 한다. Job Object를 쓰면 터미널에서 띄운 GUI 앱이 탭을 닫을 때 같이 죽는다 | — |

검증 강도는 `CLAUDE.md` 「검증 강도는 변경 크기에 맞춘다」를 따른다. 개발 중 e2e 금지 방침에 따라, 아래에서 e2e로 적힌 항목은 **돌리기 전에 사용자에게 묻는다.**

---

## A. `RepoStatus.errorCode`: 타임아웃 판별을 문자열 비교에서 코드 비교로

판정: **축소 적용.** 설계자와 리뷰어 모두 축소를 권했다. retryable과 remediation 필드는 쓸 곳이 없다는 데 둘 다 동의했고, 결함은 한 곳으로 좁혀졌다.

### A.1 문제(근거)

- `src-tauri/src/commands/status.rs:154`의 `Err(e) => return RepoStatus::with_error(project_id, e.message)`는 runner(`git/runner.rs:170/245/322`)가 만든 `ErrorCode::Timeout`에서 **code를 버리고 message만** 담는다.
- 그래서 `src/queries/index.ts:369`는 Rust 번역문(`text_git_net.rs:509-510`)을 두 언어로 문자열 비교한다.
  `s.error?.includes("시간 초과") || s.error?.includes("timed out")`
- 결과: 문구를 고치거나 언어를 하나 늘리면 `keepLastGoodStatuses`가 **조용히 꺼진다.** 그러면 거대 레포 사이드바에 회색 "시간 초과"가 다시 깜빡인다. 컴파일러도 테스트도 이걸 못 본다. 이 함수를 지나는 호출처는 둘(`index.ts:399` 배치, `:428` 보조 창 단건)이라 한 곳만 고치면 둘 다 고쳐진다.
- 부수 효과로 stderr에 "timed out"이 들어간 실제 git 실패를 타임아웃으로 잘못 알고 가리는 경로도 이론상 있다. 다만 git status는 네트워크를 쓰지 않으므로 근거로 내세우지는 않는다.

### A.2 현행: 다시 만들지 않는 것

- `IpcError{code, message, stderr}`(`error.rs:3-55`)의 code마다 "프런트의 다음 행동"이 주석으로 적혀 있다. **code가 이미 remediation 역할을 한다.** 프런트에는 `.code ===` 분기가 34곳 있다.
- 재시도는 `call()`이 `IpcTimeoutError`일 때만 한다(`ipc.ts:1198`). 그래서 retryable bool을 두면 같은 판단이 두 곳으로 나뉜다.
- 잘림은 `truncated`와 `too_large` 필드, `get_log`의 skip 페이징으로 이미 표시된다(`search.rs:34`, `diff.rs:78-95`, `log.rs:23-35` 등). Tauri IPC에는 MCP stdio 같은 응답 예산이 없으므로 continuation도 필요 없다.

### A.3 설계

1. `src-tauri/src/git/types.rs`: `RepoStatus`에 `pub error_code: Option<ErrorCode>`를 추가한다(serde camelCase이므로 TS에서는 `errorCode`). `empty()`에서는 None으로 둔다. `with_error(project_id, code: ErrorCode, message)`처럼 **기존 함수에 인자를 하나 더한다.** 생성자를 새로 만들지 않는다. 호출처 4곳을 컴파일러가 빠짐없이 잡는다.
2. `commands/status.rs`: `:37`과 `:140`은 `NotFound`, **`:154`는 `e.code`**(이 수정의 핵심), `:157`은 `GitError`를 넘긴다.
3. `src/lib/ipc.ts`의 `RepoStatus`(`:41` 근처)에 `errorCode: ErrorCode | null`을 넣는다. CLAUDE.md 규칙대로 **같은 커밋**에서 한다.
4. `src/queries/index.ts:368-369`를 `const timedOut = s.errorCode === "TIMEOUT";`로 바꾸고, `i18n-ok` 주석과 "두 언어를 다 본다" 주석을 지운다.
5. `src/i18n/text-lib.ts:137-138`: "keepLastGoodStatuses 관례와 맞춘다"는 문장을 지운다. 수정 뒤에는 거짓 주석이 되기 때문이다. e2e 48이 접두어로 본다는 문장은 남긴다. 문구 자체는 바꾸지 않는다.

OS 차이는 없다. 타임아웃은 runner가 세 OS에서 같은 경로로 만든다.

### A.4 검증

- `cargo test --lib repo_status_error_code`(`git/types.rs`의 `#[cfg(test)]`): `with_error("p", ErrorCode::Timeout, "x")`를 직렬화하면 `errorCode == "TIMEOUT"`이 나오는지 본다. 이 테스트는 **직렬화 이름 계약만 지킨다.** camelCase나 SCREAMING_SNAKE가 어긋나면 TS와 Rust 양쪽이 다 컴파일을 통과하므로 이 테스트가 그걸 잡는다. `:154`가 code를 넘기는지는 바뀐 시그니처가 컴파일 단계에서 강제한다. 별도 테스트는 두지 않는다.
- `tsc --noEmit`, `cargo check`.

### A.5 위험

- RepoStatus를 손으로 만드는 픽스처가 있으면 `errorCode`가 undefined가 된다. 비교가 `=== "TIMEOUT"`이므로 undefined는 "타임아웃 아님"으로 처리되어 안전하다. `tests/e2e/suites/17-remote-freshness.mjs`가 형태를 단언하는지만 한 번 본다.
- 하지 않는 것: retryable과 remediation 필드(remediation 자유 텍스트는 i18n 카탈로그 규칙과 충돌한다), 응답 continuation, `refreshChangedStatuses`(`events.ts:141-`)에 keepLastGood 적용(동작이 별개다).

**규모 S. 바꿀 파일:** `src-tauri/src/git/types.rs`, `src-tauri/src/commands/status.rs`, `src/lib/ipc.ts`, `src/queries/index.ts`, `src/i18n/text-lib.ts`

---

## B. 재시도 래퍼에 실린 변경 커맨드 4건

판정: **축소 적용(4줄 수정 + `onError` 재조회 2줄, 가드는 넣지 않음).** 테이블이 필요 없다는 데는 설계자와 리뷰어가 같았다. 리뷰어는 래퍼만 바꾸면 응답 유실 때 오히려 나빠진다고 지적했고, 그 지적을 반영했다. 가드는 둘 다 "선택"이라고 했는데, 재발 0건이고 중립 이름을 잡지 못하므로 넣지 않는다.

### B.1 문제(근거)

`src/lib/ipc.ts:1253-1260`의 다음 네 커맨드가 재시도 래퍼 `call`(8초 타임아웃, 최대 3회)을 탄다. 전부 `callMutating`이 생기기 전(M1) 코드다. 규칙(`ipc.ts:1127-1130` 주석)이 생긴 뒤 추가된 `call` 70여 곳에서는 재발이 0건이다.

| 커맨드 | 두 번 실행되면 |
|---|---|
| `create_project_folder` (`projects.rs:160`) | 두 번째 실행이 `AlreadyExists`를 내서 `ProjectList.tsx:294-297`의 `.then(addProject)`가 끊긴다. 폴더는 생기는데(git init 포함) 등록은 안 된다. 같은 이름으로 다시 만들면 같은 에러가 나므로, '프로젝트 추가'로 그 폴더를 직접 등록해야 빠져나온다 |
| `add_project` (`projects.rs:115`) | 성공했는데 `DUPLICATE_PROJECT` 토스트가 뜨고 `selectProject`가 생략된다 |
| `remove_project` (`projects.rs:274`) | 성공했는데 `NOT_FOUND` 토스트가 뜨고 낙관적 제거가 생략되어, 유령 항목이 남는다 |
| `update_project_path` (`projects.rs:209`) | 멱등이라 해는 없다. 이름상 변경 커맨드라 같이 옮긴다 |

데이터 유실은 없다. 결함은 성공을 실패로 보고하는 것과, 수동 복구가 필요한 혼란이다.

### B.2 현행

- `call`(`ipc.ts:1154`): single-flight, 8초, 3회, 동시 8슬롯. `callMutating`(`:1209`): 재시도 없음, 180초, TIMEOUT을 IpcError로 바꾼다.
- `useProjects`는 `staleTime: Infinity`(`queries/index.ts:349`)다. 포커스가 돌아와도 다시 조회하지 않는다.
- `useAddProject.onError`는 `DUPLICATE_PROJECT`일 때만 invalidate한다(`:970-975`). `useRemoveProject.onError`는 토스트만 띄운다(`:1015`).

### B.3 설계

1. `ipc.ts:1253-1260`의 네 줄을 `callMutating`으로 바꾼다. 시그니처가 같으므로 호출처는 그대로 둔다.
2. **`useAddProject`와 `useRemoveProject`의 `onError`에서는 코드와 상관없이 `void qc.invalidateQueries({ queryKey: keys.projects })`를 부른다.** 각각 한 줄이고, `useAddProject`에서는 DUPLICATE 분기를 지운다.
   이유: 래퍼를 바꾸면 응답 유실 상황(Windows WebView2)이 이렇게 된다. 지금은 8초 뒤 재시도가 `DUPLICATE_PROJECT`를 받고 그 김에 목록이 맞춰진다. 바꾼 뒤에는 180초 뒤 `TIMEOUT`이 나는데, 지금의 `onError`는 이 경우 재조회를 하지 않는다. `staleTime: Infinity`까지 겹치면 **추가된 프로젝트가 수동으로 새로고침할 때까지 보이지 않는다.** `callMutating` 주석(`ipc.ts:1207` "실제 결과는 상태 재조회가 진실")이 말하는 계약을 호출처가 실제로 지키게 하는 수정이다.

**하지 않는 것:** 효과 테이블, `mutates` 필드, 3자 일치 검사. 래퍼를 고르는 일이 곧 테이블이다. TS에서 부르는 198개 이름은 모두 등록돼 있다(`lib.rs:1248~`). 이름 오타는 첫 클릭에서 IpcError로 드러나므로 조용한 실패가 아니다.

**소스 스캔 가드(`retryingCall_never_wraps_mutating_commands`)도 넣지 않는다.** 재발 0건이고, 이름 토큰 휴리스틱은 `open_in`이나 `fetch` 같은 중립 이름을 잡지 못해 지키는 범위가 좁다. 재발하면 그때 `lib.rs`의 `no_poison_propagating_unwraps`가 쓰는 공백 접기 방식을 재사용해서 넣는다. 파서는 'call' 바로 뒤의 첫 `(`에서 이름을 뽑는 것으로 충분하고, `seen >= 60` 하한 단언을 같이 둔다.

### B.4 검증

- `tsc --noEmit`.
- 파일을 만들고 지우는 경로이므로 크기와 상관없이 실제 동작을 본다. dev 앱에서 새 프로젝트 폴더 만들기(git init 켬), 등록 제거, 경로 수정을 한 번씩 해 본다. 거짓 에러 토스트가 없어야 하고 목록이 즉시 맞아야 한다.

### B.5 위험

- **single-flight가 사라진다.** `removeProject`를 연타하면 두 번째 호출이 `NOT_FOUND` 토스트를 띄운다. 지금은 `call`이 호출을 합쳐서 우연히 막고 있다. 데이터에는 영향이 없다. 실제로 보이면 그때 버튼 쪽에서 막는다.
- **고아 폴더는 절반만 막는다.** 원인이 8초 초과(느린 디스크, git init, 백신 검사, 세 OS 공통)이면 해결된다. 원인이 응답 유실이면 180초 뒤 TIMEOUT이 나고 고아 폴더는 그대로 남는다. 다만 응답 유실은 "페이지 로드 직후 동시 invoke"에서 일어나고(`ipc.ts:1126`), 사용자가 일으키는 단발 호출에서는 드물다. 범위는 늘리지 않는다.
- 실패 토스트가 뜨기까지 8초 대신 최대 180초 걸린다. 그 사이에도 재조회가 목록을 맞춘다.
- 범위 밖에서 관찰한 것(고치지 않음): `App.tsx:134`과 `FloatingTerminal.tsx:180`이 맨 `invoke`를 직접 부른다. 재시도가 없으므로 두 번 실행될 위험은 없다.

**규모 S. 바꿀 파일:** `src/lib/ipc.ts`, `src/queries/index.ts`

---

## C. e2e 러너: 조용히 안 도는 스위트와 남의 앱에 붙는 경로

판정: **축소 적용(a 등록·오타 검사, b 포트 필수. c LPT·시간 기록기는 하지 않음).** 설계자와 리뷰어가 같은 축소안을 권했다. 리뷰어가 짚은 위치(pickShard 뒤), 빠진 안내 문구, 기록기 생략을 반영했다.

### C.1 문제(근거)

- **(a) 등록하지 않은 스위트는 영영 돌지 않는다.** 스위트 등록처는 `tests/e2e/run.mjs:18-95`의 손으로 쓴 `SUITES` 배열 하나뿐이다. 지금은 디스크 64개와 배열 64개가 우연히 1:1이다. 새 파일을 배열에 넣는 걸 잊으면 회차는 ALL GREEN으로 끝난다. 반대 방향(배열에는 있는데 파일이 없음)은 `:545-551`이 이미 잡는다.
- **(a′) ONLY 오타가 ALL GREEN을 만든다.** `run.mjs:533`의 filter에 `GPV_E2E_ONLY=255`처럼 오타를 내면 0개가 나오고, 스위트 없이 teardown 검사만 통과해 ALL GREEN이 된다. CLAUDE.md가 권하는 `GPV_E2E_ONLY=<n> node tests/e2e/shard.mjs 1`이 가장 자주 밟는 길이다.
- **(b) 포트를 안 주면 스캔한다.** 2026-09-16 사고 때 맨 `run.mjs`가 `cdp.mjs:20` SCAN_PORTS를 스캔해 남의 dev 앱에 픽스처를 심었다. `shard.mjs`는 언제나 포트를 준다(`:532`). 남은 구멍은 맨 `run.mjs`이고, 이것을 `package.json:24` `test:e2e`와 `tests/e2e/README.md:10-17`(CLAUDE.md가 금지한 `npm run tauri dev`까지 권한다)이 아직 안내하고 있다.

### C.2 현행: 다시 만들지 않는 것

- LPT 배분: `run.mjs:161-211` `pickShard`(그리디 LPT, `GLOBAL_RESOURCE`를 1번 샤드에 고정, `CHAINS` 덩어리째 이동, 결정적 동점 처리).
- 계획 대비 실제 배수 출력: `shard.mjs:556-590`. 스위트별 초: `report.mjs:72-75`가 각 샤드 로그에 찍는다.
- ws 호스트 덮어쓰기: 디스커버리는 늘 `127.0.0.1`을 친다(`cdp.mjs:26`). REA가 막는 위협(사용자가 입력한 원격 엔드포인트)이 여기엔 없다.

### C.3 설계

새 파일, 새 스크립트, 면제 목록은 만들지 않는다. `node:fs`만 쓰므로 세 OS에서 같다.

① **`run.mjs` main, `pickShard` 호출 뒤(`:535` 이후)에 둔다.** 샤드 판정은 pickShard의 결과를 그대로 쓰고, 정규식으로 다시 파싱하지 않는다.
```js
if (!shard || shard.index === 1) {           // 샤드 N개가 같은 실패를 N번 찍지 않게
  const onDisk = readdirSync(new URL("./suites/", import.meta.url))
    .filter((n) => n.endsWith(".mjs")).map((n) => `./suites/${n}`);
  const unregistered = onDisk.filter((p) => !SUITES.includes(p));
  const unmatched = only.filter((o) => !SUITES.some((p) => p.includes(`/${o}-`)));
  report.suite("(러너 자체 검사)");
  report.check("suites/ 의 모든 파일이 SUITES 에 등록돼 있다", !unregistered.length,
    unregistered.length ? `미등록=[${unregistered.join(", ")}] — run.mjs SUITES 에 넣어라` : "");
  if (only.length) report.check("GPV_E2E_ONLY 의 번호가 모두 스위트와 맞는다", !unmatched.length,
    unmatched.length ? `맞는 스위트 없음=[${unmatched.join(",")}]` : "");
}
```
- 실패는 throw가 아니라 `report.check`로 남긴다. 회차는 끝까지 돌고 종료 코드는 1이 된다.
- "샤드에 0개 배정"으로 판정하지 않는다. ONLY와 여러 샤드를 함께 쓰면 빈 샤드가 정상이기 때문이다.

② **포트 필수.** `run.mjs`의 `cdp = await connect()`(`:450`) 바로 앞에 둔다.
```js
if (!process.env.GPV_E2E_PORT) throw new Error(
  "GPV_E2E_PORT 가 없습니다 — 스캔으로 붙으면 남의 dev 앱에 픽스처를 심는다(2026-09-16). " +
  "새 앱으로: node tests/e2e/shard.mjs 1 · 떠 있는 내 앱으로: GPV_E2E_PORT=<포트> node tests/e2e/run.mjs");
```
- 이 장치가 막는 것은 **포트를 명시하지 않았을 때의 스캔 경로뿐이다.** `GPV_E2E_PORT=29222`를 쳤는데 그 포트에 남의 앱이 떠 있으면 여전히 거기에 붙는다. 그 경우까지 막는 장치는 만들지 않는다.
- cdp가 undefined인 채로 throw하므로 `finally`는 summary를 찍지 않는다. 결과는 콘솔의 치명적 오류 한 줄과 exit 1이고, 그것으로 충분하다.
- `cdp.mjs`의 스캔은 그대로 둔다. `tests/bench/*`가 수동 도구로 쓰고 있고, 이 도구들은 픽스처를 심지 않는다.
- 같은 커밋에서 안내 문구를 맞춘다:
  - `package.json:24` `test:e2e`를 `node tests/e2e/shard.mjs`로 바꾼다.
  - `tests/e2e/README.md:10-17`은 shard.mjs를 기본으로, 포트를 준 run.mjs를 떠 있는 내 앱용으로 안내한다. `npm run tauri dev`는 지운다.
  - `run.mjs:3-8` 머리 주석의 "포트 9222"를 고친다.
  - `suites/61-pdf.mjs:45`를 `GPV_E2E_ONLY=61 node tests/e2e/shard.mjs 1`로 고친다.
  - DOCS의 옛 설계서(`aggregate-window-redock-memo-design.md:355`)는 기록물이므로 그대로 둔다.

③ **시간 기록기는 만들지 않는다.** `run.mjs:97` 주석은 "`GPV_E2E_WRITE_TIMES=1`로 갱신된다"고 하지만 구현이 없다. 이 주석을 "전체 샤드 회차 로그의 스위트별 초를 보고 손으로 갱신"으로 사실대로 고친다. 표에서 빠진 8개 키(54·64~70)는 다음 전체 회차 때 손으로 채운다. 54는 `GLOBAL_RESOURCE`라 배분에 영향이 없고, 나머지는 20초로 가정될 뿐 회차의 정합성과는 무관하다(`run.mjs:97-98`). 기록기를 두면 실패한 회차나 느린 회차의 시간까지 병합되어 표가 오염된다.

### C.4 검증

조용히 실패하던 결함을 막는 가드이므로 **변이 검증을 한 번 한다.** 실행 전에 사용자에게 묻는다.
- `SUITES`에서 `"./suites/63-encoding.mjs"`를 임시로 빼고 `GPV_E2E_ONLY=01 node tests/e2e/shard.mjs 1`을 돌린다. `미등록=[./suites/63-encoding.mjs]` FAIL과 exit 1이 나와야 하고, 되돌리면 초록이어야 한다.
- `GPV_E2E_ONLY=999 node tests/e2e/shard.mjs 1`은 `맞는 스위트 없음=[999]` FAIL이 나와야 한다. **지금은 이 명령이 ALL GREEN이다.**
- `GPV_E2E_ONLY=01 node tests/e2e/shard.mjs 3`이면 자체 검사가 샤드 1에서만 한 번 찍혀야 한다.
- 포트 없이 `node tests/e2e/run.mjs`를 돌리면 연결을 시도하지 않고 즉시 exit 1이 나와야 한다.

### C.5 위험

- 포트 없이 `npm run test:e2e`를 치던 흐름은 이제 드라이버가 직접 빌드하고 앱을 띄우는 쪽으로 바뀐다. 첫 회차가 몇 분 길어지는데, 의도한 대가다.
- 앞으로 일부러 등록하지 않는 초안 스위트가 생기면 그때 면제 목록을 추가한다. 지금은 0개다.

**규모 S. 바꿀 파일:** `tests/e2e/run.mjs`, `package.json`, `tests/e2e/README.md`, `tests/e2e/suites/61-pdf.mjs`

---

## D. 코드 내비게이션: 실패를 "없음"으로 바꾸지 않는다

판정: **축소 적용.** 전역 status/limitations 계약은 만들지 않는다. 리뷰어의 major 셋을 반영했다: 프런트 `console.warn`이 로그에 남지 않는 문제, A와 C를 합쳤을 때 캐시가 반복 실행되는 회귀, 8초 대 10초 타임아웃 역전. QuickPick 오류 상태는 뺀다.

### D.1 문제(근거)

1. **git grep 실패가 빈 결과가 된다.** `commands/tree.rs`의 `find_definition`(`:1086-1088`), `find_symbols`(`:1214-1216`), `find_references`(`:1446-1454`)가 `run_git`의 Err(10초 타임아웃, git 없음, spawn 실패)를 `Ok(Vec::new())`로 바꾼다. exit code 검사도 없다. 그래서 저장소가 아닌 프로젝트(exit 128)나 PCRE가 없는 git의 `-P` 실패도 "정의 없음"으로 나온다. 같은 저장소의 `search.rs:96-104`는 exit 1과 exit 2 이상을 이미 구분한다.
2. **정의 캐시가 실패를 세션 내내 기억한다.** `src/components/diff/goto-definition.ts:69-71`의 `.catch(() => [])`가 만든 Promise가 그대로 캐시에 들어간다. 예열이 한 번 실패하면 그 심볼은 Ctrl+클릭과 호버에서 계속 "없음"이다. 캐시는 800개를 넘을 때만 비워진다.
3. **타임아웃이 역전돼 있다.** 이 문제를 직접 부르는 원인이다. `findDefinition`(`ipc.ts:1484-1489`)과 `findReferences`(`:1499-1500`)는 기본값(8초, 3회)을 쓰는데 백엔드 `READ_TIMEOUT`은 10초다(`runner.rs:10`). 8~10초 걸리는 grep은 늘 프런트에서 먼저 타임아웃이 나고, 같은 git grep을 겹쳐서 다시 띄운 끝에 최대 24초 뒤 reject된다.
4. **참조 찾기 실패와 "0개"가 구분되지 않는다**(`find-references.ts:56-59`).
5. **Quick Open이 "일치 없음"을 보여 준다.** `list_repo_files`(`tree.rs:670-701`)는 `error` 필드가 있는데도 exit code를 보지 않는다. 또 프런트 쿼리가 실패하면 `QuickOpenHost.tsx:160`이 loadingFiles를 계속 띄운다.
6. **워처 실패가 기록되지 않는다.** `watcher.rs:54/109/120/126`이 `eprintln!`을 쓰는데 Windows 릴리스(`windows_subsystem = "windows"`)에서는 stderr가 버려진다. inotify 한도 같은 부분 실패는 `:269` `.filter(|..| d.watch(..).is_ok())`에서 아무 흔적 없이 사라진다.

### D.2 현행: 다시 만들지 않는 것

`RepoStatus.error`/`fetch_error`, disk_scan의 `skipped`/`truncated_files`, `SearchResult.truncated`, 참조 찾기의 `truncated` 토스트, `RepoFileList.truncated`/`error`, `read_dir_raw`의 IpcError, 인코딩 저장 전 거절은 이미 "없음"과 "확인 불가"를 구분한다. 남은 구멍은 이 관례를 따르지 않는 위의 몇 곳뿐이다.

### D.3 설계

**① exit code 판정을 헬퍼 하나로 모은다**(`commands/search.rs`). `:96-104`를 꺼낸다.
```rust
pub(crate) fn grep_output_or_error(repo: &str, out: runner::GitOutput) -> Result<runner::GitOutput, IpcError> {
    if matches!(out.code, 0 | 1) { return Ok(out); }        // -1(신호로 종료)도 오류로 본다
    log::warn!("[grep] {repo} code={} {}", out.code, out.stderr.trim());
    let msg = if out.stderr.trim().is_empty() { text_tools::search_failed().to_string() } else { out.stderr.trim().to_string() };
    Err(IpcError::new(ErrorCode::GitError, msg))
}
```
- 조건을 `out.code > 1`에서 `!matches!(code, 0|1)`로 바꾼다. 지금은 `runner.rs:188`이 신호로 죽은 프로세스를 `-1`로 만드는데, 이 값이 "매치 없음"으로 통과한다.
- 로그를 여기서 남기면 정의 찾기, 심볼 검색, 참조 찾기, 전역 검색 네 경로가 한 곳에서 `Gitpervisor.log`에 기록된다. 프런트 `console.warn`은 로그 파일로 가지 않으므로(`logging.ts:14-26`은 window error와 unhandledrejection만 보낸다) 쓰지 않는다.
- `search_in_project`도 이 헬퍼를 쓴다. 바뀌는 동작은 -1뿐이다.
- `tree.rs`의 세 곳은 `let out = grep_output_or_error(&repo, runner::run_git(...).await?)?;`로 바꾸고 `Err(_) => return Ok(..)`를 지운다.
- `find_module_files`(`:1520`)는 그대로 둔다. grep이 성공한 뒤에 도는 보조 후보라서 실패해도 주 결과를 가리지 않는다. 그 이유를 위에 한 줄 주석으로 남긴다.
- 문서 주석 `tree.rs:1045`(ripgrep을 git grep으로), `:1161`, `:1418`의 "조용히 빈 결과"를 새 동작에 맞게 고친다.

**② 타임아웃 역전을 바로잡는다**(`ipc.ts`). `findDefinition`과 `findReferences`에 `searchInProject`와 같은 관례로 `{ timeoutMs: 12_000, attempts: 1 }`을 준다. 그러면 백엔드 Timeout이 Err로 정상적으로 올라온다.

**③ 정의 캐시에는 일시적 실패를 남기지 않는다**(`goto-definition.ts:69-71`).
```ts
p = ipc.findDefinition(ctx.projectId, symbol, ctx.ext, lane).catch((e) => {
  // 타임아웃은 다음 조회에서 다시 시도한다. git 이 확정적으로 거절한 경우(GIT_ERROR: not a repo·PCRE 없음)는
  // 다시 띄워도 결과가 같고 프로세스 비용만 반복되므로 캐시에 둔다.
  if (!(isIpcError(e) && e.code === "GIT_ERROR") && cache.get(key) === p) cache.delete(key);
  return [];
});
```
- `cache.get(key) === p` 검사가 필요한 이유: `cache.clear()` 뒤에 같은 키로 새 Promise가 들어갔는데 늦게 도착한 catch가 그 새 항목을 지우면 안 된다.
- 토스트는 띄우지 않는다. Monaco가 호버 중에 provider를 반복해서 부르므로 토스트가 쏟아진다.

**④ 참조 찾기 실패를 알린다**(`find-references.ts:56-59`). Shift+F12는 사용자가 명시적으로 한 번 누르는 동작이라 토스트 한 번이면 된다. `pushToast("error", currentMessages().git.editorProviders.referencesFailed(msg))`를 띄우고 빈 결과를 돌려준다. 문구는 `text-git.ts`에 한국어와 영어로 둔다.

**⑤ `list_repo_files`와 Quick Open**
- `tree.rs:678`의 Ok 분기 맨 앞에서 `out.code != 0`이면 `error: Some(stderr.trim())`를 채운다. 필드가 이미 있으므로 TS 타입은 바뀌지 않는다.
- `QuickOpenHost.tsx:160`을 한 줄로 고친다: `emptyText={lists?.find((l) => l.projectId === selectedProjectId)?.error ?? (lists ? noMatches : isError ? <오류 문구> : loadingFiles)}`. 오류 문구는 카탈로그에 둔다.
- `QuickPick.tsx`의 오류 상태는 만들지 않는다. Quick Open의 source는 동기라서 효과가 없고, 심볼 검색 실패는 ①의 로그로 남는다.

**⑥ 워처 로그**
- `watcher.rs`의 `eprintln!` 네 곳(`:54/109/120/126`)을 `log::warn!`으로 바꾼다.
- `apply_watches`(`:269`)는 실패 개수를 세고, 첫 에러 하나를 `log::warn!("[watcher] {n}개 감시 실패, 첫 오류 {path}: {e}")`로 한 번 남긴다.
- UI 배너는 만들지 않는다.

OS 차이: git 실행은 세 OS 공통 경로(`runner::run_git_env`)를 탄다. **macOS는 실기 확인이 필요하다.** Finder나 launchd로 띄우면 `find_git`(`runner.rs:82-105`)이 `/usr/bin/git`을 고를 수 있다. 그 git에 PCRE가 없으면 `find_definition`과 `find_symbols`(`-P`)가 통째로 실패한다(미실측). 이 변경은 그 실패를 로그와 오류 문구로 드러낼 뿐 고치지는 않는다. 설치본 로그에 `[grep] ... Perl-compatible` 줄이 보이면 그때 `-P` 폴백을 따로 설계한다.

### D.4 검증

- `cargo test --lib grep_output_or_error`(`search.rs`의 `#[cfg(test)]`): code 0과 1(빈 stdout)은 Ok, code 128(`fatal: not a git repository`)과 **-1**은 Err이고 message에 stderr가 들어가는지 본다.
- `cargo test --lib code_nav_commands_route_through_grep_helper`(`lib.rs` 소스 스캔, `no_poison_propagating_unwraps`가 본보기): `tree.rs`의 `find_definition`, `find_symbols`, `find_references` 본문에 각각 `grep_output_or_error(`가 **들어 있는지** 단언한다. "Err(_) => return Ok(가 없음"처럼 부재를 보는 검사는 `.ok()`나 `if let Ok`로 다시 삼키면 통과하므로 쓰지 않는다. 반증: 지금 코드에서는 3건이 빨갛다.
- `tsc --noEmit`.
- 관련 e2e 10(codenav, "없는 심볼"은 exit 1 경로라 초록이어야 한다), 23(symbol-search), 66(i18n 새 문구). 실행 전에 묻는다.
- 실제 동작: dev 앱에서 저장소가 아닌 프로젝트로 Ctrl+P를 누르면 "일치 없음" 대신 git의 not-a-repo 메시지가 보여야 한다.
- 캐시를 CDP로 반증하는 절차는 생략한다. ③은 눈에 보이는 몇 줄이고, 조건 두 개는 리뷰로 확인된다.

### D.5 위험

- **동작이 바뀐다.** 저장소가 아닌 프로젝트(일부러 등록한 Downloads 등)에서 Shift+F12 토스트와 Quick Open 오류 문구가 새로 보인다. 문구는 git stderr 원문(영어)이다. 거슬리면 not-a-repo일 때만 i18n 문구로 바꾼다.
- GitError는 `call`의 재시도 대상이 아니므로(`ipc.ts:1198`은 `IpcTimeoutError`만 재시도한다) 재시도가 늘지 않는다.
- 예열의 동시성 2와 최대 20심볼 제한(`goto-definition.ts:85-107`)은 그대로라 git 부하는 커지지 않는다.

**규모 S~M. 바꿀 파일:** `src-tauri/src/commands/search.rs`, `src-tauri/src/commands/tree.rs`, `src-tauri/src/watcher.rs`, `src-tauri/src/lib.rs`(스캔 테스트), `src/lib/ipc.ts`, `src/components/diff/goto-definition.ts`, `src/components/diff/find-references.ts`, `src/components/quickopen/QuickOpenHost.tsx`, `src/i18n/text-git.ts`

---

## 보류

### E. 프로세스 간 저장 락: 왜 안 하는가 → 대신 single-instance 적용(2026-10-15)

- 데이터 폴더를 둘이 같이 쓰는 경로는 이미 막혀 있다. dev와 설치본은 identifier가 갈라져 있고(`tauri.dev.conf.json`), e2e 샤드는 샤드마다 `GPV_DATA_DIR`을 받는다(`shard.mjs:494`). 설치본 identifier에 e2e 환경변수가 붙으면 exit 3이다(`lib.rs:1076-1083`). 남은 경우는 **설치본을 두 번 띄우는 것** 하나인데 사고 기록은 없다.
- 각 프로세스는 디스크를 다시 읽지 않고 자기 **메모리 사본 전체**를 쓴다. 파일을 읽어서 고쳐 쓰는 일은 부팅 때 한 번뿐이다(`lib.rs:1217`). 그래서 `File::lock`은 순서만 정할 뿐 마지막에 쓴 쪽이 이기는 결과는 그대로다. mtime 검사는 오래 열어 둔 쪽이 영원히 저장을 거부당하는 새 실패를 만든다. 두 번 띄웠을 때의 진짜 피해(session.json 오진, remote fetch 이중 실행, 터미널 이중 복원)는 파일 락으로 하나도 막지 못한다.
- `SAVE_LOCK`(`state.rs:146`)은 파일 쓰기를 직렬화할 뿐이다. 메모리에서 디스크로 반영되는 순서는 보장하지 않는다(예: `settings.rs:28-30`과 `llm/server.rs:528-530`의 경합). 그 영향은 다음 부팅에서 Vulkan을 한 번 더 시도하는 정도라 무시한다.
- **적용(사용자 지시, 2026-10-15):** 파일 락 대신 `tauri-plugin-single-instance`를 첫 플러그인으로, 릴리스 빌드에만 단다(`lib.rs` `run()`). 저장마다 비용이 드는 락과 달리 두 번째 실행을 시작 시점에 첫 창으로 넘기고 끝내므로, 위의 진짜 피해(세션 오진·fetch 이중·터미널 이중 복원)까지 한 번에 막는다. 디버그를 빼는 이유는 e2e 샤드가 `.dev` identifier로 앱 여럿을 일부러 나란히 띄우기 때문이다.
- 업데이트 재실행: 플러그인은 `RunEvent::Exit`에서 잠금을 푼다(`tauri-plugin-single-instance-2.4.5/src/platform_impl/*.rs`). `relaunch()`는 그 뒤에 exec 하고, Windows NSIS는 프로세스를 끝낸 뒤 새로 띄우므로 막히지 않는다. **macOS·Linux 실기는 미확인**이다(Windows 릴리스 exe 두 번 실행만 확인).

### F. PID 소유권 재검증과 Windows Job Object: 왜 안 하는가

- 세션은 맵에서 꺼낸 뒤에 `terminate_tree`가 돌므로(`terminal.rs:595/636/466-473`), 유예 중에 리더가 셸을 회수할 수는 있다. 그래도 오발이 나려면 **첫 스냅샷과 마지막 SIGKILL 사이 300ms 안에**(`:709-728`) PID 공간이 한 바퀴 돌아야 한다. 커널은 pgid와 sid로 쓰이는 번호를 재할당하지 않는다. PID를 저장했다가 나중에 kill하는 경로도 없다. REA의 run token이 필요한 전제(기록해 둔 소유권을 나중에 다시 찾아가 정리하는 것)가 여기엔 없다.
- Windows Job Object는 portable-pty의 생성 플래그가 고정돼 있어서(`psuedocon.rs:142`) spawn 직후에 붙여야 하고, `TerminateJobObject`는 터미널에서 띄운 GUI 앱(`code .`, `start`)까지 죽인다. 사용자에게 보이는 퇴행이다. Windows PTY 자손이 누수된 실측 기록도 없다.
- 다시 검토할 계기: 유예가 초 단위로 늘거나, PID를 저장했다가 kill하는 경로가 생길 때. 그때는 Linux에서만 `proc_stat`의 starttime(필드 [19])으로 거른다.
- 문서 정정만 한다. `DOCS/process-leak-postmortem.md:303`은 "/proc/<p>/stat 재확인으로 완화"라고 적었지만 코드에는 없다. 이 줄을 "재확인 없음 — 스냅샷과 SIGKILL 사이 ≤300ms, 커널이 쓰이는 pgid·sid 번호를 예약"으로 고친다. `terminal.rs`에는 주석을 달지 않는다. 특히 "맵에 있는 동안 회수 안 됨"은 틀린 불변식이므로 어디에도 적지 않는다.

---

## 구현 순서(커밋 단위)

| 순서 | 커밋 | 검증 등급 | 돌릴 것 |
|---|---|---|---|
| 1 | `RepoStatus.errorCode`로 타임아웃 판별(A) | **작은 것** | `cargo test --lib repo_status_error_code` · `cargo check` · `tsc --noEmit` |
| 2 | 프로젝트 변경 커맨드 4건을 `callMutating`으로, `onError`는 늘 재조회(B) | **보통**(파일을 만들고 지우는 경로라 크기와 상관없이 실동작 확인) | `tsc --noEmit` · dev 앱에서 폴더 생성(git init), 제거, 경로 수정 각 1회 |
| 3 | e2e 러너: 등록 1:1, ONLY 오타, 포트 필수, 안내 문구(C) | **작은 것** + 변이 검증 1회(조용히 실패하던 결함) | C.4의 네 명령. 실행 전에 사용자에게 묻는다 |
| 4 | git grep 헬퍼, 타임아웃 역전, 정의 캐시, 참조 토스트, Quick Open 오류, 워처 로그(D) | **보통** | `cargo test --lib grep_output_or_error` · `code_nav_commands_route_through_grep_helper` · `tsc --noEmit` · e2e 10·23·66(묻고 나서) · 비 git 프로젝트 Ctrl+P 실동작 |
| 5 | 문서 정정: `DESIGN.md:72` single-instance 삭제, `process-leak-postmortem.md:303` 사실대로(E·F) | **작은 것** | 없음 |

- 커밋 1과 2는 둘 다 `ipc.ts`를 건드린다. 그래도 타입 한 줄과 래퍼 네 줄이라 "공유 경로" 등급(전체 e2e)으로 올리지 않는다. 래퍼 로직(`runCall`, `callMutating` 본체)은 바꾸지 않는다.
- 커밋 4가 30분을 넘기면 ④(참조 토스트)와 ⑤(Quick Open)를 다음 커밋으로 떼어 낸다. ①~③이 핵심 결함이다.
- 선택: CLAUDE.md의 "양쪽이 파일 통째로 read-modify-write 한다"는 실제로는 "각자 메모리 사본 전체를 덮어쓴다"이다. 고칠지는 사용자가 정한다.