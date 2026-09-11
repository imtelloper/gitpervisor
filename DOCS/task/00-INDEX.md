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

## 6. 알림·미디어 태스크 (20~22) — 2026-09-02

> 상위 설계: `DOCS/video-split-redock-notify-design.md`(4건 배치 — F2 "분리 터미널 되돌리기"는
> `aggregate-window-redock-memo-design.md` 경로로 **구현 완료·실기 검증 통과**, 나머지 3건이 아래).
> 근거: 코드 실측 2026-09-02(워킹트리 미커밋 변경 포함). **세 태스크 모두 Rust 변경 0.**

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 20 | 새 버전 알림(우측 하단) | [20-update-notify.md](20-update-notify.md) | **S** · **구현·검증 완료(2026-09-02)** — 버전 하향 실기·e2e 29 통과, §8 | 신규 기능이 아니라 기존 updater 토스트의 약점 3개 수리 — `pushToast` 4번째 인자 `{durationMs:null}`(persistent), `useUi.openSettings("update")` 딥링크(1회성 소비), App 효과 안 12h `setInterval`(dev·autoCheck 가드 공유) + `notifiedVersion` 세션당 1회 | dev 가드 누락 시 dev 창이 설치본을 갈아엎음(같은 효과 안에서 가드 공유로 차단) |
| 21 | GitHub star 부탁 카드 | [21-github-star-prompt.md](21-github-star-prompt.md) | **S** · **구현·검증 완료(2026-09-02)** — `window.open` 위임 Windows 실측 OK, §8 | 3번째 실행에 1회(`gp:launch-count`·`gp:star-asked` localStorage — 설정 스키마 불변). HealthBanner 미러 카드 + App 공용 스택 컨테이너. 링크는 **`window.open` → 기존 `on_new_window` 위임**(lib.rs:773) — 신규 커맨드 불필요 | `window.open` 위임은 프론트 선례 0건 — Windows·Linux 실측 필수, 실패 시 `open_url` 커맨드 대안. 카운터는 App 렌더 안에서만(모듈 최상위면 보조 창마다 +1) |
| 22 | 동영상 타임틱 분할 | [22-video-timetick-split.md](22-video-timetick-split.md) | **M** · **구현·검증 완료(2026-09-02)** — e2e 33 18 pass, 실기 §8 | 틱 N개 → 기존 `video_export`를 세그먼트마다 **순차** 호출(백엔드 0줄). 배치 상태는 신규 `stores/videoSplit.ts`(패널 닫혀도 진행·취소 유지), 종결은 이벤트·프라미스 경주, `events.ts`가 토스트 위임. 출력 `<stem>.split/<stem>.part-01.mp4`, 기본 copy·선택 encode | copy 키프레임 스냅(기존 한계 승계), invoke 응답 유실(이벤트 경주로 방어), webm/ogv→mp4 remux 거부 가능(기존 단일 내보내기와 동일). 진행률 분모는 백엔드가 range 길이로 계산함을 확인(video.rs:601-608) |

**구현 상태(2026-09-02)**: 20·21·22 전부 구현·검증 완료(미커밋). 후속으로 토스트 z-order(`Toast.tsx` z-[55] — 설정 모달 위·확인
다이얼로그 아래)와 `videoSplit` 마지막 세그먼트 중복 토스트 경주(`recentlyOwned` 10초)도 봉합·실측.

**e2e 기준선 정비(같은 날, 전부 원인 규명 후 수정)**: 전체 러너가 484/23/4 → 부하 낮은 실행에서 **516 pass / 5 fail / 3 skip**, 남은 5건도
격리 실행에서 전부 통과. 규명된 원인 — 30-image-annotate: **제품 버그** `AnnotationLayer` rAF 플래그 미리셋(StrictMode 이중 마운트에서
캔버스 영구 미도색, dev 한정 · `image-annotation-design.md` 부록) + 헬퍼 `selCount` 정규식 결함 → 60/60; 22/23: 고정 sleep → 행 출현 폴링 30s,
23 smart-case 기대값 정정(`13-symbol-search.md` §81 유지), 22~25 finally의 `selectDiff`→`selectProject` 순서 결함(뷰어 상태 오염) 교정; 28: 시그니처
좌표가 빈 줄 → 3행 21열, completion 재시도; 17: 시한 기반 pull 재시도 + `run.mjs`가 러너 동안 `remoteRefreshMinutes:0`·teardown 뷰어 탭 정리·잔여
픽스처 purge; 14: 모아보기 뷰가 열린 채 터미널 검사 진입 시 연쇄 실패 → `ensureAggClosed` 전제 가드·타이틀바 토글 선택자 한정; 25: peek 대기 30s;
`lib/cdp.mjs`: 라벨 `main` 페이지 선택(풀 창 함정)·`_send` 60s 시한·`eval` 응답 유실 throw/재시도·`E2E_CDP`; 29: 하드코딩 레포 경로 제거.
**주의**: 마지막 실행(RAM 96%·CPU 86%)은 495/11/4였으나 신규 실패 10건이 전부 30s `E2E_TIMEOUT`·빈 DOM 결과·네트워크 TIMEOUT 등
**부하 신호**였다(백엔드 체크 통과, 실행 전 GitGate 거짓 화면). 러너 결과는 부하가 낮을 때만 신뢰한다(메모리 `e2e-baseline-failures`).

### 6.1 권장 구현 순서

```
20 → 21 → 22
```
20·21은 반나절 규모의 독립 작업이고 22가 몸통이다. 21의 `window.open` 실측이 실패하면 그때만 Rust 커맨드
1개가 생긴다. 22는 `VideoPlayer.tsx`·`ExportPanel.tsx`를 크게 건드리므로 다른 영상 작업과 동시 진행 금지.

### 6.2 사용자 결정이 필요한 열린 질문

| 태스크 | 질문 | 설계 기본값(미응답 시) |
|--------|------|------------------------|
| 22 | In/Out 구간이 설정된 상태에서 분할 — 구간 안만? | 전체 길이(구간 무시) |
| 22 | 결과 폴더가 이미 있고 파일이 겹칠 때 | 1회 확인 후 전체 덮어쓰기 |
| 21 | 노출 시점 3번째 실행 vs 첫 실행 즉시 | 3번째 실행 |
| 20 | 재확인 주기 | 12시간 |

## 7. 터미널 히스토리 접근성·툴팁·자동배치·프로젝트 색 (23~28) — 2026-09-02

> 상위 설계: `DOCS/pane-history-tooltip-layout-design.md`(요구 5건 → 태스크 A1~D2). 근거: 워크플로 조사
> (코드 사실 3갈래 + 초안 반박 2관점, CDP 실측) → 문서 6개 작성 → 문서별 코드 대조 교정 → 문서 간 정합 검토.
> **구현 상태(2026-09-03)**: 23~28 전부 **구현·검증 완료(미커밋)** — tsc 0, 단독 스위트 13(27 pass)·14(60 pass)·19(38 pass), 실기는 각 문서
> 구현 결과 절. 리뷰 minor 3건 반영. 후속 결함 1건(23 §10 — 병합 오버레이가 컬럼 헤더 X를 덮음) 수정·검증. **미해결**: 14의 24번 단언
> "셀 메뉴 '프롬프트 목록 닫기' → 닫힘" 간헐 실패(5회 중 2회, 라벨이 '열기'로 남음 — 원인 미규명).
>
> **여섯 태스크 모두 Rust 변경 0.** 줄번호는 워킹트리 기준(HEAD 14108eb; `stores/ui.ts`·`main.tsx`·`tests/e2e/lib/cdp.mjs`는
> 태스크 20~22의 미커밋 변경을 포함 — 심볼로 찾는다).

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 23 | 터미널 pane 세션 컨트롤 오버레이 병합 | [23-pane-controls-merge.md](23-pane-controls-merge.md) | **S** | **버튼은 있는데 눌리지 않는다** — TerminalPane의 z-10 세션 클러스터(테마·히스토리)가 같은 앵커의 PaneTree z-30 PaneControls 오버레이에 완전 피복(클래스 치수 119 ⊇ 76~90px + CDP 실측). PaneTree 오버레이 하나에 ThemeButton·PromptLogButton(+구분선)을 편입하고 클러스터·중복 최대화/닫기·전용 셀렉터 삭제(≈ +8/−25). `Maximize2/Minimize2/X` import는 PaneMenu가 쓰므로 유지(상위 설계 정정), 팔레트 메뉴가 오버레이 opacity에 묶이지 않게 `focus-within:opacity-100` 추가 | e2e `elementFromPoint`는 opacity와 무관해 hover 가시성 회귀를 못 잡는다 — 실제 포인터 실기 필수. 24와 TerminalPane.tsx 공유 → 순차 |
| 24 | 우클릭 메뉴 "프롬프트 목록 열기/닫기" | [24-history-context-menu.md](24-history-context-menu.md) | **S** | PaneMenu(워크스페이스·플로팅)와 ChipMenu(모아보기 메인 안·별도 창)에 MenuItem 1개씩 — 상태별 한 동사 라벨·세션 어휘 "프롬프트 목록", 기존 `togglePanel/openPanels` 그대로(신설 0). ChipMenu는 컨테이너가 `shown && kind==="terminal"`을 판정해 콜백을 넘김. 하단 클램프는 CDP 실측(PaneMenu 413px)에서 유도 — **PaneMenu 240→448, ChipMenu 200→248**(상위 설계의 270/240은 현재 값이 이미 173px 부족한 사실을 놓쳤다) | 하드코딩 클램프가 이미 한 번 낡아 있었다 — 유도식 주석 + "창 바닥 우클릭 시 메뉴 바닥 ≤ innerHeight" e2e 단언. ChipMenu 높이는 계산값 → 실기 확정 |
| 25 | 플로팅 창 타이틀바 히스토리 마스터 토글 + 토스트 호스트 | [25-float-window-history.md](25-float-window-history.md) | **S** | 기존 `PromptHistoryButton`을 FloatTitleBar actions(되돌리기 왼쪽)에 그대로 — 플로팅 창의 `useTerminals`가 창별 독립 스토어라 대상이 저절로 "이 창의 pane만". `<Toasts/>`를 FloatWorkspace 루트에 마운트해 복사 토스트 무음 해소. title 문구 "전체 프롬프트 목록 펼치기/접기 — 이 창의 모든 터미널 우측…"(세 사용처 공통, prop 없음). ~14 LOC | 되돌리기 실패는 여전히 console.error(오픈 이슈). 플로팅 창 e2e는 러너 CDP가 메인 하나라 `cdp.mjs` export+라벨 attach 헬퍼가 필요(다른 세션이 편집 중인 파일) |
| 26 | 프롬프트 컬럼 호버 카드(비상호작용 툴팁) | [26-history-hover-card.md](26-history-hover-card.md) | **S~M** | 항목 native `title` → `pointer-events-none fixed z-50 role="tooltip"` 카드(DragGhost 계열). 리스트 단위 hover 상태 하나, 최초 150ms·항목 간 즉시 전환, 컨테이너 leave/scroll 숨김, `list.find` 가드, `useOccludesWebview(!!entry)`. 가로 `W=max(240,min(480,left−16))` 항목 왼쪽, 세로 50% 뒤집기 + 앵커 쪽 여유로 `maxHeight`(30줄 카드 ≈676px는 720px 창 60vh도 넘침). 헤더·푸터 `fg-muted`(상위 설계 fg-dim은 darcula 2.90:1). Escape·스크롤 없음 | 좁은 셀 깜빡임 루프는 pointer-events-none으로 정의상 소멸 — e2e가 computed `pointerEvents==="none"`으로 실측. React는 `mouseover/mouseout`에서 enter/leave를 합성 — e2e 이벤트 선택 주의 |
| 27 | 모아보기 자동배치 모드(그리드 / 세로 컬럼) | [27-aggregate-layout-mode.md](27-aggregate-layout-mode.md) | **S~M** | `useUi.aggregateLayout`(`gp:aggregate-layout`) + `shapeFor(mode,n)` 순수 함수 하나로 렌더와 `evenTracks(mode)`가 같은 rows/rowLens(columns = `min(n,4)` — 1100px에서 5열부터 MIN_W 미달). 트랙 키 `n${n}` 유지·마이그레이션 없음(아이콘 클릭 = 항상 균등). hover는 래퍼 span, 버튼은 `disabled`→`aria-disabled`(React 19.2.7 `getListener`가 disabled 버튼의 onMouseEnter를 거른다). 묶음 칩과 공유 `useDelayedClose(150)`, 점유 `|| !!layoutMenu` | "균등 상태에서 팝오버가 안 열림"은 정적 검증으로 절대 안 보이는 유형 — e2e가 aria-disabled 상태에서 `mouseover` 유도로 열림 단언. 렌더↔evenTracks 모양 불일치는 저장 검증에 가려지는 조용한 버그 → shapeFor 단일화 |
| 28 | 프로젝트 색 공유 모듈 + 사이드바 행 배경 | [28-project-colors.md](28-project-colors.md) | **S~M** | `lib/project-color.ts` 신설(팔레트·`assignProjectHues` + 슬롯 소진 시 `taken.clear()`·`projectTint(hue, "off"\|"on"\|"row"\|"row-on")`·`useProjectHues()` 전체 프로젝트 이름순 배정)로 사이드바 행·모아보기 칩·셀 헤더가 한 맵을 본다. 행 배경은 `--tint/--tint-hover` 변수 + `bg-(--tint) hover:bg-(--tint-hover)`(Tailwind 4.3 실증). **대비 목표 재정의**: 절대 4.5/4.5/3.0은 오늘의 행도 못 넘어(darcula dim 2.90) "fg ≥ 4.5 + muted/dim은 현행 bg-selection 기준선 이상" — 초기 알파 다크 .28/.35·라이트 .10/.15·solarized-light .06/.10 **(→ 36이 대체 — 12슬롯은 26개 중 16쌍이 ΔE00 0.00이었고 알파 틴트로는 채도와 대비를 동시에 못 만족한다. 골격만 승계, 색 생성은 32슬롯 불투명 OKLCH로 교체. §9)** | Tailwind가 조립 클래스를 스캔 못 해 배경 투명인데 tsc는 통과하는 유형(e2e computed backgroundColor 가드). solarized-light는 selection≈panel이라 보이는 틴트가 전부 기준선 아래 — 거의 안 보이는 알파 vs 선택행 fg-muted 4.04→3.72 중 택일 |

