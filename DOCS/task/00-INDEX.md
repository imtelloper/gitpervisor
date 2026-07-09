# 기능 태스크 설계 인덱스 — 2026-07-02

> 상태: 설계(Design) · 대상: gitpervisor (Tauri 2.11.2 + React 19 + TS) · 1차 플랫폼: **Windows (WebView2)**
> 산출물 성격: `/sc:design` — 태스크별 상세 설계는 각 문서 참조. 본 문서는 요약·순서·의존성·열린 질문만.
> 근거: 태스크별 코드베이스 실측 조사(2026-07-02) + 적대적 사실검증(인용 라인·외부 API 주장을 코드/로컬 크레이트 소스와 대조 교정) 완료.

## 0. 작업 목록과 한눈 요약

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 1 | 모아보기 토글 단축키 (mac/Win/Ubuntu) | [01-aggregate-hotkey.md](01-aggregate-hotkey.md) | **S** | `mod+Shift+A`(mac=Cmd, 그 외=Ctrl) + `isMod` 헬퍼 신설, App 레벨 항상-마운트 `GlobalShortcuts` 등록. 백엔드 변경 0 | 네이티브 브라우저 패널 포커스 중 무반응(기존 단축키 공통 한계), mac 실기 미검증 |
| 2 | 모아보기 새 터미널 추가 버튼 | [02-aggregate-new-terminal.md](02-aggregate-new-terminal.md) | **S** | 프로젝트 드롭다운(1개면 즉시 생성) + `openTerminal` 반환을 `{tabId, paneId}`로 확장해 selected에 자동 편입. Rust 변경 0 | `activeTab` 전환 부작용(의도된 동작으로 채택), 초기 자동선택과의 경합 |
| 3 | 테마 시스템 (2종 → 6종) | [03-themes.md](03-themes.md) | **M** | 기존 `:root[data-theme]` CSS 블록을 단일 소스로 유지, 신규 `themes.ts` 레지스트리(메타+스와치+Monaco+xterm ANSI 보정)로 light/dracula/nord/solarized-light 추가. 백엔드 변경 0 | 라이트 테마 대비 붕괴(diff 오버레이·ai-working 글로우), styles.css↔themes.ts 2곳 동기화 누락 |
| 4 | 원격 git 최신상태 자동 반영 (↓N 배지) | [04-git-remote-freshness.md](04-git-remote-freshness.md) | **M** | ahead/behind 계산·배지·watcher 무효화는 이미 완성 → Rust tokio 스케줄러가 `git fetch --quiet --no-write-fetch-head`(자격증명 3중 억제, Semaphore 3, 백오프)만 추가. 결과는 기존 refs 변경→무효화 경로로 흘림 | 자격증명 팝업 억제 불완전 가능성, 배경 fetch의 op 락 경합(커밋/스테이지 순간 거절) |
| 5 | 프로세스별 CPU/GPU/RAM 팝업 | [05-resource-monitor-popup.md](05-resource-monitor-popup.md) | **M** | 검증된 플로팅 창 레시피로 싱글턴 `sysmon` 네이티브 창 + 배치 커맨드 1개(`sys_process_snapshot`) 2초 폴링. PDH GPU Engine pid 파싱 + sysinfo 재활용 | 타이틀바 폴링과 이중 수집 시 델타 불안정(500ms 스로틀 캐시 공유 필수), 프로세스별 GPU는 Windows 3D 엔진 한정 |
| 6 | 브라우저 팝업 → 플로팅 창 | [06-browser-popup-window.md](06-browser-popup-window.md) | **S~M** | tauri 2.11.2 `on_new_window`의 `NewWindowResponse::Create{window}`(레지스트리 소스 실측 — 오프너 environment 자동 상속)로 팝업을 Tauri 관리 창으로 승격, 실패·한도 초과 시 Deny+OS 위임 폴백 | `window.opener`/postMessage 보존은 실기 스파이크로만 최종 검증 가능, build 실패 후 Create 반환 시 앱 패닉(반드시 Deny 폴백), 팝업 폭탄(상한 8) |
| 7 | 브라우저 로그인 세션 유지 (gmail) | [07-browser-session-persistence.md](07-browser-session-persistence.md) | **S~M** | **가설 기각**: 프로필은 이미 전 탭 공유·영속(`browser-session` 단일 폴더). 진짜 원인은 ①OAuth 팝업의 OS 브라우저 위임(→06) ②구글 임베디드 웹뷰 차단 가능성 ③temp 폴백 — 각각 06 공유 프로필 계약·조건부 Edge UA·폴백 제거로 해소 | 구글 `disallowed_useragent` 차단(UA 조정 + 선행 실측 게이트), 데이터 초기화 시 프로필 폴더 파일 락, macOS는 `data_directory` 미적용(후속) |

