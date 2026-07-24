# README·웹사이트 리프레시 설계 — v0.3.2 반영 + 시안 리브랜딩 + 로고 통합

> 2026-07-24 · /sc:design 산출물. 코드베이스 전수 감사(3 에이전트, 파일:라인 증거 기반) 결과를 실행 가능한 스펙으로 정리.
> 구현 순서·변경 파일·완료 기준 포함. 구현은 별도 커밋에서.

---

## 0. 범위와 결정 요약

| 항목 | 결정 |
|------|------|
| README | v0.2.0 기준 문서를 v0.3.2로 — 정정 13건 + 신규 기능 16건 반영. 영문이 원본, ko는 동일 커밋에서 락스텝 |
| 웹사이트 색상 | 보라(#a855f7/#9333ea) 폐기 → **#4CB0FC / #B8FDFD / #FFFFFF** (사용자 지정 그라디언트). 토큰 2곳 값 교체로 사이트 전체 전환 — 컴포넌트 수정은 DownloadButtons.tsx 1개 파일뿐 |
| CTA 버튼 | **밝은 파랑 배경 + 다크 잉크 텍스트** (#09090b on #4CB0FC = 8.45:1). 흰 글자는 2.35:1로 탈락 |
| 로고 | Nav·Footer의 lucide `Command` 플레이스홀더를 실제 토끼 로고로 교체 + OG 이미지(1200×630) 신설 + apple-icon. **Hero에는 넣지 않음** (favicon은 이미 토끼 — 완료 상태) |

---

## 1. README 갱신 설계

### 1.1 정정 (현재 문서가 틀린 것) — 13건

영문 라인 기준. ko는 다운로드 섹션 이후 약 1줄 낮음.

| # | 위치 | 현재 claim | 실제 (증거) | 수정 |
|---|------|-----------|------------|------|
| 1 | L19 배지 | `version-0.2.0` | v0.3.2 (tauri.conf.json:4) | **동적 배지로 교체**: `img.shields.io/github/v/release/imtelloper/gitpervisor?style=flat-square` — 다시는 안 썩음 |
| 2 | L107 다운로드 표 | Windows `.msi or .exe` | release.yml:28 `--bundles nsis`만 — msi 미생산 | `.exe` (NSIS)로 정정 |
| 3 | L113 서명 노트 | "Builds aren't code-signed yet" | 반만 낡음: v0.3.2부터 업데이트 아티팩트는 minisign 서명 (tauri.conf.json:19-32, release.yml:82-83). OS 코드서명은 여전히 없음 (certificateThumbprint/signingIdentity 부재) | "인스톨러는 아직 OS 코드서명 전(SmartScreen/Gatekeeper 경고 유지). 단 **자동 업데이트는 minisign 서명 + 앱에 고정된 공개키 검증**" 으로 정밀화 |
| 4 | L53 불릿 | "MongoDB / SQL Server" | 6종 연결 가능 (ConnectionDialog.tsx:9-15, db.rs:277-307) | "MongoDB · PostgreSQL · MySQL · SQL Server · SQLite · Redis" |
| 5 | L91 DB 섹션 | "PG·MySQL·SQLite are on the way" | 전부 출시 + Redis. 서버측 read-only 강제(db.rs:363-379), PK 기반 셀 편집/행 삭제(db.rs:423-469) | 6종 명시 + read-only(백엔드 강제) + 그리드 편집 문구로 재작성 |
| 6 | L97 Extras | "CPU/MEM" · "Darcula/Monokai" | 테마 6종 (themes.ts:9-15), 타이틀바 CPU/GPU/RAM/디스크 + 클릭 시 프로세스 팝업 (SysMonitor.tsx:71-83) | 6테마 나열 + 모니터 문구 갱신. L221 테크스택 "(Darcula/Monokai tokens)"도 함께 |
| 7 | L148 단축키 표 | 8개만 | KeyboardShortcuts.tsx: `mod+P` Quick Open, `mod+Alt+N` Go to Symbol, `mod+Shift+F` Find in Files, `mod+Shift+A` 모아보기, `Ctrl+S` 저장(DiffViewer.tsx:314), `Ctrl+W` 탭 닫기 | 6행 추가 + "mod = macOS Cmd" 주석 |
| 8 | L225 테크스택 | "mongodb + tiberius" | + sqlx(PG/MySQL/SQLite) + redis (Cargo.toml:44-54) | DB 행 갱신 |
| 9 | L234 보안 | "auto-fetch is off by default" | **기본 ON, 5분 간격** (types.rs:244, fetch_scheduler.rs:81) — 단 fetch만, 쓰기는 여전히 명시적 | "쓰기는 전부 명시적 버튼. 배경 fetch는 ↑↓ 배지 갱신용으로 5분마다(Settings에서 0=off), fetch는 워킹트리를 건드리지 않는 유일한 원격 명령" |
| 10 | L236 보안 | "only dialog · opener · store" | 플러그인 7종으로 증가, opener 제거됨. CSP 적용(tauri.conf.json:15) + v0.3.1 하드닝(브라우저 URL RCE·diff 경로·DB read-only·CI SHA 고정) | 2불릿으로 교체: "**앱 웹뷰 strict CSP** — 외부 웹은 IPC 없는 격리 child webview에서만" + "**IPC 표면 하드닝** — 경로 정규화·컨테인먼트, DB read-only Rust 강제, CI 액션 SHA 고정" |
| 11 | L250 로드맵 | "[ ] More DB engines" | 완료+Redis | 체크 처리 후 접기. 신규 항목: "[ ] OS 코드서명 인스톨러" 추가 |
| 12 | L253 로드맵 | out-of-scope "file editing (viewer only)" | 뷰어가 편집기가 됨: Ctrl+S 저장·format-on-save·LSP 11개 언어군 (DiffViewer.tsx:248-316, lsp/acquire.rs) | 해당 항목만 제거 (머지 UI·인터랙티브 리베이스·그래프 레인·GitHub API는 유지) |
| 13 | L33 스크린샷 | main-screen-v2.png | UI 드리프트: 새 로고·사용량 바·타이틀바 게이지·API 클라이언트 탭 미반영 | **v0.3.2에서 재캡처 → designs/main-screen-v3.png**, 양쪽 README 링크·캡션 교체 |

### 1.2 신규 추가 — 16건 (배치·비중)

영문 초안은 감사 산출물에 준비됨(README 보이스에 맞춘 bold-lead 문단). 비중별 배치:

**헤드라인급 — 새 feature 섹션 신설:**
- **📝 Code editor & LSP** — Monaco 편집 + Ctrl+S 저장 + LSP 11개 언어군(자동 다운로드/PATH 발견) + Quick Open/Go to Symbol/Find in Files. *"viewer only" 프레임을 대체하는 가장 큰 서사 변화.* 상단 소개문(L7)과 "Why" 불릿에도 반영
- **🔁 Auto-update** — Settings › Updates 원클릭, minisign 서명 검증. Download 섹션에도 한 줄
- **📡 API client** — Postman 스타일 탭, Rust 백엔드 실행(CORS 무관), 컬렉션·환경변수 (src/components/apiclient/)
- **🧮 Terminal aggregate view(모아보기)** — `mod+Shift+A`, 전 프로젝트 터미널 타일 + AI 활동 배지. 에이전트 감지의 자연스러운 동반 기능
- **📊 Resource monitor** — 작업관리자급 팝업: 프로세스별 CPU/RAM/디스크/GPU, 아이콘, 검색, End task(트리 포함)

**기존 섹션 확장:**
- 🤖 AI 감지 섹션 끝에: **작업 완료 알림**(OS 토스트에 에이전트 마지막 메시지 본문) + **Slack webhook / SMTP 릴레이** (agent-notify.ts:51-98, NotifySection.tsx)
- 🗂️ 멀티레포 섹션에 한 줄: **중첩(임베디드) git repo 1급 취급** (projects.rs:20 합성 id)
- 🌐 브라우저 섹션에 한 줄: **OAuth 팝업 플로팅 창 승격 + 로그인 세션 영속**(격리 프로필)
- 🔍 diff 섹션에 한 줄: **Untracked는 all-green diff 대신 파일뷰**

**Extras 라인 추가 (한 줄씩):**
Claude 사용량 바(세션 5h·주간) · macOS 격리(quarantine) 스캐너 · 파일트리 파워기능(멀티선택·일괄 이미지 변환·이미지 에디터·exe 실행·드래그 복사) · 프로젝트 경로 복구/새 폴더/뷰 상태 기억 · .env 구문 강조 · 크래시 로깅 · Rust target/ 크기 표시+cargo clean

### 1.3 한국어 패리티

ko는 v0.2.0 시점 1:1 번역본으로 확인됨(동일 구조, 같은 낡은 주장 미러링). **전략: 영문을 원본으로 모든 편집을 같은 커밋에서 양쪽 적용.** suggestedCopy는 ko 파일의 기존 간결체로 번역, 앱 UI 용어 사용(모아보기 등). 규칙: "README를 건드리는 커밋은 둘 다 건드리거나 둘 다 안 건드린다."

---

## 2. 웹사이트 색상 리브랜딩 (보라 → 시안)

### 2.1 새 팔레트와 토큰 매핑

사용자 지정: `#4CB0FC (0%) → #B8FDFD (60%) → #FFFFFF (100%)`

globals.css `@theme` (L20-23) 값만 교체 — Tailwind 유틸(text-accent, bg-accent/10, ring-accent…)과 color-mix가 전부 자동 상속:

| 토큰 | 현재 | 새 값 | 근거 |
|------|------|-------|------|
| `--color-accent` | #a855f7 | **#4CB0FC** | 다크 위 텍스트 5.02→**8.45:1 (AAA)**. 카드(#18181b) 위 7.52, 패널 위 7.87 — 전 사용처 개선 |
| `--color-accent-strong` | #9333ea | **#4CB0FC** | accent와 동일값. CTA 배경 별칭으로만 생존(클래스명 유지 목적) |
| `--color-cyan` | #06b6d4 | **#B8FDFD** | 삭제 아닌 재지정: .glow-cyan, .ring-gradient 2번째 스톱, AppMockup text-cyan/from-cyan이 무수정 생존. 다크 위 17.53:1 |
| `--color-pink` | #ec4899 | **삭제** | 사용처 0곳 확인(dead token). 목업 대비색은 green/yellow/red로 충분 |

**하드코딩 hex 정리 (globals.css 내부만):**
- `.text-gradient` (L53): `#fafafa 0% → #d8b4fe 45% → accent 100%` ⇒ **`#fafafa 0% → #B8FDFD 40% → var(--color-accent) 100%`** — 사용자 그라디언트를 다크 배경용으로 반전(흰→연시안→파랑). 최암 스톱 8.45:1이라 h1 그라디언트 꼬리도 AA 통과
- `::selection` (L47): 무수정 — color-mix가 새 accent 상속, 35% #4CB0FC over 다크 ≈ #1b3f5f, 흰 글자 고대비 유지
- `.ring-gradient` (L92): 무수정 — accent→transparent→cyan이 #4CB0FC→transparent→#B8FDFD로 자연 전환

### 2.2 WCAG 검증 (계산 완료)

| 조합 | 비율 | 판정 | 용도 |
|------|------|------|------|
| #4CB0FC on #09090b | **8.45** | AAA | accent 텍스트·아이콘·포커스링 |
| #B8FDFD on #09090b | 17.53 | AAA | 그라디언트 중간·터미널 run 톤 |
| **#09090b on #4CB0FC** | **8.45** | **AAA** | **CTA 버튼 (채택)** |
| #FFFFFF on #4CB0FC | 2.35 | ✗ 전면 탈락 | — |
| #FFFFFF on #1d7fd1 | 4.19 | ✗ AA 미달 | 진파랑 후보 기각 |
| #FFFFFF on #0b6cc4 | 5.30 | AA | 통과하나 팔레트 밖 남색 발명 — 기각 |
| 참고: 현 보라 CTA #fff on #9333ea | 5.38 | AA | 새 버튼 8.45가 상회 |

**CTA 결정: 밝은 파랑 배경 + 다크 잉크.** 팔레트 안에서 해결되고, 현 보라 버튼보다 대비가 좋고, hover:brightness-110이 대비를 올리는 방향으로 작동.

### 2.3 변경 파일 — 정확히 2개

1. **`website/app/globals.css`** — @theme 4토큰(위 표) + .text-gradient 스톱. 이것으로 Nav/Hero/Features/OpenSource/FinalCta/Footer/AppMockup/page.tsx 35개 사용처 전부 전환 (하드코딩 보라 hex는 globals.css 밖에 없음 — 전수 확인)
2. **`website/components/DownloadButtons.tsx`** — 잉크 반전 3곳:
   - L67: `bg-accent-strong text-white` → `bg-accent-strong text-base` (주 CTA)
   - L77: `text-white/90` → `text-base/80` (확장자 서브라벨, ≈6:1+ 유지)
   - L120: 동일 스왑 (FinalCta의 DownloadCta)
   - `shadow-accent/50`·`hover:brightness-110`은 무수정

---

## 3. 로고 통합 (웹사이트)

### 3.1 현재 상태 (확인됨)

- 로고 자산: `public/logo.png` 512×512 (검은 라운드 사각 + 홀로그램 디스크 + 토끼). `src-tauri/icons/source-logo.png`는 **바이트 동일** — 디스크 단독 버전은 존재하지 않음
- **favicon은 이미 토끼** (website/app/favicon.ico ≡ src-tauri/icons/icon.ico, 커밋 7e6bf71) — 완료
- Nav(Nav.tsx:11-13)·Footer(Footer.tsx:11-13)는 lucide `Command` 플레이스홀더 + 보라 틴트 타일
- **OG/트위터 이미지 전무** — `card: summary_large_image` 선언만 있고 이미지 없어 소셜 공유가 이미지 없이 렌더 (layout.tsx:30-41). metadataBase는 설정돼 있어 상대경로 사용 가능
- apple-touch-icon 없음. website/public에는 Next 기본 SVG만

### 3.2 적용 지점

| 지점 | 파일 | 변경 | 자산 |
|------|------|------|------|
| **Nav 브랜드 마크** | Nav.tsx:11-13 | 틴트 타일+Command 제거 → `<img src="/logo.png" alt="" width={28} height={28} className="h-7 w-7 rounded-lg" />` (aria-hidden 성격 — 워드마크가 접근성 이름). 미사용 `Command` import 제거(`Star`는 유지) | `Copy-Item public/logo.png website/public/logo.png` |
| **Footer** | Footer.tsx:11-13 | 동일 스왑 24px (`h-6 w-6 rounded-md`, 선택적 opacity-90) + import 정리 | Nav 것 재사용 |
| **Hero** | — | **안 넣음.** 헤드라인+목업이 초점인 밀집 구성이고 16px 위 Nav에 로고가 이미 보임 — 이중 브랜딩 회피 | — |
| **OG 이미지** | layout.tsx:30-41 + `website/public/og.png` 신설 | `openGraph.images: [{url:"/og.png",width:1200,height:630}]` + `twitter.images`. **정적 PNG** (next/og ImageResponse는 래스터 홀로그램 재현 불가·불필요한 런타임) | 1200×630 신규 제작: #09090b 캔버스, 로고 ~200px, 뒤에 #4CB0FC 라디얼 글로우, 'Gitpervisor' 워드마크 #fafafa + 태그라인(accent 워드 #4CB0FC). sharp/ImageMagick 합성 — 신규 아트웍 없음 |
| **apple-touch-icon** | `website/app/apple-icon.png` 신설 | 파일 컨벤션이라 **코드 수정 0** — Next가 `<link rel="apple-touch-icon">` 자동 방출 | `magick src-tauri/icons/icon.png -background "#000000" -alpha remove -resize 180x180 …` — **투명도 평탄화 필수** (iOS가 알 수 없는 알파를 임의 합성) |

### 3.3 팔레트 조화 가이드

시안 전환은 로고와의 조화를 **개선**한다 — 디스크의 지배 밴드가 정확히 그 파스텔 시안 계열이라 새 accent가 "로고에서 뽑은 색"으로 읽힘 (보라는 그렇지 않았음).

- **≤32px (Nav·Footer·favicon)**: 홀로그램이 진주빛 디스크로 뭉개져 개별 핑크/노랑이 식별 불가 — 무처리 풀컬러 OK. 검은 사각은 #09090b에 녹아 플레이트 안 보임(모서리 진짜 알파라 헤일로 없음)
- **대형 (OG ~200px)**: 핑크 밴드가 제2 액센트로 분리됨. 완화책 — ① 순수 #09090b 여백으로 감싸 로고를 프레임 내 유일한 다색 요소로, ② 뒤에 #4CB0FC 라디얼 글로우(시안 밴드 증폭 → 핑크가 "무지개빛"으로 읽힘), ③ 카드 표면(#18181b)·채도 높은 시안 인접 배치 금지(검은 플레이트 가시화)

---

## 4. 구현 순서 (제안)

| 단계 | 내용 | 규모 |
|------|------|------|
| 1 | 웹사이트 색상: globals.css 토큰 + DownloadButtons 잉크 3곳 | 파일 2, ~10줄 |
| 2 | 로고: logo.png 복사, Nav/Footer 스왑, apple-icon.png 생성 | 파일 4 |
| 3 | og.png 합성 + layout.tsx 메타데이터 | 파일 2 |
| 4 | 스크린샷 재캡처 (main-screen-v3.png) — **README보다 먼저** (README가 참조) | 자산 1 |
| 5 | README.md 전면 갱신 (정정 13 + 신규 16) | 파일 1 |
| 6 | README.ko.md 락스텝 번역 | 파일 1 |

1-3은 웹사이트 단위로 한 커밋(→ Vercel 자동 배포로 즉시 확인), 4-6은 README 단위로 한 커밋 권장.

## 5. 오픈 이슈

- **스크린샷 재캡처는 수동 개입 필요** — v0.3.2 실행 상태에서 새 로고·사용량 바·타이틀바 게이지·API 탭이 보이도록. 단계 5의 유일한 외부 의존
- og.png 태그라인 문구는 구현 시 확정 (현 사이트 hero 카피 재사용이 기본값)
- 대형 로고에서 "디스크만" 버전이 필요해지면 원형 크롭으로 기계 생성 가능 — 현 설계의 배치에는 불필요