### 7.1 권장 구현 순서

```
23 → 24 → 25 → 26 · 27 → 28
```
- **23→24**: `TerminalPane.tsx` 공유. 23이 22줄을 지워 24의 앵커가 밀린다(PaneMenu :164→:142 — 24 §5 대응표). 24의 `promptOpen` 구독은 PaneMenu 함수 안이라 TerminalPane :55와 스코프 충돌 없음.
- **24→27→28**: `AggregateTerminals.tsx` 공유 — 24 ≈+19줄, 27 ≈+40~90줄. 28의 `lib/project-color.ts`·`styles.css`·`ProjectList/Item`은 겹치지 않아 병행 가능, `AggregateTerminals` 전환 단계만 27 뒤.
- **25→26**: `TermSessionControls.tsx` 공유 — 25는 같은 줄 수 치환이라 26의 PromptSidePanel 앵커 불변.
- **e2e 14 삽입 순서**: `#2a`(23) → `#2c`(24) → `#2d`(26) · `#11a`(24) → `#11d`(27) → `#12`(28). `paneId`는 23이 함수 스코프에 한 번만 선언(`let` + `openTerminal` 반환 수신) — 24·26은 재선언 금지(try 스코프 `const`는 앞 블록을 TDZ로 죽인다). `finally` 원복은 26(`promptHistory.clear`)·27(`setAggregateLayout(orig)`)만.

### 7.2 사용자 결정이 필요한 열린 질문

| 태스크 | 질문 | 설계 기본값(미응답 시) |
|--------|------|------------------------|
| 23 | 세션 버튼 16px vs TBtn 21px 히트박스를 맞출지 | 그대로(TermSessionControls는 25→26 소유 — 거슬리면 이후 size prop 1커밋) |
| 24 | 숨김 셀의 칩 메뉴에서 항목을 빼기 vs aria-disabled로 보이기 | 뺀다 |
| 24 | 클램프 상수 유지 + 유도식 주석 vs 지금 ref 실측으로 전환 | 상수(세 번째 변경부터 전환) |
| 25 | 되돌리기 실패(console.error)를 `pushToast("error")` 1줄로 표면화 | 범위 밖 |
| 26 | 헤더·푸터 `fg-muted`(solarized-light 4.39:1) 수용 | 수용(기존 컬럼 헤더 fg-dim 3.64보다 높다) |
| 26 | `__gpv.promptHistory` DEV 노출(main.tsx 1줄) | 노출(videoSplit 관례, release 미포함) |
| 27 | 팝오버 열기 지연 150ms를 처음부터(헤더를 스칠 때 점유 acquire로 브라우저 셀 깜빡임) | 넣지 않음(묶음 칩과 같은 수준 승계) |
| 27 | n=2는 두 모드가 같은 모양 — 팝오버를 숨길지 | 그대로 노출(모드 저장은 이후 셀 수에 영향) |
| 28 | ~~solarized-light 알파 — 상대 기준선 준수 .06/.10 vs 라이트 공통 .10/.15 vs 틴트 0~~ | **소멸(→ 36)** — 알파 축이 없어졌다. 36은 solarized-light에서 fg-muted 4.17 ≥ 기준선 4.04로 예외 없이 통과 |
| 28 | ~~다크 row-on .35 단일 vs monokai·dracula·nord만 .5~~ | **소멸(→ 36)** — row/row-on 두 레벨이 단일 색으로 합쳐졌다 |
| 28 | 프로젝트 추가·제거 시 색 이동 수용 vs `gp:project-hue` 영속 | **→ 36 §3.1**: 결정적 배정 유지. churn이 5.63/최악 11 → 실측 1.11~1.25/최악 3으로 떨어져 영속화가 사는 값이 거의 없다 |

### 7.3 공통 준수 사항 (23~28)

- **정적 검증만으로 통과 금지** — 각 문서 §7.2 실기 필수(hover 가시성·클램프·점유·대비는 e2e가 못 본다).
- **fixed 팝오버/카드는 전부 `useOccludesWebview` 점유 등록**(26 `!!entry`, 27 기존 호출에 `|| !!layoutMenu`).
- **공유 어휘·상수의 정의 문서는 하나**: 메뉴 라벨(24), PromptHistoryButton title(25 §3.3), ~~`projectTint` level 인자(28)~~ → **`ProjColor{bg,stripe}`·`PROJECT_HUES` 32슬롯·`FLOORS`(36 §4.1)**, 아이콘 Grid2x2/Columns3(27), 클램프 448/248(24).
- 같은 파일은 순차 납품 — 구현 시 앵커는 줄번호가 아니라 라벨 문자열·심볼로 잡고 각 문서 §5의 밀림 표를 참고.
- `stores/ui.ts`·`main.tsx`·`cdp.mjs`는 태스크 20~22의 미커밋 변경 위에 얹는다 — HEAD 체크아웃·리베이스 금지.

## 8. 테마·이미지 창·시스템 정보·Windows 터미널 (29~33) — 2026-09-03

> 근거: 코드 실측 2026-09-03(xterm 6.0.0·portable-pty 0.8.1·sysinfo 0.33 로컬 소스, NuGet ConPTY 패키지 내용 포함).
> Rust 변경은 30(창 수명 1줄·창 크기 인자)·31(수집 커맨드)·33(ConPTY 사이드로드) 세 건 — 한 번의 재빌드로 묶는다.

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 29 | 사용자 정의 테마(색 조합) | [29-custom-themes.md](29-custom-themes.md) | **M** | 기반 테마 + 18토큰 오버라이드. 정의는 localStorage `gp:custom-themes`(선례 `gp:term-themes`), 적용은 `<style id="gp-custom-themes">`에 `:root[data-theme="custom-…"]` 블록 생성 → `dataset.theme` 관례·xterm `readTheme`·보조 창 코드 무변경. Monaco는 기반 규칙 복사 + 토큰 colors로 동적 defineTheme. Rust 0 | `BUILTIN_TOKENS` 사본이 styles.css와 어긋남(e2e 19 짝 검증) — **36 이후 폭발 반경 확대: 이 상수가 프로젝트 팔레트 전체의 입력이다(36 §6)**, ~~라이트 기반의 틴트 5변수 사본~~(**36이 `LIGHT_TINT`/`TINT`를 삭제해 해소**), `.ai-working` 라이트 글로우 미적용(장식) |
| 30 | 이미지 더블클릭 → 별도 창 보기·편집 | [30-image-doc-window-editor.md](30-image-doc-window-editor.md) | **S~M** | doc 창은 이미 이미지를 보여준다 — 빠진 건 그 창의 `ImageEditor`·Toasts·Confirm·Prompt 호스트와 더블클릭 진입, 저장 후 메인 `file-image` 무효화(워처 `repo://changed`에 추가), doc 창 수명(`is_aux`에 `doc-`) | 편집기 청크 인라인(lazy 유지), 900×760에서 편집기 좁음(이미지는 1180×860 인자) |
| 31 | 리소스 모니터 "시스템 정보" 탭 | [31-sysmon-system-info.md](31-sysmon-system-info.md) | **M** | sysinfo 공통 + Windows PowerShell CIM 1회 호출(6클래스 JSON) + Linux /sys,/proc + macOS sysctl/system_profiler. 신규 크레이트 0, 프로세스 수명 캐시, 항목 단위 실패(`notes`). 탭 배열 리터럴 1곳이 확장 지점 | PowerShell 기동 1~3s(캐시), `AdapterRAM` 4GB 캡(레지스트리 qwMemorySize 우선), 모니터 뮤텍스 미점유(지역 System) |
| 32 | 터미널 Shift/Alt+Enter 줄바꿈(Claude Code) | [32-terminal-enter-modifiers.md](32-terminal-enter-modifiers.md) | **S** | xterm은 Shift+Enter를 `\r`로, Alt+Enter를 `ESC CR`로 보내고 ConPTY는 `ESC CR`을 두 키로 쪼갠다. portable-pty가 ConPTY를 `WIN32_INPUT_MODE`로 만들어 `?9001h`를 요청하므로, Windows에선 Enter+수식을 **win32-input-mode 키 레코드(ALT)** 로, 그 외엔 `\x1b\r`로 보낸다 | Shift+Enter를 ALT로 보내는 트레이드오프(pwsh AddLine 대신 무동작 — 현재도 AddLine은 안 됨), ConPTY 레코드 해석은 키 에코 실측으로 확정 |
| 33 | Windows 10 스크롤 불가 · 최신 ConPTY 번들 | [33-windows-conpty-bundle.md](33-windows-conpty-bundle.md) | **M** | 원인은 Windows 10 내장 ConPTY(2018~22)의 렌더링·스크롤백 결함(VS Code `windowsUseConptyDll`·WezTerm이 같은 이유로 사이드로드). portable-pty 0.8.1이 exe 옆 `conpty.dll`을 `LoadLibraryW`로 우선 로드하므로 NuGet `Microsoft.Windows.Console.ConPTY` 1.24(MIT)의 conpty.dll+OpenConsole.exe를 번들하고 `SetDllDirectoryW`로 아키텍처별 폴더를 가리킨다. Shift+휠 뷰포트 스크롤 보강 | 번들 DLL의 무접두 export 유무(실측), Windows 10 실기 불가(사용자 검증 항목), 크기 +1.2MB |