## 1. 권장 구현 순서

```
01 → 02  (S·자기완결·같은 파일 순차 작업)
   → [07+06 묶음]  (상호의존 — M1 스파이크: WebView2에서 구글 OAuth 완주 실측이 최우선 게이트)
   → 04  (사용자 체감 큰 M·자기완결)
   → 03 · 05  (독립 M — 순서 무관, 병행 가능)
```

- **01↔02**: 둘 다 `AggregateTerminals.tsx` 헤더를 건드림 — 동시 작업 금지, 순차 납품.
- **06↔07 상호의존**: 팝업 창이 같은 `browser-session` 프로필을 써야 로그인 팝업의 쿠키가 본 탭으로 이어짐(06 §계약). 07의 원인 C1 해소가 06 구현 그 자체. **두 문서 공통 선행 조건: 구글 OAuth 스파이크**(성공 → 설계대로, 실패 → 07 §위험의 OS 브라우저 로그인 안내 폴백).
- 04·05는 각각 자기완결이나 둘 다 배치 커맨드/폴링 규약(WebView2 동시 invoke 유실 대응)을 준수해야 함.

## 2. 사용자 결정이 필요한 열린 질문

| 태스크 | 질문 | 설계 기본값(미응답 시) |
|--------|------|------------------------|
| 03 | 라이트 테마에서 임베디드 터미널도 라이트 배경으로 갈지, UI만 라이트+터미널은 다크 유지가 취향인지 | 터미널도 라이트 + ANSI 16색 보정 |
| 03 | 추가 4종(light/dracula/nord/solarized-light) 외 꼭 원하는 테마가 있는지 | 없음(레지스트리 구조상 후속 추가 저비용) |
| 04 | 사이드바 ↓N 배지 클릭 시 바로 pull 실행을 원하는지 | 표시만(오클릭 merge/충돌 위험) — pull은 기존 Changes 패널 버튼 |
| 04 | 임베디드 중첩 저장소(`<outerId>::<rel>`)도 자동 fetch 대상에 포함할지 | v1은 최상위 프로젝트만(중첩은 수동 fetch) |
| 05 | 프로세스 강제종료(kill) 버튼 v1 비포함 판단에 동의하는지 | 비포함(권한 불일치·파괴성·자체 PTY 관리 충돌) |
| 07 | Edge UA 조정 후에도 구글이 임베디드 로그인을 차단하면, OS 브라우저 로그인 안내로 대체를 수용할지 | 수용(차단은 구글 정책이라 우회 불가) |

## 3. 공통 준수 사항

- **IPC**: 동시 invoke 응답 유실(WebView2) 대응 배치 커맨드 패턴 준수 — 특히 04(fetch 상태)·05(스냅샷 폴링).
- **플로팅 창**: async 커맨드 + `run_on_main_thread` + `WebviewUrl::External`, `browser_args` 전 창 일치 — 05·06이 기존 레시피 재사용.
- **경로 안전**: 신규 FS 접근 커맨드는 `resolve_in_repo` + `.git` 컴포넌트 가드 필수(이번 7건 중 신규 FS 커맨드 없음).
- 각 문서의 "(검증 필요)" 표기는 로컬 소스로 확정 못 한 외부 동작 — 구현 단계에서 실측으로 해소할 것.

---

## 4. 에디터 업그레이드 태스크 (08~17) — 2026-07-06

