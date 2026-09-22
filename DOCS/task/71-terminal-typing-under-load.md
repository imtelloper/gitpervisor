# 태스크 71 — 어떤 부하에서도 터미널 타이핑이 밀리지 않게

**요구(사용자, 2026-09-21)**: "그 어떤 일이 있어도 터미널 세션에서 타이핑은 정상적으로 입력돼야 한다."
발단: 오전에 GPU 97%(상태바)일 때 Claude 세션 타이핑이 렉. 그 시각 설치본은 v0.9.0이라 `[term-perf]`가
없어 로그로 원인을 못 갈랐다. 그래서 **부하 종류별로 dev 앱에서 재현해 무너지는 곳만** 고쳤다.

## 1. 부하별 실측 (dev 앱, pwsh 에코, 0.12초 간격 타이핑)

지표: `parse` = 키→에코 파싱(= `[term-perf] echo`), `frame` = 키→에코가 그려진 뒤 다음 rAF(화면에 나간 시점).
값은 p50/p90/max(ms). 스크립트는 세션 스크래치패드의 `gpu-lag-probe.mjs`·`stress-probe.mjs`·`profile-flood.mjs`.

| 부하 | 결과 | 판정 |
|---|---|---|
| **GPU 98~100%** (llama-bench Gemma 4 12B, Vulkan, -ngl 99 — 생성·프롬프트 처리 둘 다) | parse 7.4/8.3/24 · frame 32.5/39.2/78 — 기준선(31.5/38.7/86)과 같음 | **원인 아님.** WebView2 GPU 프로세스·DWM·llama.cpp가 같은 RTX 5070 Ti(LUID 0x128e4)에 있는데도 그렇다. 상태바 GPU%는 dGPU `engtype_3D` 최대값이라 LLM이 돌면 그대로 97%가 뜬다 |
| **CPU 98~100%** (Normal 바쁜 루프 × 24코어) | parse 20.9/36.3/61.6 · frame 46.2/63.1/**140** | **무너짐** — 렌더러 lag는 2.9ms로 멀쩡, 밀린 건 셸·ConPTY·앱 백엔드 |
| 　└ 타이핑 체인만 AboveNormal (수동) | parse 7.7/8.7/11.1 · frame 32.3/39.4/42.8 | 기준선과 같음 → 수정 A |
| **감시 중인 레포에 파일 폭주** (4만 개 생성/삭제 반복 — robocopy 흉내), 그 프로젝트 선택 | longtask **4.6초**, 타이머 지연 max **10.8초**, 폭주 뒤 8초 동안 타이핑 7회만 처리 | **무너짐** — 프로파일: 바쁜 6.1초 대부분이 `ChangesPanel`의 `ChangeRow` 렌더 → 수정 B |
| 　└ 같은 폭주, 다른 프로젝트 선택 | 바쁜 1.0초, `ChangeRow` 20ms | 선택된 프로젝트일 때만 |

오전 상황과의 대응: nqvm-vis 세션이 USB HDD(D:)↔C: 대량 robocopy(11:32~11:56, 14:09~14:28 KST)를 돌렸고
그 폴더는 등록된 프로젝트다. 같은 시각 v0.9.0의 health 프로세스 수 오판정(태스크 69에서 이미 수정)도
겹쳐 있었다. 어느 쪽이 그날 렉을 만들었는지는 로그가 없어 확정할 수 없다 — 그래서 수정 C를 넣었다.

## 2. 수정 A — 타이핑 체인 CPU 우선순위 AboveNormal (Windows, `process_priority.rs`)

- 대상: 앱 자신 + 직계 WebView2(브라우저 프로세스와 그 아래 렌더러·GPU) + ConPTY 호스트(OpenConsole/conhost)
  + PTY 셸 + 셸 직계 자식 중 에이전트(`claude.exe`·`codex.exe`·`opencode.exe`).
- **AboveNormal은 상속되지 않는다** — 셸·claude가 띄운 빌드·스크립트·llama는 Normal로 남는다. 그래서 셸의
  자식은 에이전트 목록만 올린다(셸에서 직접 돌린 python까지 올리면 다시 같은 줄에 선다). 앱의 다른 직계
  자식(llama-server·LSP·git·ffmpeg)은 백그라운드 일이라 두지 않는다.
- **Normal인 것만** 올린다(사용자가 바꿔 둔 값 존중).
- 언제: health 프로브의 30초 트리 스냅샷에 얹는다(스냅샷 25ms를 새로 뜨지 않는다) + `term_open` 직후 1회.
  claude를 새로 띄우면 최대 30초 Normal이다.
- 리눅스·macOS: 비특권 프로세스는 nice를 낮출 수 없어 대응 없음.

## 3. 수정 B — 변경 목록 행 상한 (`ChangesPanel.tsx`)

- 그룹마다 처음 300행만 그리고 "N개 더 있음 — 1,000개 더 보기". 머리 숫자는 전체 개수.
- **범위 선택·롤백 대상(`flatRows`)도 그려진 행만** — 접힌 그룹을 빼는 것과 같은 이유(숨은 행을 Shift 범위가
  휩쓸어 롤백하면 안 된다).
- `usePrefetchDiffs`는 원래 앞 30개만 적재하는데 후보 목록은 전체를 훑어 캐시를 조회했다 → 앞 30개에서 멈춘다.
- 백엔드 `--untracked-files=all`은 그대로(폴더를 한 줄로 접지 않으려는 의도된 선택 — `status.rs` 주석).

## 4. 수정 C — 로그 빈틈 메우기

- `[term-perf]` 60초 요약에 `paint_p90`·`paint_max`(키→화면 프레임). echo는 파싱까지라 렌더·합성·GPU 정체를 못 봤다.
- `SLOW kind=paint` — 파싱 뒤 프레임까지(paint − echo) ≥ 200ms일 때.
- 요약·SLOW 줄 끝에 `sys_cpu= sys_gpu= sys_ram=`(상태바와 같은 값, 1.5초 안에 못 읽으면 `sys=timeout`).
- `[llm] llama-server 기동 pid= model= ngl= ctx= threads=` — 이전엔 유휴 종료 줄만 있어 시각을 못 맞췄다.

## 5. 수정 D — 포커스 창에는 WebView2 메모리 목표 LOW를 걸지 않는다 (`webview_guard.rs`)

`MemoryUsageTargetLevel(LOW)`는 비활성 앱용이다(MS 문서: 스왑아웃된 메모리는 다시 읽혀 성능이 떨어지니
활성화되면 NORMAL로 되돌리라고 한다). 예전엔 메모리 경보 때 **지금 타이핑 중인 창까지** LOW였다. 이제 LOW는
포커스 창을 빼고 걸고, 경보 중 포커스가 옮겨 가면 얻은 창은 NORMAL·잃은 창은 LOW로 따라간다. 효과 크기는
미실측(실제 메모리 고갈을 안전하게 재현할 수단이 없다) — 근거는 문서의 사용 규약이다.

## 6. 다음에 느려졌을 때 읽는 법 (태스크 69 §5 표에 더해)

| 로그 | 원인 축 |
|---|---|
| `paint_*` 높음 · `echo_*` 낮음 · `lag_*` 낮음 | 렌더·합성·GPU(메인 스레드는 멀쩡) — 같은 줄 `sys_gpu` |
| `echo_*` 높음 · `lag_*` 낮음 · `sys_cpu` 90+ | CPU 포화 — `[priority]` 경고 줄이 있으면 우선순위 설정 실패 |
| `lag_*`·`long` 높음 + 같은 시각 대량 파일 작업 | 렌더러 메인 스레드 — 변경 목록 외에 수만 개를 그리는 곳이 또 있는지 |
| `sys=timeout` | 머신 전체가 멈춘 순간(메모리 스래싱·디스크 정체) — `[health]` 줄의 avail/커밋 |

## 7. 결과 (2026-09-21, 수정 빌드 dev 앱 — 수동 조작 없음)

앱이 스스로 올린 우선순위: gitpervisor·WebView2 6개·OpenConsole·pwsh = AboveNormal, 앱이 띄운 git = Normal.

| 부하 | 수정 전 | 수정 후 |
|---|---|---|
| CPU 100% — parse p50/p90/max | 20.9/36.3/61.6 | 8.2/9.4/17.4 |
| CPU 100% — frame max | 140.3 | 54.7 |
| 파일 폭주 — longtask max | 4,611 | 201 |
| 파일 폭주 — 타이머 지연 max | 10,815 | 215 |
| 파일 폭주 18.5초 중 메인 스레드 바쁜 시간 | 6,080 | 667 |
| 폭주 직후 8초간 처리된 타이핑 | 7회 | 58회 |

남은 ~200ms 정지는 사이드바·행 300개 렌더(React DEV 빌드)다 — 릴리스는 더 가볍다.
로그: 수정 빌드의 `[term-perf]` 줄에 `paint_p90=40 paint_max=229 … sys_cpu=19 sys_gpu=21 sys_ram=49`처럼 찍히고,
paint 값은 측정 스크립트의 frame 값과 일치했다(229 vs 228.8).

검증: `cargo test --lib`(interactive_pids 2건·구조 테스트 2건·tree_pids) 통과, `tsc --noEmit` 0,
전체 e2e(`shard.mjs` 3샤드) ALL GREEN 1520/0/14, 설치본 감시 무응답 0.