| 35 | 영상 별도 창(편집 포함) · 뷰어 탭 우클릭 메뉴 | [35-video-doc-window-tab-menu.md](35-video-doc-window-tab-menu.md) | **S** | 30의 doc 창 경로를 영상으로 넓힌다 — 더블클릭 분기에 `isVideo` 추가, `events.ts`의 `video://` 블록을 `attachVideoEvents(qc)`로 뽑아 DocWindow도 구독(토스트는 잡을 시작한 창만 — 모듈 Set `localVideoJobs`). avi/mkv/wmv/flv 컨테이너 추가 + 재생 실패 시 "mp4로 변환해 열기". 탭 우클릭 메뉴는 로컬 state + `useOccludesWebview`. Rust는 preview.rs MIME 4줄 | 이벤트가 전 창 브로드캐스트라 걸러내지 않으면 토스트 2번, 메뉴가 네이티브 webview에 가림 |

### 8.1 권장 순서
```
[프론트 병렬: 29 · 30 · 31 · 32+33]  →  Rust 1회 재빌드(30·31·33)  →  격리 검증(29→30→31→32/33 실측)  →  전체 e2e
```
같은 워킹트리에서 태스크 23~28이 병행 중이라 Rust 저장·CDP 조작은 그쪽 검증 완료 신호 뒤에.

### 8.2 사용자 결정이 필요한 열린 질문
| 태스크 | 질문 | 설계 기본값 |
|--------|------|------------|
| 32 | Shift+Enter를 Alt+Enter와 같게(Claude 줄바꿈) vs SHIFT 정직 전달(pwsh AddLine) | Alt와 같게 — 요구가 Claude Code. 상수 1개로 전환 |
| 29 | 테마 내보내기/가져오기(JSON) | 후속 |
| 31 | 온도/실시간 클럭(센서) 탭 | 제외(sysinfo Components가 Windows에서 비어 있음) |
| 33 | portable-pty 업그레이드·PASSTHROUGH 플래그 | 후속(번들만으로 목표 달성 여부 먼저) |

### 8.3 구현 상태(2026-09-03)

**29~33 전부 구현·격리 검증 통과(미커밋).** 프론트 4갈래 병렬 → Rust 1회 재빌드(`cargo test` 151 통과) → 격리 검증 순.
- 29: e2e 19 38 pass + CDP 실기 43건(미리보기 174ms 반영, Monaco `gitpervisor-custom-*`, sysmon 보조 창 동기, 삭제 폴백). 검증 중 제품 결함 1건 수정(편집 중 카테고리 이동 시 draft id가 남아 기본색으로 떨어짐 → 언마운트 가드).
- 30: e2e 34 15 pass + 실기 17건(트리 dblclick → 1180×860 doc 창, 그 창의 편집기·확인·프롬프트·토스트, 저장 → 메인 `file-image` 무효화, 양방향).
- 31: 값 대조표(§8) — CIM은 클래스별 독립 시한, GPU는 레지스트리(WMI `Win32_VideoController`가 이 머신에서 무응답), L3는 `Win32_Processor` 우선(하이브리드 CPU 중복 합산 해소, 36864KB). e2e 18 32 pass, 수집 4.9s·캐시 3ms.
- 32: 키 에코 실측 Enter `\r` / Shift+Enter·Alt+Enter `\u001b\r`, **Claude Code v2.1.258 실물에서 두 키 모두 줄바꿈**. e2e 06 13 pass.
- 33: 번들 ConPTY 1.24 사이드로드 확인(로그·`term_open {conpty:"bundled"}`·OpenConsole.exe 수). Claude Code는 alt 버퍼+마우스 추적이라 "위 내용 보기"는 **휠 → SGR 마우스 보고 → Claude 자체 스크롤** 경로이며 번들 ConPTY에서 정상 동작 실측(§9.5, PageUp/PageDown 대안). Windows 10 실기는 이 머신에 없어 사용자 검증 항목(TROUBLESHOOTING §10).
- 전체 러너: **603 pass / 3 fail / 6 skip**(직전 516/5/3). 실패 3건 중 12의 2건은 번들 ConPTY의 DA1 질의를 원시 e2e 채널이 회신하지 못해 첫 출력이 3.4s 밀린 것(제품 결함 아님 — 스위트를 마커 폴링으로 수정, 3/3 통과; 33 §9.6), 14 #2b는 번들 ON/OFF 모두 4/4 통과로 회귀 아님(부하 시 기대값 스냅샷 낡음, 간헐).

> **정정(2026-09-04 · 36 §9.10)**: `#2b`의 "부하 시 스냅샷 낡음"이라는 원인 추정은 반증됐다 — 진짜 원인은
> 프로브가 `listTerminals().find(status==='live')`로 **사용자가 띄워 둔 첫 live 터미널**을 집어 남의 셸을 재고
> 있던 테스트 격리 결함 + 기준 `want`를 fit 이전 값으로 잡은 것이다. paneId 고정 + 현재 xterm 열수 기준으로
> 교체해 3회 연속 PASS. 같은 패스에서 `컬럼 헤더 X 중심 elementFromPoint` 간헐도 근본 수정(원인 = 컬럼이 막
> 열린 직후의 낡은 X 버튼 rect, 4회 연속 PASS).
> **따라서 전체 러너 총계 603/3/6은 낡았다** — 36 작업은 13·14·19 부분 실행만 했고 전체는 다시 돌리지 않았다.

## 9. 프로젝트 색 재설계 (36) — 2026-09-04

> 근거: 코드 실측 2026-09-04(워킹트리 기준). 13 에이전트 조사·설계·심사·종합 → 구현 → 정적 검증 2갈래 →
> CDP 실기 → 정정. **태스크 28을 대체한다** — 28의 골격(색 정의가 `lib/project-color.ts` 한 곳, 사이드바 행·
> 모아보기 칩·셀 헤더가 같은 맵, 등록 전체 이름순 배정, `--tint`/`bg-(--tint)`, "선택 행 기준선 이상" 대비 목표)은
> 승계하고 색 생성만 교체했다. §7의 28행과 §7.2의 28 열린 질문에 대체 표시를 달아 뒀다. **Rust 변경 0.**

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 36 | 프로젝트 색 재설계: 32슬롯 불투명 OKLCH + 좌측 스트라이프 | [36-project-color-32slot.md](36-project-color-32slot.md) | **M** | **"비슷하다"가 아니라 같았다** — 12슬롯에 프로젝트 26개라 13번째부터 hue를 재사용해 26개 중 **16쌍이 ΔE00 0.00**이었고, 다크 알파 틴트(`hsl(h 70% 26% / .28)`)는 합성 후 채도가 거의 안 남았다. 알파는 못 올린다 — 대비와 정확히 반대로 움직인다(실측 .6에서 darcula 3.07 하락). 네 가지를 바꾼다: 슬롯 12→**32 + 이중 해싱**(step 홀수 → N=32와 서로소, 32칸 전수 방문. churn 5.63/11 → 1.11~1.25/3), 알파 틴트 → **불투명 OKLCH를 JS가 `#rrggbb`로 계산**(CSS `oklch()`는 게멋 매핑이 브라우저 몫이라 칠해지는 값을 코드가 모른다 = 대비 증명 불가), 행 명도를 **테마 토큰에서 이분탐색으로 유도**(대비비는 배경 휘도에 단조 → 통과 구간이 단일 구간 → 극단에 최악 hue가 붙는다 ⇒ **테마별 하드코딩 0개**, 커스텀 테마도 같은 경로), 라이트 2종의 배경 ΔE 천장 2.2를 **좌측 4px 스트라이프**로 우회(글자가 안 얹혀 비텍스트 3:1만 받으므로 채도를 게멋 끝까지 → 8.03/7.02). 선택 표시는 `border-l-2 border-accent` → 스트라이프 4→8px + accent outline(accent 단독 불가 — 스트라이프와 최소 ΔE00 darcula 4.86/sol-light 4.65). 실측 6테마 × 32슬롯 × 8토큰 = **1,536건 위반 0**, 26개·325쌍 max(배경,띠) 최소 **7.02** | **정적 검증이 전부 통과한 채 살아 있던 결함 2종**(§9.9): 테마 라이브 프리뷰 동결(옛 CSS 변수는 `data-theme`를 자동으로 따라갔는데 값을 JS로 옮기며 저장값을 읽어 프리뷰 중 행만 얼어붙음 — monokai→light에서 대비 1.00), 팔레트 캐시 미무효화(커스텀 테마 편집이 id를 보존해 옛 팔레트 영구 잔존 — 대비 보증이 통째로 무효). **e2e 19가 팔레트를 재구현하면 FAIL 없이 옛 값을 계속 재며 PASS**한다(옛 판이 그랬다) → 앱 함수 직접 호출로 교체. `BUILTIN_TOKENS` 사본의 폭발 반경이 커졌다(이제 팔레트 전체의 입력) |

### 9.1 열린 질문

| 태스크 | 질문 | 설계 기본값 |
|--------|------|------------|
| 36 | 사이드바 인상이 통째로 바뀐다(배경↔패널 ΔE00 2.5~7.8 → 9.8~16.0, 행 사이로 패널이 안 비침). 되돌리는 노브는 `CAP`(채도만 내려 대비 예산을 안 쓴다 — 첫 후보)과 `MARGIN`(명도를 패널 쪽으로) 둘이고, 당긴 만큼 구분이 나빠진다 | 지금 값으로 써 보고 판단 |
| 36 | 모아보기 칩의 선택/비선택 배경 차이 소멸(알파 .5→.92 → `ring-accent`만). 되살리려면 라이트 2종에 없는 톤 예산이 필요하고 e2e 14 `#12` 단언을 "hue 동일"로 승격해야 한다(삭제 금지) | ring만 |
| 36 | `.ai-working` 다크 알파 .26 → .19(대비 회복분과 맞바꿈). .26 유지 시 monokai fg-muted 3.02→2.63, dracula 3.52→3.11 | .19 |
| 36 | 적록색각이상은 개선되지 않는다(천장: 12개 4.80, 26개 2.41). 다음 카드는 스트라이프 위 2글자 모노그램 | 넣지 않음 |
| 36 | 프로젝트 33개 이상 계획이 있는가(33번째부터 정확히 1쌍 중복. 40+면 다크 톤 3단 확장 필요 — 라이트는 불가라 비대칭) | 32까지만 보증 |
| 36 | 커스텀 테마 **편집 중**(저장 전) 프리뷰가 행 색에 안 붙는다. 고치려면 `projectPalette(themeId)`가 "활성 테마에서만 옳은 함수"가 돼 e2e 19·14 계약이 깨진다 | 보수적으로 남긴다 |

### 9.2 구현 상태(2026-09-03)

**구현·검증 완료(미커밋).** 9파일 345 insertions / 183 deletions. `tsc --noEmit` exit 0(4회), `npm run build`
exit 0(신규 경고 0), Rust 변경 0.