> 목표: 뷰어/에디터를 Python은 PyCharm급, TS·웹은 WebStorm급으로 (근거 로드맵: 세션 논의 2026-07-06).
> 근거: 태스크별 코드 실측(2026-07-06) + 2렌즈 적대 검증(①키바인딩·공유계약·IPC 규약 정합 ②§2 인용 120여 건 코드 대조) — 지적 13건 반영 완료.
> 선행 완성 인프라(01~07 이후 추가): go-to-definition(별칭 해석·미리보기 모델·예열 캐시·pathspec 5배 가속 실측), 뷰어 파일 탭, revealTarget 심볼 착지, TS 워커 진단 OFF(가짜 마커 150건 실측).
>
> **구현 상태(2026-07-07)**: **08~17 열 개 태스크 전부 구현·검증 완료**(각 실행 중 앱에 CDP로 동작 확인 + E2E 스위트 20~28 신설). 08~16 보강: **ruff/biome 번들 폴백**(runner discover ④ + fetch-tools.mjs pin·해시 다운로드 + tauri bundle.resources — 실제 포맷·린트 변환까지 E2E 검증 완료), **파이썬 on-type 린트**(ruff stdin — 미저장 버퍼 구문 오류 실시간 빨간 밑줄, DOM 검증), biome 파서 좌표 수정(location.start/end 실측 구조).
> 17(LSP)은 **완료 — M1+M2(venv+획득자동화)+M3+M4, provider 7종(2026-07-07)** — 파이썬(basedpyright) + TypeScript/JS(typescript-language-server+tsserver). **completion·hover·definition·references·signatureHelp·rename·inlayHints** 전부. 실앱 검증: py·ts 타입 인지 자동완성·정의·참조·시그니처·진단·rename(다중 파일)·inlayHint·**앱 내 서버 다운로드**(sha512 검증+원자 설치)·프로세스 누수 0(E2E 28). de-risk 실측 기반. **앱 내 완전 획득**(4방식): npm+node(py/ts/php) · **네이티브 다운로드**(clangd/rust-analyzer/lua-language-server/zls — GitHub 바이너리, sha256 pin, ArchiveKind 4종[zip·gz·tar.gz·tar.xz]) · **PATH 발견**(gopls/ruby-lsp/csharp-ls/jdtls) · node 런타임. 데이터 기반 `NativeSpec`으로 언어 추가는 항목 하나. **지원 11개 언어군: 파이썬·TS/JS·C/C++·Rust·Lua·Go·PHP·Zig·Ruby·C#·Java**(실앱 검증). 신규 crate: flate2·tar·sha2·zip. **태스크 17 완료.**

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 8 | 전역 코드 검색 (Find in Files) | [08-find-in-files.md](08-find-in-files.md) | **M** | 신규 `search_in_project`(git grep, `-F` 리터럴/`-P` 정규식, 3중 캡) + 하단 결과 패널(Log 패널 미러). 점프는 기존 `selectDiff`/revealTarget 재사용, 연타는 seq 스테일 드롭 | 흔한 단어 과대 출력(git `-m` 버전 검증 필요), PCRE↔JS 정규식 차로 하이라이트 누락 가능, gitignore·중첩 저장소 미검색(v1 수용) |
| 9 | 빠른 파일 열기 (Quick Open) | [09-quick-open.md](09-quick-open.md) | **M** | `mod+P` → 배치 `list_repo_files`(outer+임베디드 합성 id, 10k 파일 ~150ms 실측) + 프론트 퍼지 자체구현(최근 파일 가중). **QuickPick 프리미티브를 공유 계약으로 정의 — 13이 재사용** | mod+P가 WebView2 인쇄와 겹칠 가능성(실기 스모크, 실패 시 mod+E 재배정), 50k 캡 절단 |
| 10 | 파이썬 아웃라인 (DocumentSymbol) | [10-python-outline.md](10-python-outline.md) | **S~M** | 정규식+들여쓰기 파서 provider 하나로 스티키 스크롤 정확도·내장 quickOutline 팝업(`mod+Shift+O`)·diff 브레드크럼이 전부 활성(monaco 0.55 번들 실측). 상단 브레드크럼 바는 standalone 미포함 확정 → 범위 제외 | 정규식 파서 엣지케이스(탭/스페이스 혼용), quickInput 위젯 테마 보정 필요 |
| 11 | 참조 찾기 (Find Usages) | [11-find-references.md](11-find-references.md) | **M** | Shift+F12는 Monaco 내장 — `find_references`(git grep `-F -w`, 캡 200/30) + ReferenceProvider 등록만. peek 미리보기는 `ensurePreviewModel` 선생성 재사용, **TS 워커 references를 꺼야 중복 그룹 없음** | 흔한 심볼 폭주(캡+타임아웃), 미리보기 모델 FIFO 40 경합, WebView2 Shift+F12 도달 미검증(컨텍스트 메뉴 폴백) |
| 12 | 같은 심볼 하이라이트 | [12-occurrence-highlight.md](12-occurrence-highlight.md) | **S** | **전제 수정: monaco 0.55 내장 텍스트 폴백('*')으로 파이썬 하이라이트 이미 동작**(CDP 런타임 실측). 잔여 작업 = 테마 6종 wordHighlight 색 정의 + 회귀 감지 E2E뿐 | monaco 업그레이드 시 내장 폴백 소실 위험(E2E 앵커 + ~20줄 폴백 provider 예약) |
| 13 | 전역 심볼 검색 (Go to Symbol) | [13-symbol-search.md](13-symbol-search.md) | **M** | `find_symbols` — `def_query`를 부분일치 패턴으로 일반화해 전 언어 21패턴 1패스 grep + 백엔드 랭킹(정확>접두>부분→정의강도→ext 부스트) 캡 100. UI는 09 QuickPick 재사용, 키 `mod+Alt+N`(Ctrl+N·Ctrl+T 기각 근거 명시) | 짧은 쿼리 부하(2자 하한+디바운스+스트리밍 중단), `def_query` 변경이 find_definition 회귀 가능(10-codenav E2E 선행 가드) |
| 14 | 호버 독스트링/JSDoc | [14-hover-docstring.md](14-hover-docstring.md) | **S** | `extract_signature`→`extract_sig_doc` 확장, `DefMatch.doc` 분리 신설(py 독스트링/ts·js JSDoc/rs `///`), 호버 3-엔트리(시그니처 코드블록+문서 본문+힌트). 신규 커맨드 0 | 무관 주석 오귀속(공백줄 불허+`/**` 한정으로 완화) |
| 15 | 포매터 (ruff format / biome) | [15-formatter.md](15-formatter.md) | **M** | 웹은 biome 채택(단일 바이너리·stdin — prettier는 node 의존이라 후속), py는 ruff format. Shift+Alt+F는 Monaco 내장 — FormattingEditProvider 등록만. **외부 도구 러너 계약(`tools/runner.rs`) 정의 — 16이 재사용** | **공급망**: 프로젝트 로컬 바이너리(node_modules/.bin·venv)는 옵트인 기본 꺼짐(전역 PATH만), json/css 워커 기본 포맷과 등록 경합 |
| 16 | 실전 린트 마커 (ruff/biome) | [16-lint-markers.md](16-lint-markers.md) | **M** | TS 워커 진단 OFF로 비워진 마커 채널을 `lint_file`(15 러너 재사용)로 채움 — owner 'ruff'/'biome' 분리, 열람+저장 후+외부 변경 3트리거. 파일 전환 마커 잔존은 모델 dispose로 구조 해소(실측) | 열람=자동 실행이라 공급망 정책이 15보다 엄격해야, ruff/biome CLI JSON 스키마 미설치라 (검증 필요) — 구현 1단계에서 픽스처 고정 |
| 17 | LSP 통합 (아키텍처 **v2**) | [17-lsp-integration.md](17-lsp-integration.md) | **L** | basedpyright(npm tarball 5.8MB·deps 0 실측)+**typescript-language-server**(vtsls는 tarball 단독 실행 불가 실측으로 기각). **획득 계층 신설**: 발견 우선 + 관리형 다운로드 폴백(node≥20 포함, pin+코드 고정 해시 — fetch-tools 관례의 런타임화). **진단 v1 포함**(owner "lsp" — 16 마커 인프라 합류). 브리지는 Channel 다운스트림 + fire-and-forget `lsp_send`. 수제 어댑터(0.55 공개 API 실측). lspActive 게이트 상호배타. 옵트인 OFF+유휴 10분+상한 4. M1 스파이크→M2 획득→M3 TS·진단→M4 리네임·인레이 | 서버 메모리 폭주(17.6GB급 레포), 다운로드 공급망(pin 해시로 완화), 진단 겹침 노이즈(ruff+pyright — M4 실측 조정), --stdio·venv 키 등 잔여 (검증 필요)는 M1/M2 게이트 |

