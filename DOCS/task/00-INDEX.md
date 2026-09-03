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
| 28 | 프로젝트 색 공유 모듈 + 사이드바 행 배경 | [28-project-colors.md](28-project-colors.md) | **S~M** | `lib/project-color.ts` 신설(팔레트·`assignProjectHues` + 슬롯 소진 시 `taken.clear()`·`projectTint(hue, "off"\|"on"\|"row"\|"row-on")`·`useProjectHues()` 전체 프로젝트 이름순 배정)로 사이드바 행·모아보기 칩·셀 헤더가 한 맵을 본다. 행 배경은 `--tint/--tint-hover` 변수 + `bg-(--tint) hover:bg-(--tint-hover)`(Tailwind 4.3 실증). **대비 목표 재정의**: 절대 4.5/4.5/3.0은 오늘의 행도 못 넘어(darcula dim 2.90) "fg ≥ 4.5 + muted/dim은 현행 bg-selection 기준선 이상" — 초기 알파 다크 .28/.35·라이트 .10/.15·solarized-light .06/.10 | Tailwind가 조립 클래스를 스캔 못 해 배경 투명인데 tsc는 통과하는 유형(e2e computed backgroundColor 가드). solarized-light는 selection≈panel이라 보이는 틴트가 전부 기준선 아래 — 거의 안 보이는 알파 vs 선택행 fg-muted 4.04→3.72 중 택일 |

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
| 28 | solarized-light 알파 — 상대 기준선 준수 .06/.10 vs 라이트 공통 .10/.15 vs 틴트 0 | .06/.10 별도 블록 |
| 28 | 다크 row-on .35 단일 vs monokai·dracula·nord만 .5 | .35 단일 |
| 28 | 프로젝트 추가·제거 시 색 이동 수용 vs `gp:project-hue` 영속 | 결정적 배정(실기 기록으로 판단) |

### 7.3 공통 준수 사항 (23~28)

- **정적 검증만으로 통과 금지** — 각 문서 §7.2 실기 필수(hover 가시성·클램프·점유·대비는 e2e가 못 본다).
- **fixed 팝오버/카드는 전부 `useOccludesWebview` 점유 등록**(26 `!!entry`, 27 기존 호출에 `|| !!layoutMenu`).
- **공유 어휘·상수의 정의 문서는 하나**: 메뉴 라벨(24), PromptHistoryButton title(25 §3.3), `projectTint` level 인자(28), 아이콘 Grid2x2/Columns3(27), 클램프 448/248(24).
- 같은 파일은 순차 납품 — 구현 시 앵커는 줄번호가 아니라 라벨 문자열·심볼로 잡고 각 문서 §5의 밀림 표를 참고.
- `stores/ui.ts`·`main.tsx`·`cdp.mjs`는 태스크 20~22의 미커밋 변경 위에 얹는다 — HEAD 체크아웃·리베이스 금지.

## 8. 테마·이미지 창·시스템 정보·Windows 터미널 (29~33) — 2026-09-03

> 근거: 코드 실측 2026-09-03(xterm 6.0.0·portable-pty 0.8.1·sysinfo 0.33 로컬 소스, NuGet ConPTY 패키지 내용 포함).
> Rust 변경은 30(창 수명 1줄·창 크기 인자)·31(수집 커맨드)·33(ConPTY 사이드로드) 세 건 — 한 번의 재빌드로 묶는다.

| # | 태스크 | 문서 | 규모 | 핵심 판단 | 주요 위험 |
|---|--------|------|------|-----------|-----------|
| 29 | 사용자 정의 테마(색 조합) | [29-custom-themes.md](29-custom-themes.md) | **M** | 기반 테마 + 18토큰 오버라이드. 정의는 localStorage `gp:custom-themes`(선례 `gp:term-themes`), 적용은 `<style id="gp-custom-themes">`에 `:root[data-theme="custom-…"]` 블록 생성 → `dataset.theme` 관례·xterm `readTheme`·보조 창 코드 무변경. Monaco는 기반 규칙 복사 + 토큰 colors로 동적 defineTheme. Rust 0 | `BUILTIN_TOKENS` 사본이 styles.css와 어긋남(e2e 19 짝 검증), 라이트 기반의 틴트 5변수 사본, `.ai-working` 라이트 글로우 미적용(장식) |
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