- 정적: 6테마 × 32슬롯 × 8토큰 **1,536건 위반 0**(기준선 아래 0, 절대하한 4.5/3.0/2.0 위반 0, 고유색 32/32).
  최소 여유 **+0.061**(darcula fg-dim). solarized-light의 **기존 미달이 해소**돼(fg-muted 4.17 ≥ 기준선 4.04)
  e2e 19의 `TINT_TOL` 0.35 예외를 삭제했다. 커스텀 테마 퍼즈 24,000건 중 전제 통과 2,146건 → 하한 위반 0.
- 실기(CDP 29222, DOM 25행): 배경·스트라이프 **25/25 고유**, 알파 잔존 0, **렌더 픽셀 == 계산값**
  (ffmpeg raw RGB 샘플링, 최대 ΔE 0.00), 6테마 전환 후 옛 팔레트 잔존 0, 모아보기 칩 == 행 완전일치.
  `projectPalette` 첫 호출 3.6ms / 캐시 0ms.
- e2e(부분 실행 13·14·19): 정정 후 **ALL GREEN 133 pass / 0 fail / 2 skip**. 14 단독 68 pass / 0 fail / 1 skip.
  검증 중 **14의 선행 간헐 2건을 근본 수정**했다(위 §8.3 정정 참조).
- **미검증**: 첫 페인트 플래시(앱 재시작 필요), 모아보기 별도 창 칩 색(살아있는 PTY 소유권), `.ai-working`
  α .19 육안(작업 중 프로젝트 부재), 실제 프로젝트 추가·33번째 경계 실기(합성 이름으로 대체), 제거 churn 재측정,
  **전체 e2e 러너**.
- ⚠ **어떤 팔레트 hex 표도 회귀 기준선이 아니다** — 기준선이 필요하면
  `window.__gpv.projectColor.projectPalette(<theme>)`를 직접 불러 재라(36 §7.4). 설계 단계 명세의 hex 384개는
  프로토타입과 구현의 이분탐색 종료 L이 <0.002 어긋나 **127/384가 다르다**(대부분 채널 ±1, 최대 3).
  지각 차이 0, 판정 전부 동일. 그 명세(`SPEC.md`)는 **레포에 없다** — 세션 스크래치패드 산출물이다.


## 10. 이미지 편집기 Figma급 재설계 (37~52) — 2026-09-04

> 시안: `designs/image-editor-figma-v2.pen`(8프레임, 텍스트 라벨 741개 전수 인벤토리 기준) · 상위 설계: `DOCS/pro-image-editor-design.md`
> (**§8 비범위 표는 이 트랙에서 사용자 결정으로 대체** — "축소판 없이 전문 기능 전부", 2회 확정). 근거: 코드 실측 2026-09-04 →
> 6축(문서모델·렌더·벡터·상호작용·내보내기/스타일·텍스트) 독립 제안 → 3렌즈(정합성·실현가능성/위험·완전성) 교차 심사 → 통합 골격.
> **문서 상태**: 골격·계약·순서·열린 질문 확정. 태스크 문서 16개 작성 완료(2026-09-04) + 문서 간 정합 검사 1회(계약 이름·§링크·의존·e2e 번호·시안 밖 항목 교정, 미해결은 §10.6).
>
> §10 이미지 편집기 Figma급 재설계(태스크 37~52). 사용자 결정: "축소판 없이 전문 기능 전부"(2회 확정) — pro 설계 §8 비범위는 대체, 아키텍처 위험(잠금/숨김 3분기·그룹 AABB 부풀림·블렌드 배경·좌표 드리프트·OOM)은 resolveScene 단일 해석·평탄 DFS 트리·캔버스 병합·크롭 세션 base 재계산·바이트 상한 메모리 원장으로 푼다. 6축 제안을 3렌즈 심사(정합성·실현가능성·완전성)로 통합: 타입은 37 한 곳, 렌더 진입은 renderScene 하나, 트리는 평탄 배열, 패스는 상대 핸들, 마스크는 노드+이미지 2종, 조정은 기존 3필드 유지(시안에 8슬라이더 없음). 시안 designs/image-editor-figma-v2.pen 8프레임·라벨 인벤토리 전수 매핑, 협업 요소 없음, 단축키 Windows 1차(Mac Cmd 대응). Rust 변경: image_doc_*(4+snapshots)·asset_pick_file·font_list/font_read·image_library_get/set·export_*(6)·write_file_bytes stamp 반환·doc 창 빌더 disable_drag_drop_handler·tree.rs `validate_rel_file`/`is_dotgit_component` pub(crate)(52). 신규 의존: npm fit-curve 0.2.0·polygon-clipping 0.15.7·fontkit 2.0.4(MIT, 실측 검증), cargo fontdb 0.24·ttf-parser 0.25(순수 Rust).

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 37 | 문서 모델 v2 — 노드 유니온·정규화/업그레이드·직렬화 + AnnotationLayer 분할 | [37-image-doc-model-v2.md](37-image-doc-model-v2.md) | **L** | AnnoObject 7종은 교체가 아니라 진화(기하 불변·스타일만 fills/strokes/effects/blend), 타입은 이 태스크 한 곳이 소유하고 타 축은 import. 경계 정규화(normalizeNode)로 e2e 30/34/35 픽스처 0줄 이행. | render shim(첫 fill/stroke만)이 39 전까지 '문서엔 있는데 안 보이는' 기간을 만든다 |
| 38 | 평탄 트리 연산·resolveScene·기하 골격(bounds 3종·씬 히트테스트·프레임/그룹) | [38-image-tree-scene-geometry.md](38-image-tree-scene-geometry.md) | **L** | 평탄 DFS 배열+parentId(캐시 참조비교·히스토리 배열 공유·선형 렌더 유지). 잠금/숨김은 resolveScene 한 함수가 Scene으로 해석하고 프리뷰·히트·출력이 같은 Scene을 소비 — 3분기 위험 구조적 봉쇄. 그룹은 기하 없음, 회전은 리프에 굽기 → AABB 부풀 자리 없음. | tree.ts 밖 직접 splice가 불변식을 깨면 조용히 순서가 어긋남 — DEV 단언+리뷰 규칙 |
| 39 | 렌더러 v2 — 캔버스 병합·격리·블렌드 19·마스크·페인트/효과 스택·모자이크 통합·조정 ctx.filter | [39-image-render-v2.md](39-image-render-v2.md) | **XL** | 베이스 캔버스 2장 구조 폐기: renderScene(ctx,scene,t,opts.image) 하나가 이미지+노드를 불투명 합성 — 블렌드·배경 블러·격리 그룹이 배경 픽셀을 요구하므로 오버레이 방식은 형광펜 55줄 재구성을 노드마다 복제한다. [0]=커밋 캐시 DOM(hidden) [1]=씬 → e2e 캔버스 인덱스 계약 유지. | 색보정 틱마다 전체 재렌더(종전 CSS 무료) — 40 실측, 초과 시 위 캐시 규칙 |
| 40 | 렌더 윈도·디테일 캔버스·타일 출력·샌드위치 캐시·메모리 원장 실측 | [40-image-render-window-perf.md](40-image-render-window-perf.md) | **M** | 백킹 1800 불변(e2e 35 ①). 확대·픽셀 미리보기는 화면 공간 디테일 캔버스 [2](8MP 상한)에 같은 renderScene을 윈도 지정. 출력은 2048² 타일로 작업 메모리 상수화. 전체 출력 캔버스를 화면에 상주시키는 안은 OOM 이력으로 기각. | WebView2 GPU 텍스처는 private bytes 밖 — bytes 카운터 별도 보고 |
| 41 | 사이드카 영속·자동저장·히스토리 v2(라벨·jumpTo·스냅샷)·에셋 획득 | [41-image-doc-persist-history.md](41-image-doc-persist-history.md) | **L** | persistence_decision 그대로. 히스토리는 전체 스냅샷 유지·상한 200(배열 참조 공유라 5k노드×200=8MB), 라벨·시각·jumpTo, 이전 세션은 로그만(readonly), 명명 스냅샷은 별도 파일 20개. 자동저장이 stash·닫기 확인창을 대체. | e2e 러너 잔존 사이드카 오염 — openEditor 헬퍼 delete 1줄 + run.mjs teardown |
| 42 | 편집기 셸 — UI 스토어·모드 상태 머신·키 스코프·단축키 표·타이틀바·툴 레일 23·상태바 | [42-image-editor-shell.md](42-image-editor-shell.md) | **L** | 문서·applyDoc 깔때기는 그대로, 창별 zustand UI 스토어 + Mode(design|nodeEdit|crop, 도구와 직교) + window capture 리스너 1개로 앱 전역 키 25곳 무수정 차단. 단축키 표는 이 태스크 하나(vector/text 행 흡수). 툴 id 'vpen'('path'는 kind 이름과 충돌). | 캡처가 과하면 앱 전역 키가 죽어 보임 — consume은 처리 키만, 프로브 e2e 고정 |
| 43 | SVG 크롬 오버레이·눈금자·가이드·스냅 엔진·스마트 가이드·Alt 측정·측정 도구·픽셀 그리드 | [43-image-chrome-snap.md](43-image-chrome-snap.md) | **L** | 크롬은 화면 공간 SVG(pointer-events:none) 하나 — 디테일 캔버스 [2]가 확대 시 [1] 위에 뜨므로 캔버스 크롬은 편집하려고 확대하는 순간 가려진다. 계산(스냅·스마트 가이드)은 snap.ts 하나, 표시는 ChromeState.extra 프리미티브로 47/48/45가 공유. | 가이드가 문서(EditorDoc.guides)에 들어가 e2e 30 (q-2) 완전 일치 단언 — EMPTY_DOC guides:[] |
| 44 | 좌측 패널 — 레이어 트리(검색·필터·접기·드래그 순서·이름·눈/자물쇠·뱃지)·히스토리 탭·에셋 탭 슬롯 | [44-image-panels.md](44-image-panels.md) | **L** | 행 데이터는 tree.childrenOf 뷰, 조작은 tree.ts 함수만(직접 splice 금지). 가상화 없음(content-visibility). 히스토리 패널은 41 API(entries/cursor/jumpTo/스냅샷)만 소비. HTML5 DnD는 doc 창 빌더에 disable_drag_drop_handler 1줄이면 산다 — 기각 근거 정정. | 드래그 중 스크롤 컨테이너와 포인터 캡처 충돌 — rAF에서 scrollTop 직접 |
| 45 | 컨텍스트 바 7종·인스펙터 4탭 셸·속성 탭·필드(Mixed/스크럽)·정렬/분배·팝오버 프리미티브+8종 | [45-image-inspector-popovers.md](45-image-inspector-popovers.md) | **XL** | classifySelection 하나(42 `selection.ts` 소유, 규칙은 45 §3.1)가 컨텍스트 바·인스펙터를 같이 판정. 탭 4개 hidden 마운트(e2e 30 '오른쪽 90' 클릭 계약). 도메인 섹션(벡터/크롭/텍스트/스타일/내보내기)은 46/48/50/51/52 컴포넌트를 마운트만 — 중복 구현 0. 조정 탭은 시안대로(8슬라이더·필터 없음, 기존 3 슬라이더 유지). | XL — 4커밋 분할(Props→ContextBar→Adjust→Popovers), 각 커밋 e2e 30 초록 유지 |
| 46 | 패스 렌더·기하·변환(패스로)·불리언 4·평탄화·윤곽선화·패스 분리·다각형/말풍선 프리셋 | [46-image-vector-path.md](46-image-vector-path.md) | **L** | 노드+상대 핸들 모델(translateObject 앵커만 이동 관례 계승), 렌더·히트는 Path2D 네이티브. 불리언은 polygon-clipping(0.25px 평탄화→Schneider 재피팅) — 산출물이 픽셀이라 근사가 출력에서 비가시, paper.js 12MB 이중 모델 기각. 윤곽선화는 같은 라이브러리 union. | render drawObject switch에 default 없어 path 누락 시 조용히 안 그려짐 — e2e (a)가 잡음 |
| 47 | 펜 도구(P)·곡률 토글·노드 편집 모드(스크림·앵커/핸들·5모드·연산·스냅·키보드) | [47-image-vector-pen-node-edit.md](47-image-vector-pen-node-edit.md) | **XL** | 펜은 완료 시 1커밋 후 곧바로 nodeEdit 진입(시안 ③). 히트 우선순위 핸들→앵커→세그먼트(편집 객체 1개 isPointInStroke)→마퀴. 모드는 UI 스토어(문서 아님 — undo로 모드가 빠지지 않게). 크롬은 ChromeState.extra 프리미티브(캔버스 아님, 43 `scrim` 종류 추가). 노드 전용 스냅 상태(`setNodeSnap`)는 두지 않는다 — 42 토글 재사용. | auto 모드 핸들 물질화를 이웃 이동 시 빠뜨리면 곡선이 안 따라옴 — 노드 연산 출구 한 곳 |
| 48 | 크롭 프로 모드 — 8핸들·비율 7·오버레이 4·직선화(임의 각)·여백 자동 제거·영역 밖 삭제·적용/취소 | [48-image-crop-straighten.md](48-image-crop-straighten.md) | **L** | 직선화는 buildOriented 최내측 회전(캔버스 bbox 확장, θ=0 비트 동일 → e2e 30/34/35 무영향, 90°/반전 델타·renderOutput 무변경). 주석은 크롭 세션 base에서 매 틱 재계산 — 드리프트 구조적 0. 모드는 42의 mode.crop(Tool에 'crop' 없음). 세션 API(`cropSet/cropApply/…`)는 AnnotationLayerHandle이 아니라 ImageEditor 훅 `useCropSession`의 `CropApi`(applyDoc·base·oriented를 쥐는 쪽) — 이름은 계약 그대로. | 45° 극단 oriented +39MB — |θ|>15° constrainToImage 강제(40 원장) |
| 49 | 텍스트 레이아웃 엔진(줄바꿈·정렬·목록·말줄임·박스 모드)·렌더·textarea 메트릭 계약·Mixed | [49-image-text-layout.md](49-image-text-layout.md) | **L** | Canvas fillText 런 유지(letterSpacing/wordSpacing/fontKerning 실측 동작). 자체 엔진은 줄 나눔·배치·장식만. 세로 메트릭은 alphabetic+CSS 라인박스 공식(4폰트 DOM ±0.5px 실측). 렌더·히트·textarea가 같은 TextLayout을 쓴다. | layoutText 소비자 3곳 동시 교체 — 한 커밋; Mac letterSpacing 미지원 폴백 필요 |
| 50 | 시스템 폰트 열거(Rust fontdb)·폰트 피커·텍스트 인스펙터/컨텍스트 바·OpenType(fontkit)·텍스트 윤곽선화 | [50-image-fonts-opentype.md](50-image-fonts-opentype.md) | **L** | 폰트 목록은 Rust fontdb(순수 Rust, memmap, 933MB 489파일 전량 읽기 금지) 단일 경로 — queryLocalFonts는 wry 권한 처리 부재. OpenType은 fillText 불가(ctx.font가 feature-settings 거부 실측)라 기능 켠 객체만 fontkit 글리프 Path2D→TextLayout.outline. fontkit(TTC 18개·가변 폰트) > opentype.js. | fontkit 브라우저 번들 Buffer 잔존 여부 — 첫 1시간 스파이크로 확정 |
| 51 | 스타일 라이브러리(색·텍스트·효과)·컴포넌트/인스턴스·앱 전역 저장소·창 간 동기·에셋 패널 | [51-image-styles-components.md](51-image-styles-components.md) | **L** | 앱 전역 image-library.json 하나(state.rs save_json 재사용 — 손상 격리·원자 rename; localStorage는 K6로 기각). 노드는 값 복사+styleRefs[slot]=StyleId(스냅샷 중복 없음, 렌더는 외부 상태 0). 인스턴스는 children 물질화(렌더·히트·기하·히스토리 변경 0), 재정의는 커밋 시 diff 파생. | 자식 id `${inst}/${child}` — 37 id 규약에 '/' 허용 명시 |
| 52 | 내보내기 엔진·Rust 토큰 폴더 쓰기·다중 내보내기 모달·인스펙터 내보내기 행·프리셋·슬라이스 도구 | [52-image-export.md](52-image-export.md) | **L** | 레포 밖 쓰기는 Rust가 다이얼로그를 열고 토큰만 돌려주는 확정 원칙(screen-capture-design §5.2) — 레포 안도 같은 토큰 경로. 바이트는 raw body invoke(base64 100MB 사본 회피). 렌더는 40 renderOutput 타일, 게이트는 estimateRenderBytes 하나. 프로필 옵션은 실측 기반(PNG 청크 삽입·JPEG/WebP ICC 제거·P3 캔버스). | WebView2 raw body 본문 상한 미확인 — 64MB 왕복 스모크 선행 |