### 4.1 권장 구현 순서

```
12 → 14 → 10        (S군 즉효 — 자기완결, 12는 사실상 테마 색 정의만)
   → 09 → 13        (QuickPick 계약 순방향 의존)
   → 08 · 11        (grep 백엔드 확장 — 병행 가능, find_definition 관례 공유)
   → 15 → 16        (러너 계약 순방향 의존 — 공급망 정책 공유)
   → 17             (LSP — M1 스파이크가 게이트, 08~16과 독립)
```

- **09→13**: 13의 UI는 09 QuickPick 프리미티브(비동기 소스+로딩 상태 포함) 그대로 — 계약 변경 시 두 문서 동기.
- **15→16**: 16은 15의 `tools/runner.rs` 계약(발견 순서·stdin 실행·타임아웃·미설치 UX)에 전면 의존. 16이 자동 트리거(열람)라 프로젝트 로컬 바이너리 옵트인 정책은 15 §6과 교차 명시됨.
- **13의 선행 가드**: `def_query` 시그니처 일반화 전에 기존 10-codenav E2E 통과를 회귀 기준선으로 고정.
- **17은 대체가 아니라 상위 호환**: LSP 활성 시 11(참조)·13(심볼)·14(문서)는 게이트로 물러나고 폴백 유지, 08(텍스트 검색)·09(파일 열기)는 LSP와 무관하게 존속.

