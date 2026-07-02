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