의존: 37←∅ · 38←37 · 39←38 · 40←39 · 41←37 · 42←38,41 · 43←40,42 · 44←41,42 · 45←42,44 · 46←38,39 · 47←43,46 · 48←42,43 · 49←39,42 · 50←45,46,49,51 · 51←45 · 52←40,45,51

### 10.1 권장 구현 순서·마일스톤

```
M0  37(커밋0 AL 4모듈 분할 → 커밋1 types v2/schema)
M1  38 → 39 → 40                  기반: 트리·씬·렌더 병합·타일 출력
M2  41 → 42 → 43 → 44             영속·셸·크롬·패널
M3  45 → 51                        인스펙터·팝오버·스타일/컴포넌트
M4  46 → 47 ∥ 48 ∥ 49 → 50         벡터·크롭 ∥ 텍스트 (병렬 3레인)
M5  52 → 40 §실측표 확정            내보내기·메모리 원장 마감
```
**M1 "그것만 머지해도"**: 기존 편집기가 그대로 동작(30/34/35 초록)하면서 문서가 v2(다중 페인트·효과·블렌드·그룹·마스크)를 저장·렌더한다. 프리뷰==출력이 renderScene 하나로 보장되고 확대 시 원본 픽셀이 보인다.
**M2**: 편집 문서가 자동 영속(닫아도 안 잃음), 히스토리 라벨/jumpTo, Figma형 셸(레일 23·타이틀바·상태바), 레이어 패널로 그룹/숨김/잠금/순서, 눈금자·가이드·스냅·스마트 가이드. 인스펙터는 아직 기존 필드 수준.
**M3**: 속성 전부 편집 가능(채우기/선/효과 스택·정렬/분배·위치/크기·블렌드·색 피커·그라디언트), 스타일·컴포넌트 라이브러리·에셋 패널.
**M4**: 펜·노드 편집·불리언·윤곽선화, 크롭 프로/직선화, 텍스트 엔진·폰트 피커·OpenType. 세 레인은 파일 겹침 0(vector/*, crop.ts, text-*.ts) — 단 geometry.ts는 46이 38 위에 path 케이스를 얹은 뒤에만 다른 레인이 손댄다.
**M5**: 다중 내보내기·레포 밖 쓰기·슬라이스, 4K 실측표(정상/300%/2x) 기록.
착수 전: 30/34/35 기준선 격리 실행 기록(R10), e2e 번호 36~43·DOCS/task 37~52 중앙 배정(run.mjs 등록 1줄씩).

### 10.2 벡터 문서 영속 결정

**결정: 앱데이터 사이드카** `app_data_dir/image-docs/<hex sha256(projectId + "\0" + relPath)>.json`(+`<key>.snapshots.json`), Rust 커맨드 4개, 32MB 상한, tmp+rename(state.rs 패턴)·stamp_of/Conflict 재사용. 루트는 `app_data_dir`(이미지 라이브러리 `image-library.json`과 같은 루트 — 사용자 데이터 루트 하나).

근거: (1) 레포 사이드카는 `git status --untracked-files=all`(status.rs:147)에 올라 원 설계 조건 '레포 오염 0' 위반, 자동 무시에 필요한 `.git/info/exclude` 쓰기는 모든 쓰기 커맨드의 `.git` 거부(tree.rs:1753-1767)와 충돌, rename/move/delete가 사이드카를 모른다. (2) 내용 해시 키는 e2e 픽스처가 바이트 동일해 문서를 공유·평탄화 시 키 소실. (3) localStorage는 `gp:file-draft:*` 5MB 경쟁(K6). (4) sha2는 Cargo.toml에 이미 있음.

운영 규칙: 커밋마다 1s 디바운스 자동저장(단일 비행), 닫기·창 unload 전 flush, 열 때 자동 복원(hist.reset), 닫기 확인창 삭제(flush 실패 시만), in-place 평탄화 성공 시 사이드카 삭제(R8), '다른 이름으로'/내보내기는 유지, 앱 내 이름변경/이동/삭제 콜백이 키 추적, 원본 stamp·크기 불일치 시 배너+crop 해제. 에셋(이미지 페인트)은 문서 JSON에 base64 내장(16MB/디코드 16MP). 레포 사이드카 옵트인은 열린 질문.

### 10.3 사용자 결정이 필요한 열린 질문

| 태스크 | 질문 | 설계 기본값(미응답 시) |
|--------|------|------------------------|
| 41 | 레포 안 사이드카 `<img>.gpv.json`을 프로젝트별 옵트인으로 제공할지(git 변경목록 노출·rename 미추적 감수) | 아니오 — 앱데이터만. 이식은 내보내기 '.gpv.json 내보내기/가져오기'로 후속 |
| 45 | 조정 탭에 시안 밖 슬라이더(노출·색온도·색조·선명도·흐림)·필터 6·자동수평을 넣을지(export 축 제안, .pen 라벨 0건) | 아니오 — 기존 밝기/대비/채도 3개 유지. 사용자가 원하면 export-3 설계(SVG 필터 참조, blur 래스터 굽기)로 별도 태스크 |
| 51 | 에셋 패널 시안 ⑤ 컴포넌트 9종(번호 뱃지·말풍선 주석·지시선·범례 칩·워터마크·측정 라벨·화살표 주석·흐림 영역·프레임 캡션)을 첫 실행 시 시드로 생성할지 | 예 — rect/path/text 조합 시드 스크립트 1회(라이브러리 비어 있을 때만), 사용자가 삭제 가능 |
| 50 | 시안 ④ 폰트 목록(Inter·Playfair Display·Roboto Mono·Space Grotesk·IBM Plex Sans KR)이 미설치일 때 웹폰트를 번들/로드할지 | 아니오 — 시스템 폰트만 열거, 미설치 항목은 큐레이션 목록에 회색 표시(document.fonts.check) |
| 52 | 내보내기 저장 위치 기본값 — 원본 폴더(레포 안, git 변경목록 노출) vs 최근 폴더 | 원본 폴더(원 설계 저장 위치 승계), 마지막 선택을 exportDefaults.target에 기억 |
| 42 | P 키를 베지어 펜으로 재배정(연필=Shift+P) — 출시 키 변경 | 예(Figma 관습·시안 ③ 펜 우선), 릴리스 노트 명시 |
| 39 | ⑧ 이미지 컨텍스트 바 '채우기·맞춤·늘이기'(배경 이미지 피팅)를 위해 프레임 루트 모델(아트보드≠이미지)을 채택할지 | 아니오 — 캔버스=이미지 경계 계약 유지, 세 버튼 미렌더(not_feasible) |
| 47 | 노드 편집 '연결·끊기·도형 삽입'(vector 제안, 시안 밖) | 제외 |
| 46 | 정다각형 인스펙터 `변 수` 필드(시안 라벨 0건 — `isRegularPolygon` 파생, 문서 모델 무변경) | 예 — 정다각형일 때만 표시. 아니오면 필드 1개 삭제 |
| 45→37 | 시안 ④ 효과 편집 `Blend "곱하기"` 행 — 37 `Effect`에 `blend?: BlendMode` 추가할지 | 아니오 — 행 미렌더. 예면 37 +1필드 · 39 dropShadow gCO · 45 Select 1행(순증) |
| 42 | 텍스트 편집 단축키(Ctrl+B/I/U·정렬·크기 ±) — 시안 ②⑧ 글리프 없음(49·50 판정으로 42 표에서 제외) | 아니오 — 인스펙터·컨텍스트 바 컨트롤만. 원하면 42 표 행 + 50 핸들러 |
| 42/51 | 컴포넌트 생성/분리 Ctrl+Alt+K/B(시안 ⑧ 글리프 없음, Figma 관습 — 42 표에 있음) | 예 — 행 유지(Ctrl+Alt+K는 `KeyboardShortcuts.tsx:122` 커밋 폼 충돌을 consume이 막는 부수 효과) |

### 10.4 공통 준수 사항 (37~52)

- 타입·계약은 37 types.ts 한 곳 — 타 태스크는 import만, 같은 개념에 두 이름 금지(계약 §의 이름표가 정본)
- 렌더 진입은 renderScene(ctx, scene, t, opts) 하나 — 프리뷰 백킹·디테일·출력 타일·내보내기·썸네일 전부. 렌더는 문서 밖 상태를 읽지 않는다(스타일·라이브러리는 노드에 값 복사)
- 트리는 평탄 DFS 배열+parentId. objects 재배열은 tree.ts 함수만(직접 splice 금지), DEV assertTreeInvariant를 applyDoc 뒤 호출
- 숨김/잠금/마스크 범위 해석은 resolveScene 한 곳 — hidden ⇒ nodes 제외(렌더·히트·출력 자동 일치), locked ⇒ flags(히트만). Scene 캐시는 단일 슬롯(WeakMap 금지 — 히스토리 잔류)
- 리프 좌표는 세계 oriented px 하나(중첩 행렬 0). 그룹 회전은 리프에 굽는다. 드래그·크롭·직선화는 base에서 재계산(누적 델타 금지)
- 화면 크롬은 SVG ChromeOverlay(pointer-events:none)만 — 캔버스 [1]에 strokeRect/fillText 0건. 포인터·커서는 [1]이 받는다. z: 크롬3>박스2>디테일1
- 단축키는 EDITOR_SHORTCUTS 표 한 곳 + window capture 리스너 1개 — 다른 리스너 추가 금지. 글자 키는 e.code, isComposing 무시
- 문서 변경은 applyDoc/patchDoc 깔때기만, 커밋마다 라벨(없으면 describeChange). 드래그 1회·키 1회(repeat 무시)=히스토리 1칸
- 메모리는 40의 원장 표 하나로 합산(축별 계산 금지). 상한은 바이트: layerPool≤2×백킹, fontkit≤24MB, 디테일 8MP, 에셋 16MB/16MP, 내보내기 게이트=estimateRenderBytes.peak
- Rust: 프론트가 준 절대경로에 쓰는 커맨드 금지(토큰/허용목록), 신규 FS 커맨드는 resolve_in_repo·.git 가드, 동시 invoke는 배치/직렬, 큰 바이트는 raw body(ipc::Request/Response)
- e2e 30/34/35 계약 유지: 루트 div.fixed.inset-0.z-50 + aria-label='이미지 편집', canvases()[0]/[1] 백킹 크기, 200px 픽스처 oriented==백킹==파일, 도구 title '<라벨> (<키>)'. 허용 수정은 계약 §에 열거된 헬퍼 줄뿐
- 시안에 없는 기능은 넣지 않는다(비활성 버튼도 없음) — 추가 제안은 열린 질문으로. 협업(아바타·공유·코멘트) 없음. 단축키 Windows 1차, Mac은 Ctrl→Cmd 두 열 표기
- 근거는 파일:줄, 추측은 '추정'. 착수 첫 단계 프로브: beginLayer 가용(39), raw body 64MB(52), fontkit 번들(50) — 결과로 설계 분기
- 의도적 천장은 `ponytail:` 주석으로 표시(render shim·분류 휴리스틱·등간격 O(N) 등), 후속 태스크가 삭제 수용 기준을 가진다
- 번호: e2e 36 layer-tree(38)·37 persist(41)·38 components-styles(51)·39 vector(46 신설, 47·48 절 추가)·40 `40-image-editor-pro-ui.mjs`(42 신설, 43·44·45 절 추가)·41 export(52)·42 doc-schema(37)·43 text(49 신설, 50 절 추가); DOCS/task 37~52. 형식은 30-image-doc-window-editor.md 표본(§1~§7 + 구현 후 §8)

### 10.5 시안에 있으나 이 플랫폼에서 불가·대체

- ⑧ 배경 이미지 '채우기·맞춤·늘이기': '캔버스 경계=이미지 경계' 계약(ImageEditor.tsx:660-691 renderOutput) 위에 있어 프레임 루트 모델 없이는 프리뷰≠저장. 세 버튼 미렌더, 열린 질문으로 승격
- OpenType 기능을 fillText로: ctx.font이 font-feature-settings를 거부(실측). → 50 fontkit 글리프 패스 경로로 대체(11px 이하 AA 차이 경고). frac는 폰트 GSUB 없으면 합성하지 않음(토글 비활성)
- 선형 번(linear-burn)의 투명 배경 위 정확 재현: canvas에 없어 invert∘lighter∘invert — 불투명 배경에서만 항등. 투명 PNG는 프리뷰==출력이나 Figma와 다름, occlusionIntegrity 채널로 경고
- 이전 세션 히스토리 항목('어제 · 이미지 열기')으로 되돌리기: 세션 간 전체 스택 영속은 자동저장마다 200벌. 로그(라벨·시각)만 readonly 표시, 되돌리기는 명명 스냅샷(20개)만
- 그룹 자체 회전각 보존(회전된 그룹 선택 상자): 리프 좌표 단일 세계 좌표계 대가로 그룹은 기하 없음 — 재선택 시 축정렬 AABB(픽셀 결과는 동일). 필요하면 프레임으로 감싼다
- 한 텍스트 객체 안 범위(부분) 스타일: 시안 속성이 전부 객체 단위, textarea로 범위 편집 불가. 부분 강조는 객체 분할(자동 폭)
- 메타데이터 제거 OFF(원본 EXIF/XMP 보존)·AVIF Display P3: 캔버스 재인코딩은 메타데이터를 남기지 않고(실측) AVIF 인코더는 sRGB 태그 — 옵션 체크·비활성+툴팁
- 래스터 내보내기의 '텍스트 윤곽선화' 옵션: 픽셀 결과가 같아 무의미 — SVG 포맷 채택 시에만 활성. 문서 내 윤곽선화(Ctrl+Shift+O)는 항상 가능(50)
- macOS(WKWebView) 정확도: ctx.filter(조정·효과)·letterSpacing 미지원(추정) — 조정 탭·텍스트 엔진에 isMac 경고+폴백, Windows 1차 플랫폼에서 정확. 실기 1회 항목
- queryLocalFonts로 폰트 열거: wry가 권한 프롬프트를 처리하지 않고 WKWebView 미구현 — Rust fontdb 단일 경로(50)
- 편집 중(textarea) 밑줄/취소선/justify가 확정 렌더와 픽셀 단위 동일: TextMetrics가 underlinePosition을 노출하지 않음 — 확정 렌더가 정본, 50이 폰트 표로 0~1px로 축소
- 노드 편집 '연결·끊기·도형 삽입', 조정 8슬라이더·필터 6·자동수평, 배율 'height', TextCase 'title', Paint image 'tile': 시안에 없어 제외(열린 질문)

### 10.6 정합 검사 접점(2026-09-04) — 결정 완료(아래 결정 문단)

| 접점 | 내용 | 권고 |
|---|---|---|
| 51 → 37 | 51 §4가 `InstanceNode.children: Node[]` **삭제**(자식은 objects 평탄 슬라이스 — 38 §3.1 불변식과 중복 표현)·`GroupNode.detachedFrom?`·`normalizeNode` 보존을 요청. 37 §4·공유 계약은 `children` 유지 | 51안 채택(중복 표현 제거). 37 커밋1에서 반영 — 38 `resolveScene`은 "인스턴스 자식 포함" 문구만 유지 |
| 45 ↔ 43 | 45 그라디언트 캔버스 핸들 드래그가 `onPointerHit`(43 §4에 **없음**)을 전제. 45는 계약 부재 시 핸들 **미표시**(각도/스케일 필드로 전 기능 도달) | 43 `pointer.ts`에 pointerdown 선점 훅 1개(47 진입 3줄과 같은 자리) 정의 여부 — 43 착수 시 결정 |
| 45 → 42/44 | 컨텍스트 바 `image` 변형의 진입 조건 `sel ∋ '__base'` — 누가 `'__base'`를 선택에 넣는지 미정(44 배경 행 클릭은 현재 `select([])`, 캔버스 빈 곳 클릭은 해제) | 44 배경 행 클릭 = `select(['__base'])`로 통일, 42 `select`가 `'__base'`를 단독 선택으로만 허용 |
| 38 ↔ 48 | `rotateNodes` 임의각 규칙 — 38 §3.3 "text/badge `rot` 누적, 나머지 정점 회전"은 축정렬 rect/ellipse/mosaic에 임의각을 적용할 수 없다. 48 §3.2는 "rect·ellipse·mosaic·text·badge = 앵커 이동 + `rot += Δ`, pen/line/arrow/path = 정점 회전"으로 해석 | 48 해석으로 38 §3.3 문구 확정(v1 `Common.rot`이 전 kind에 있음) |

**결정(2026-09-04, 메인 세션 — 문서에 반영 완료)**: (1) 51안 채택 — `InstanceNode.children` 삭제, 자식은 `objects` 평탄 슬라이스, `GroupNode.detachedFrom?`, `normalizeNode` 보존, id에 `/` 허용(37 §4). (2) 43 §4에 `registerPointerHit` 선점 훅 등재 — 45 그라디언트 핸들 표시(45 §6 위험 행 갱신). (3) 44 배경 행 = `select(['__base'])` 단독, 42 `select/selectedIds/classifySelection`이 `'__base'` 의사 id 허용(단독만). (4) 38 §3.3 `rotateNodes` 리프 규칙을 48 §3.2 해석으로 확정(rect·ellipse·mosaic·text·badge 앵커 이동+`rot` 누적, 폴리라인·path 정점 회전). (5) 시안 밖 4건은 §10.3 열린 질문으로 유지.

## 11. 모아보기 묶음 닫기 · 프로젝트 로고 · Git 모달 · 이미지 ↑↓ · 메모 정렬 · Claude 세션 · 로컬 LLM(요약·잔디·번역) (53~61) — 2026-09-07

> 근거: 코드 실측 2026-09-07(워킹트리 기준, 4갈래 병렬 조사 + 메인 세션 대조) + 외부 실측(llama.cpp `b10809` 자산 이름·
> HuggingFace tree API sha256·`llama-server` README). 요구 8건 → 태스크 9개(LLM 요구를 런타임/요약·잔디/번역 셋으로 분리).
> **문서 상태: 설계**. Rust 변경은 54(필드 1·커맨드 1)·57(커맨드 1)·59(모듈 신설)·60(커맨드 6) — 53·55·56·58·61은 Rust 0.

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 53 | 탭 모으기 묶음 칩 우클릭 → 묶음 탭 전부 닫기 | [53-aggregate-group-close-all.md](53-aggregate-group-close-all.md) | **S** | "탭 모으기"는 모아보기 칩 바의 프로젝트 묶음 토글이고 묶음은 객체가 아니라 파생값(`groupByProject`). 우클릭은 이미 드롭다운을 연다 → 드롭다운 끝에 `MenuItem danger` 1개, 확인 후 셀마다 기존 `closePane`/`closeBrowserTab`(별도 창 위임은 `closePane`이 이미 됨). 스토어·위임 프로토콜 변경 0 | 별도 창에서 셀 N개 = 이벤트 N개의 순서(실기 1회, 어긋나면 `closeTab` 위임 3줄) |
| 54 | 프로젝트 로고 지정(트리 이미지 우클릭) + 툴바·모아보기 셀 헤더 표시 | [54-project-logo-override.md](54-project-logo-override.md) | **S~M** | **로고 자동 감지·사이드바 `<img>`는 이미 있다**(`logo.rs`, `useProjectLogo`). 빠진 건 수동 지정뿐 → `Project.logo: Option<String>`(상대경로, serde 하위호환) + `set_project_logo`(저장 전 `encode_logo`로 검증) + `project_logo`가 수동 우선·실패 시 자동 폴백. `ProjectLogo` 공용 컴포넌트로 사이드바·툴바·셀 헤더 3곳. `["project-logo"]`의 첫 무효화 지점 | `Project` 스키마 변경 → `projects.json` 격리 위험(Option+default로 양방향 안전, 실기 확인). webp 등 200KiB 초과는 codec 부재로 거부 — 토스트로 이유 |
| 55 | 터미널 세션 헤더 Git 버튼 → 변경·로그 모달 | [55-terminal-git-dialog.md](55-terminal-git-dialog.md) | **M** | 조각(`ChangesPanel`·`CommitList`·`CommitDetailPane`·`DiffViewer`)은 전부 있으나 선택이 전역 `selectDiff`라 **모아보기를 닫아 버린다** → 두 컴포넌트에 optional `onSelect`·`active` prop으로 모달 로컬 선택, 우측 `DiffViewer`. `MemoDialog` 껍데기 복제, `selectBlockingOverlay` 등록(브라우저 셀 위), `App`+`AggregateWindow` 마운트. `BranchesPane` 제외 | 점유 계약 누락 시 브라우저 셀 뒤에 숨는다(e2e가 `selectBlockingOverlay` 직접 단언). `DiffViewer` 내부의 전역 `selectDiff` 경로(정의 이동)는 v1 수용 |
| 56 | 이미지 뷰어 ↑/↓ 이전·다음 이미지 | [56-image-viewer-arrow-nav.md](56-image-viewer-arrow-nav.md) | **S** | 박스에 `tabIndex`·`onKeyDown`은 있는데 **아무도 포커스를 안 준다** → 리마운트(`key={path}`) 시 `focus()` + ↑↓(←→) 처리. 형제는 `useDir(projectId, parentDir)` 캐시(트리와 같은 키·자연 정렬)에서 이미지만. **탭이 늘지 않게 `replaceDiff`**(활성 탭 제자리 교체, 중복 제거) 신설. 툴바 `n / N` | 포커스 훔치기 범위(리마운트 시점·hidden 무효로 한정). 임베디드 저장소 파일은 `keys.dir(합성id)` (검증 필요) — 실패 시 우아한 비활성 |
| 57 | 메모장 목록 드래그 정렬 | [57-memo-tab-reorder.md](57-memo-tab-reorder.md) | **S** | 순서는 이미 `notes.json`의 `Vec`가 영속하는데 UI가 `createdAt` 정렬로 무시하고 있었다 → 표시 = `reverse()`(기존 표시와 비트 동일, 마이그레이션 0), `reorder_memos`(안정 정렬 rank·tail = `reorder_projects` 복제), `ProjectList` 포인터 드래그 복제. HTML5 DnD 금지 관례 준수 | 후속이 `add_memo`를 `insert(0)`로 바꾸면 규칙이 깨진다 — 주석+e2e |
| 58 | "Claude Code 세션으로 새 터미널" | [58-claude-session-terminal.md](58-claude-session-terminal.md) | **S** | `term_open`에 명령 인자가 없고 `ptyWrite`는 비공개. 셸 무관하게 **키 입력과 같은 경로**로 `"claude\r"`를 open 완료·첫 출력 파싱(`onWriteParsed`) 뒤 1회 쓴다. 예약은 **localStorage**(`gp:term-initial-input`) — 별도 창이 요청해도 spawn한 창이 소비. 60초 만료로 세션 복구 시 재실행 방지. 메뉴 2곳(워크스페이스 `+`·모아보기 `+`) | 셸 초기화가 입력 버퍼를 비우는 경우 유실(pwsh/cmd/zsh 실기, 실패 시 300ms 지연) |
| 59 | 로컬 LLM 런타임 + 모델 다운로드 + 설정 AI 페이지 + 스트리밍 IPC | [59-local-llm-runtime.md](59-local-llm-runtime.md) | **L** | **AI 통합 0건에서 시작.** llama.cpp `llama-server`(Windows vulkan 35MB·mac 11MB·Linux cpu 17MB, `b10809` 자산 실측)를 ffmpeg식 관리형 다운로드(스트리밍 %·sha256·원자), GGUF는 HF tree API sha256 고정(Qwen3-4B Q4 2.5GB 기본, 카탈로그 배열 1곳). 프로세스는 `LspSession` 이식(단일·유휴 10분·kill_all·**Linux `systemd-run --scope`로 cgroup 분리**·난수 `--api-key`). `llm_chat(on_token: Channel)`이 SSE→토큰 스트림, 한 번에 한 요청. 외부 OpenAI 호환 URL 모드(Ollama)로 흡수. `lib/llm.ts`가 60·61의 유일한 계약 | Windows Vulkan 부재(RDP/VM) 자동 cpu 폴백 (검증 필요). 모델 mmap의 메모리 경보 오탐. e2e 29 카테고리 수 6→7 갱신 필수 |
| 60 | 작업 리포트(일/주/월 요약) + 잔디 히트맵 | [60-work-report-heatmap.md](60-work-report-heatmap.md) | **L** | 프롬프트 소스는 앱 PTY 히스토리가 아니라 **Claude Code 전사**(`~/.claude/projects/<encoded>/*.jsonl`, 경로 규약은 `claude_usage.rs`가 보유) — 앱 히스토리는 세션 한정·캡·삭제라 제외. Rust 3커맨드(`git_activity --since/--until/--author`, `commits_between`, `claude_prompts`) + `reports.json` 사이드 테이블. 모아보기와 같은 층의 전체 뷰(`reportOpen`), 53주×7 히트맵(`color-mix` accent 5단계), 카드별 스트리밍 요약·입력 해시로 "다시 생성". "잔디"는 **표시**(자동 커밋 아님) | 전사 필드 가정(`type`·`content`·`timestamp`·`tool_result`) — 실파일로 첫 단계 확정. 토큰 예산 초과 잘림(맵-리듀스는 업그레이드 경로). UTC/로컬 날짜 통일 |
| 61 | 로컬 LLM 번역(터미널·뷰어 선택 우클릭) | [61-llm-translate.md](61-llm-translate.md) | **S~M** | `PaneMenu`·`ChipMenu`·Monaco 액션 3진입 → 창별 `useUi.translate` → 비차단 고정 카드(26 호버 카드 층, `useOccludesWebview`) 스트리밍. 방향 자동(한글 비율 ≥ 0.2 → 영어) + 토글. Busy면 3초 폴링 대기. 호스트를 4창(메인·모아보기·플로팅·doc)에 마운트 | Busy 폴링과 60 배치 경합(대기 표시로 수용). Monaco 메뉴 그룹 id (검증 필요) |

### 11.1 권장 구현 순서

```
53 → 57 → 56 → 58        (S군 자기완결 — 서로 파일 겹침 0, 병행 가능)
   → 54 → 55              (55 헤더가 54의 ProjectLogo를 쓴다; 둘 다 AggregateTerminals 셀 헤더 — 순차)
   → 59 → [60 ∥ 61]       (59 계약 확정 뒤 병행 — 파일 겹침 0: report/* vs common/TranslateCard·PaneMenu·DiffViewer)
```
- **53↔58↔54↔55**: 넷 다 `AggregateTerminals.tsx`를 만진다(53 드롭다운, 58 `NewCellButton`, 54·55 셀 헤더). 같은 파일 순차 납품 —
  앵커는 줄번호가 아니라 라벨 문자열(`'…'에 새 터미널 열기`, `PromptLogButton termId={meta.id}`)로.
- **59 선행 게이트**: 런타임 다운로드 + Qwen3-4B로 "테스트" 응답 실측(토큰/s·첫 응답 지연)이 60·61의 프롬프트 예산·타임아웃의 입력이다.
  60 착수 첫 단계는 이 머신의 실제 전사 파일로 `claude_prompts` 파서 확정.
- **e2e 번호 배정**: 44 project-logo(54) · 45 git-dialog(55) · 46 image-arrow-nav(56) · 47 llm-runtime(59) · 48 report(60) ·
  49 translate(61); 53은 14 `#11e`, 58은 14 `#13`, 57은 05 절 추가. 36~41·43은 §10이 예약 중이라 건너뛴다.
- Rust 재빌드는 54·57(작은 것)과 59·60(큰 것) 두 번으로 묶는다.

### 11.2 사용자 결정이 필요한 열린 질문

| 태스크 | 질문 | 설계 기본값(미응답 시) |
|--------|------|------------------------|
| 60 | **"잔디 심기" = 활동 히트맵 표시**로 해석했다. 커밋을 자동 생성해 GitHub 잔디를 채우는 뜻이었는가 | 히트맵 표시. 자동 커밋은 하지 않음(저장소 이력 오염) |
| 60 | 프롬프트 히스토리 = Claude Code 전사(지속·프로젝트 귀속). 앱 자체 PTY 히스토리(비-Claude 셸)도 지속화해 포함할지 | 후속 — 전사만 |
| 59 | 기본 모델 Qwen3-4B Q4(2.5GB, RAM 8GB) vs 8B(5GB) | 4B 기본, 이 머신엔 8B 권장 뱃지 |
| 59 | CUDA 빌드(645MB) 옵션 | 제외 — Vulkan |
| 59 | 외부 서버 키를 OS 키링에 | 아니오(로컬 서버 키) |
| 55 | 로그 탭에 브랜치 패널 포함 | 제외 — "changes와 log"만 |
| 54 | 모아보기 칩·워크스페이스 탭 칩에도 로고 | 넣지 않음(칩 N개 소음) |
| 56 | doc 창(더블클릭 별도 창)에서도 ↑↓ | v1 제외(6줄이면 추가 가능) |
| 56 | ←/→도 같이 | 포함 |
| 58 | 실행 명령을 설정으로(`claude --continue` 등) | 상수 `"claude\r"` |
| 58 | 탭 제목 "Claude N" | 그대로 "터미널 N"(글로우가 구분) |
| 53 | 브라우저만인 묶음도 확인창 | 항상 확인 |
| 61 | 마크다운 뷰·메모장 선택도 번역 진입점 | 후속 |

### 11.4 구현 상태 (2026-09-08)

**53~61 아홉 태스크 전부 구현·검증 완료(미커밋).** 각 문서 §8에 상세. 정적 검증: `npx tsc --noEmit` exit 0,
`cargo test --lib` **226 passed / 0 failed**(기준선 222 + 신규 4), 신규 e2e 6개 `node --check` 통과.
e2e 실측(부분 실행 05·14·29·44·45·46·48·49, RAM 44%): **처음 22 fail → 최종 1 fail**(남은 1건은 LLM 런타임
미설치로 skip되는 요약 생성 경로). 실행 이력은 각 문서 §8.

**검증에서 잡힌 것 중 정적 검증이 절대 못 잡는 유형** — 이 절이 이번 라운드의 요점이다:

| 발견 | 성격 |
|---|---|
| **`allowProposedApi` 누락으로 앱의 터미널이 하나도 안 뜬다** — 커밋 `0036d06`(main 포함)이 `Unicode11Addon`을 붙이며 옵션을 안 켜, `loadAddon`이 던지고 `createTerminalImpl`이 통째로 중단됐다. **이번 태스크들과 무관한 기존 회귀**이며, e2e에서 터미널 스위트 10여 건이 무더기로 깨져 발견됐다(CDP로 `createTerminal`을 직접 불러 확정) | 릴리스 차단급 · 타 커밋 |
| **잔디와 카드가 같은 날에 다른 커밋 수를 보인다**(60) — `git log --since/--until`은 커미터 날짜로 거르는데 표시는 `%aI`(작성 날짜)다. 설계 §6이 "한계"로 적어 둔 것이 실제 화면에서 어긋났다 | 설계 문서의 한계 메모가 실제 결함이었던 경우 |
| **Ctrl+K가 커밋을 두 번 한다**(55) — 모달이 두 번째 `CommitForm`을 전역 단축키에 함께 바인딩 | 두 인스턴스 공존이 만드는 결함 |
| **보조 창이 메인 창의 뷰어 탭을 통째로 덮어쓴다**(55) — `gp:viewer-tabs` 영속 구독이 `float-*`만 제외했는데, 모아보기 창의 모달이 처음으로 `selectDiff` 경로를 열었다 | 데이터 손실 |
| **모듈 전역 컨텍스트를 복원하지 않는다**(55) — 모달이 정의 이동·포매터 컨텍스트를 덮은 뒤 닫혀도 메인 뷰어가 모달 프로젝트를 계속 가리킨다 | 언마운트 복원 누락 |
| **스트리밍 응답의 한글이 깨진다**(59) — SSE를 네트워크 청크마다 `from_utf8_lossy`로 디코드 | 정상 경로가 한국어인 기능 |
| **외부 LLM 서버 URL에 `/v1`이 두 번 붙는다**(59) — 안내 문구와 코드가 서로 다른 규약을 가정 | 수용 조건 도달 불가 |
| **메모를 집었다 제자리에 놓으면 맨 끝으로 간다**(57) — 드롭 대상 스캔이 끌고 있는 행 자신을 후보에 남긴다. **같은 잠복 결함이 출시된 사이드바 프로젝트 정렬에도 있어 함께 고쳤다** | 가장 흔한 제스처 |
| **"셸 첫 출력 후 전송" 가드가 Windows에서 무의미**(58) — ConPTY가 spawn 직후 `\x1b[?9001h`를 보내 첫 발화가 셸 출력이 아니다 | 설계 가정이 플랫폼에서 성립 안 함 |
| **배치 요약이 활동 없는 프로젝트에서 영원히 멈춘다**(60) — 이른 반환이 `finally`를 안 타 대기열이 전진하지 않는다 | 제어 흐름 |

**e2e에서 반복된 테스트 자체의 결함**(코드는 멀쩡한데 테스트가 틀린 유형): 원시 invoke로 만든 픽스처를
`["projects"]`에 반영하지 않아 화면이 그 프로젝트를 모름(44·48), 자기 자신과 비교해 항상 참인 단언(53·55),
전체 회차에서만 깨지는 픽스처 전제(55 — 04가 HEAD를 옮긴다), 두 비동기 시리즈 중 하나만 기다린 폴링(48),
사용자 설정(`gp:project-colors="0"`)을 전제하지 않은 단언(14 #12).

**로컬 LLM 실기 검증 완료(2026-09-08)**: 앱의 실제 커맨드로 런타임(35MB, 21초)과 최소 모델
(Qwen3-1.7B Q8, 1.8GB, 2분 30초)을 받아 끝까지 돌렸다. 첫 채팅 **18.1초**(서버 기동 + 모델 로드,
진행률 2초 간격), 두 번째 **4.0초**에 **같은 포트 재사용**, 취소 후 다음 호출 즉시 성공(in-flight 슬롯 해제),
`llm_stop` 뒤 `llama-server` 잔존 **0**. 요약(60)·번역(61)도 실제 모델로 스트리밍 확인.
그 과정에서 잡힌 결함: `repo://changed`가 잔디만 무효화하고 **카드의 커밋 목록을 빠뜨려** "입력이 바뀜"
제안이 영영 안 뜨던 것(60 §1 수용 조건 3).

**최종 e2e**: 05·14·29·44~49 부분 실행 — **187 pass / 0 fail / 5 skip**(`E2E_NET=1` + 모델 주입).
이후 45의 점유 계약 skip을 실측으로 바꿔 그 스위트는 skip 0. 남은 skip은 전부 환경 조건이다
(파일트리 패널 접힘 2건, 탭 모으기 모드에서 개별 칩 없음 1건, 픽스처 터미널 셀 없음 1건).

**미검증으로 남은 것**: 별도 창·플로팅 창에서의 실기 표시(모달·번역 카드가 그 창 안 브라우저 셀 위에
그려지는지), Vulkan→CPU 폴백, Linux `systemd-run --scope` 위임, 유휴 리퍼 10분, 각 문서 §5.2의 나머지.
**요약 품질 주의**: 1.7B 모델의 한국어 번역·요약은 눈에 띄게 거칠다(지시를 흘리거나 오역). 기본값인
4B 이상을 쓰는 것이 실사용 전제다 — 코드 결함이 아니라 모델 체급 문제.

### 11.3 공통 준수 사항 (53~61)

- **점유 계약**: 전체 화면 모달(55 `gitDialog`)은 `selectBlockingOverlay`에, 비차단 고정 카드(61)는 `useOccludesWebview`에 — 둘 중 하나는 반드시. 60의 리포트 뷰는 모아보기와 같은 층(모달 아님)이라 해당 없음.
- **창 간 상태는 localStorage 경유**(58 초기 입력·기존 `gp:doc-windows`) — `useUi`·`useTerminals`는 창마다 별개 인스턴스다. 별도 창에서 스토어를 직접 바꾸면 저장되지 않는다(53은 위임된 `closePane`만 쓴다).
- **Channel은 호출마다 새로**(59 `llm_chat`·다운로드 진행) — 재사용은 무증상 영구 정지(CLAUDE.md).
- **공급망**: 59는 "발견 우선(외부 URL) + 검증된 폴백(관리형 다운로드, 버전 pin + 코드 고정 sha256)" — 17·ffmpeg와 같은 원칙. 다운로드 버튼 옆에 크기·출처를 적는다(클릭이 곧 동의).
- **정적 검증만으로 통과 금지**: 53 위임 순서, 54 `projects.json` 호환, 56 포커스, 58 셸별 입력 타이밍, 59 Vulkan 폴백·유휴 종료·고아 0, 60 전사 파서 — 각 문서 §5.2 실기 필수.
- 같은 개념에 두 이름 금지: `ProjectLogo`(54), `GitDialogButton`/`openGitDialog`(55), `replaceDiff`(56), `queueInitialInput`(58), `lib/llm.ts chat`(59), `reportOpen`(60), `openTranslate`(61)가 정본 이름.

## 12. 리포트 다중 프로젝트 종합 · AI 채팅 · 별도 창 (67) — 2026-09-11

> 근거: 코드 실측 2026-09-11(HEAD f009ac4). 요구 3건을 태스크 1개로 — 셋 다 `components/report/*`를 만지고 B·C가 A의 카드 일반화를 전제한다.
> **문서 상태: 구현·검증 완료(2026-09-11, 미커밋)** — 상세 §8. Rust 변경은 `report.rs` emit 2곳 + `settings.rs` emit 1곳(별도 창의 설정 전파) — 별도 창 자체는 66의 `doc-*` 경로 재활용으로 Rust 0.
> e2e: 48 = **47 pass / 0 fail / 0 skip**, 회귀 14·34·60 = **125 pass / 0 fail / 1 skip**(탭 모으기 모드 환경 조건부), `cargo test --lib` 269 passed, `tsc --noEmit` 0.

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 67 | 리포트: 다중 프로젝트 종합(날짜별 3줄) · 우측 AI 채팅(수정본 저장) · 우클릭 "새 창으로 열기" | [67-report-multi-chat-window.md](67-report-multi-chat-window.md) | **M** | **A** `<select>` → 체크리스트(`gp:report-scope`), `ReportCard`를 `projects[]`로 일반화(같은 쿼리 키라 IPC 중복 0) + 종합 카드 1장, 키 `multi:<fnv16>`. 프롬프트를 **날짜별 섹션**으로 재조립하고 예산을 활동 날짜 수로 균등 분배·`llmContext`·기간별 `maxTokens`(768/1536/2048). **B** `ReportChat` 신설 — 카드 [AI에게 묻기]가 컨텍스트(요약+근거), 히스토리 8개 슬라이딩, 답변마다 [요약으로 저장](`## ` 있을 때만) + 카드 `text` 초기화 효과 1줄. `BUSY`는 문구만(폴링 없음). **C** 우클릭 메뉴 1항목 → `openReportWindow()` = `open_doc_window(docId:"report")` 싱글턴, `DocTarget.report` 분기(폴더 창 선례), 창 간 `report://changed` emit → `useReports` 훅 내 `setQueryData` | 3줄 강제는 모델 순종(1.7B 불가), 월간×5프로젝트 예산(날짜당 300자 — 맵-리듀스는 업그레이드 경로), 채팅 저장이 카드 로컬 `text`에 가려짐(효과 누락 시), 별도 창엔 설정 모달 없음(문구 분기) |

### 12.1 사용자 결정이 필요한 열린 질문

| 태스크 | 질문 | 설계 기본값(미응답 시) |
|--------|------|------------------------|
| 67 | 우클릭 **메뉴**(1항목) vs 모아보기처럼 우클릭 **즉시** 새 창 | 메뉴(요구 문구 그대로·파일트리 어휘). 모아보기 통일은 범위 밖 |
| 67 | 날짜당 "정확히 3줄" — 활동이 커밋 1개뿐인 날도 | 정확히 3줄. 억지 문장이 보이면 "적은 날은 3줄 이하"로 완화(문구 1곳) |
| 67 | 종합 카드를 "모두 생성" 배치에 포함 | 제외(개별 뒤 종합 1회 수동) |
| 67 | 채팅 대화 영속 | 메모리 — 남길 가치는 [요약으로 저장]이 담는다 |
| 67 | 별도 창이 메인의 기간·기준일을 승계 | 일간·오늘(스코프만 `gp:report-scope`로 공유) |