### 4.2 사용자 결정이 필요한 열린 질문

| 태스크 | 질문 | 설계 기본값(미응답 시) |
|--------|------|------------------------|
| 08 | 검색 실행: Enter 명시 실행 vs 라이브 디바운스 | Enter 실행(17.6GB 레포 키스트로크당 git spawn 방지) |
| 08 | 결과 패널 위치: 하단 접이식 vs 사이드바 | 하단(Log 패널 전례 — 전폭·뷰어 동시 표시) |
| 09 | mod+P 인쇄 억제 실기 확인 실패 시 mod+E 재배정 수용 여부 | 수용(키 상수 1곳 국소화로 재배정 저비용) |
| 10 | 구조 팝업: Monaco 내장 quickAccess vs 자체 QuickPick 팝업 | 내장(UI 0줄, 테마 색만 보정) |
| 11 | peek 목록에 정의줄 포함 여부 | 포함(Monaco includeDeclaration 관례) |
| 12 | 테마 6종에 조화색 정의 vs 기본 회색 | 조화색 정의(이중 데코 실효 알파 ~0.92 실측 — 기본 회색은 선택색을 가림) |
| 13 | 검색 스코프: 현재 프로젝트만(v1) | 현재 프로젝트만(전 프로젝트 횡단·중첩 repo는 후속) |
| 15 | 프로젝트 로컬 바이너리 실행 옵트인 기본 꺼짐 동의 여부 | 꺼짐(전역 PATH+명시 경로만 — 공급망 방어) |
| 15 | 웹 포매터 biome 단독 채택(prettier 프로젝트는 스타일 불일치 감수) | biome(prettier 러너는 후속) |
| 16 | 린터 미설치 시 완전 침묵 vs 발견성 뱃지 | 침묵(도구 상태는 15 설정 UI에 위임) |
| 17 | ~~LSP 진단(빨간 밑줄)을 v1에서 완전 제외~~ | **해소(v2)**: v1 포함으로 개정 — 16 마커 인프라 실존 + 실사용 요구("빨간 밑줄") 확인. 17 §3.7 |
| 17 | LSP 다운로드 동의 UX: 토글 시 다이얼로그 1회(크기 명시) 수용 여부 | 수용(VS Code Pylance 관례 — 미동의 시 휴리스틱 유지) |

### 4.3 공통 준수 사항 (08~17)

- **키 예약표(충돌 검증 완료)**: 08=`mod+Shift+F` · 09=`mod+P`(폴백 mod+E) · 10=`mod+Shift+O`(Monaco 내장 동일 키) · 11=`Shift+F12`(내장) · 13=`mod+Alt+N` · 15=`Shift+Alt+F`(내장). 기존 앱 키·Monaco 기본 키와 무충돌 실측(검증자 확인). 신규 전역 키는 terminal-engine 화이트리스트 필요성을 각 문서가 개별 판정(09는 의도적 비통과 — C-p readline 보호).
- **공유 계약**: QuickPick 프리미티브(09 §4)·외부 도구 러너(15 §3.2)는 단일 정의 — 소비 문서(13·16)는 링크만.
- **grep류 IPC 관례**: find_definition 준수(입력 검증·확장자 pathspec·결과 캡·forward-slash 상대경로) — 08·11·13 공통.
- **공급망 원칙(2026-07-07 개정)**: ~~자동 바이너리 다운로드 전면 비채택~~ → **"발견 우선 + 검증된 폴백"**으로 개정. 15/16은 빌드 시 번들 폴백(fetch-tools.mjs — 버전 pin+게시자 해시 검증, 구현 완료), 17은 런타임 관리형 다운로드(동의 1회+pin+**코드 고정 해시** — 17 §3.3). 공통 불변: 사용자·프로젝트 설치본이 항상 우선(버전 드리프트 방지), 프로젝트 로컬 실행파일(node_modules/.bin·.venv)은 옵트인 기본 꺼짐(17은 v1 탐지 제외).
- **WebView2 규약**: 동시 invoke 응답 유실 대응(배치·단일비행·lane) 준수 — 09(배치 1회 수집)·17(Channel 다운스트림 + fire-and-forget)이 핵심 적용례.

## 5. UI/UX 태스크 (18~) — 2026-07-07

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 19 | 새 프로젝트 폴더 생성 + 프로젝트별 뷰 상태 기억 | (직접 구현·검증 2026-07-09) | **M** | ① PROJECTS에 "새 프로젝트 폴더 만들기": `create_project_folder`(부모+이름+git init → 절대경로) Rust 커맨드 신설 → 기존 addProject 재사용(DRY). ② 프로젝트 왕복 시 상태 복원: **트리 펼침**(TreeNode 로컬 state → 프로젝트별 영속 스토어 `stores/treeState.ts`, `gp:tree-expanded`), **활성 파일**(전역 selectedDiff → `activeDiffByProject` 프로젝트별 복원, selectProject/selectDiff/closeViewerTab 동기), **뷰**(이미 terminals.activeTab 영속 — 유지). 뷰어탭+활성파일 localStorage 영속(`gp:viewer-tabs`, 재시작 복원). WorkspaceTabs 자동전환 가드(전환·마운트 복원 시 뷰 안 덮음). 실앱 검증: 폴더생성+git init·중복/이름거부, 트리 왕복 복원, 활성파일 복원, 정상 open→viewer 유지 | 활성파일 복원↔뷰 자동전환 상호작용(가드로 해소), 재시작 stale worktree 대상(DiffViewer 무해 처리) |
| 18 | 설정 모달 UX 재설계 | [18-settings-ux.md](18-settings-ux.md) | **M** · **구현·검증 완료(2026-07-07)** | 단일 스크롤 컬럼(8섹션·22필드) → **좌 사이드바 6카테고리 + 정적 인덱스 검색**(w-860 분할 셸). 저장 모델 불변(전역 폼+단일 저장), 카테고리는 뷰 필터, 섹션 6파일+shared.tsx 분해(860→365줄). 검색 하이라이트(HlField)·자동전환·조건렌더 부모토글 폴백·dirty 정규화 비교·Esc 2단계·유지보수 hidden 마운트. **실앱 검증**: 편집값 유지·검색/하이라이트·테마 프리뷰+Esc 복원·저장·C3 폴백·완전성 가드(22키 커버) E2E 29 | (해소) 검증 15건 반영 — 완전성 가드는 getSettings 런타임 키 대조로 구현 |
