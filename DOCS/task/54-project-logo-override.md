# 태스크 54 — 프로젝트 로고: 파일 트리 이미지 우클릭으로 지정 + 사이드바·툴바·모아보기 셀 헤더 표시

> 상태: **설계** (2026-09-07) · 대상: gitpervisor · 근거: 코드 실측 2026-09-07(워킹트리 기준) ·
> 선행: v0.4.x 로고 자동 감지(`commands/logo.rs`), 태스크 36(셀 헤더 색) · **Rust 변경: 커맨드 1개 + 필드 1개**

## 1. 요구사항

1. 파일 트리에서 **이미지 파일을 우클릭 → "프로젝트 로고로 지정"** 하면 그 이미지가 PROJECTS 사이드바 행의
   로고 아이콘이 된다. 앱을 재시작해도 유지된다.
2. 같은 로고가 **터미널 세션 좌측 상단의 프로젝트 이름 옆**에도 보인다 — 워크스페이스 툴바(`Toolbar.tsx:92`)와
   모아보기 셀 헤더(`AggregateTerminals.tsx:1295-1325`) 두 곳.
3. 지정을 해제하면 기존 자동 감지(레포의 `logo.png` 등)로 돌아간다.

받아들이는 조건:
- 트리 메뉴 항목은 이미지 파일(svg 포함)에만 보인다. 지정 직후 사이드바·툴바·셀 헤더가 즉시 갱신된다(재시작 불필요).
- 로고로 쓸 수 없는 파일(4MiB 초과, 디코드 불가 형식 200KiB 초과)은 **에러 토스트**로 이유를 말한다 — 조용히 무시하지 않는다.
- PROJECTS 행 우클릭 메뉴에 "로고 해제" 항목(지정된 경우에만).
- 지정 파일이 사라지면 자동 감지로 폴백한다(빈 아이콘이 아니라).

## 2. 현황(근거)

- **로고 시스템은 이미 있다 — 자동 감지 전용이다.** `src-tauri/src/commands/logo.rs`:
  `project_logo(project_id) -> Option<ProjectLogo{data_uri, source}>`(`:273-284`, `spawn_blocking` 1회),
  `find_local_logo(repo)`(`:234-269`, 후보 396경로 → 얕은 스캔), `encode_logo(bytes, rel)`(`:96-116` — SVG·≤200KiB는
  그대로, 큰 래스터는 `image` 크레이트로 64px PNG 썸네일; **codec은 png·jpeg만**, `Cargo.toml:101/124`),
  한도 `MIN_BYTES 512`·`READ_MAX 4MiB`(`:34-36`), 심볼릭 링크 거부 + `resolve_in_repo`(`:240-249`).
- 프론트: `ipc.projectLogo`(`ipc.ts:1242-1243`), `useProjectLogo(projectId)`(`queries/index.ts:509-517`,
  키 `["project-logo", id]`, `staleTime: Infinity`, **어디서도 무효화하지 않는다**).
  `ProjectItem.tsx:128-137`이 `<img className="h-4 w-4 shrink-0 rounded-sm object-contain" src={logo.data.dataUri}
  title={`로고: ${source}`}>`를 StatusDot과 이름 사이에 그린다(`:57-58` 주석: 상태점을 대체하지 않는다).
- **프로젝트 모델에 로고 필드가 없다.** `git/types.rs:3-11` `Project{id,name,path,order,added_at}` — `#[serde(default)]`
  없음. 로드 실패 시 `projects.json` → `.corrupt` 격리(`state.rs:165-171`). 필드 갱신 선례 = `update_project_path`
  (`projects.rs:206-246`: write lock → 수정 → `save_projects` → `Project` 반환) + 프론트 `useUpdateProjectPath`
  (`queries/index.ts:840-856`: `setQueryData(keys.projects)` + invalidate + 토스트).
- 트리 메뉴: `FileTreePanel.tsx:1228-1346` 파일 분기. `MenuItem{icon,label,onClick,danger?}`(`:390-414`), 이미지
  게이트 `menuIsImage = !isDir && isImage(name) && !svg`(`:1108-1111` — 변환·편집용이라 svg 제외). `menu.path`는
  outer 레포 기준 forward-slash 상대경로(`:123-131`). `isImage`·`IMAGE_EXT`(`language-map.ts:72-94`, svg 포함).
- 프로젝트 행 메뉴: `ProjectList.tsx:451-521`, `MenuItem`(`:47-69`), 항목 10개.
- 표시처: 툴바 `Toolbar.tsx:92` `<span className="font-semibold">{project.name}</span>`; 모아보기 터미널 셀 헤더
  `AggregateTerminals.tsx:1295-1325`(h-6=24px, `StatusIcon` → projName · title), 브라우저 셀 `:1373-1394`(Globe 선행).
  워크스페이스 pane(`TerminalPane.tsx`)에는 프로젝트명 헤더가 **없다** — 요구의 "세션 좌측 상단"은 툴바와 셀 헤더다.
- 유사 소형 이미지 컴포넌트: `workspace/Favicon.tsx:5-27`(`<img width height object-contain>` + Globe 폴백).

## 3. 설계

### 3.1 저장 위치

| 대안 | 평가 |
|---|---|
| **A. `Project.logo: Option<String>`(레포 상대경로) 필드 추가 + `set_project_logo` 커맨드** (채택) | 선례 `update_project_path` 그대로. `Option` 필드는 serde가 누락 시 `None`으로 채우므로(`#[serde(default)]`를 필드에 붙여 명시) 옛 `projects.json`이 그대로 읽힌다. 옛 앱은 모르는 키를 무시한다(`deny_unknown_fields` 없음) — 다운그레이드 시 다음 저장에서 사라질 뿐 격리되지 않는다 |
| B. `notes.json`식 사이드 테이블 `logos.json` | 파일·로드·세이브·AppState 필드 4곳 신설. 필드 하나에 과하다 |
| C. 이미지 바이트(data URI)를 저장 | `projects.json`이 수백 KiB로 부풀고 파일이 바뀌어도 안 따라온다. 경로만 저장하고 읽기는 기존 `encode_logo` 경로 |

### 3.2 Rust

```rust
// git/types.rs Project
#[serde(default)] pub logo: Option<String>,   // 레포 상대경로(forward-slash). None = 자동 감지

// commands/logo.rs
#[tauri::command]
pub async fn set_project_logo(app, state, id: String, rel_path: Option<String>) -> Result<Project, IpcError>
```
- `rel_path = Some(rel)`: `project_path` → `resolve_in_repo(repo, &rel)` → `symlink_metadata` 정규 파일·`len ≤ READ_MAX`
  → `std::fs::read` → `encode_logo(&bytes, &rel).is_some()`이 아니면 `Err(ErrorCode::Invalid, "로고로 쓸 수 없는 파일 —
  png/jpeg는 4MiB, 그 외 형식은 200KiB까지")`. 통과하면 `p.logo = Some(rel)` + `save_projects` + `Project` 반환.
  **검증을 저장 전에 한다** — 저장하고 나서 표시가 안 되는 상태를 만들지 않는다.
- `rel_path = None`: `p.logo = None` + 저장.
- `project_logo`(`:273-284`) 앞단에 분기: `if let Some(rel) = project.logo` → 위 읽기 경로로 `Some(ProjectLogo{source: rel})`;
  실패(파일 삭제·이동)면 로그 한 줄 + **기존 `find_local_logo` 폴백**(요구 3). `source`는 상대경로 그대로라 프론트 title
  "로고: assets/icon.png"가 자동으로 맞는다.
- `MIN_BYTES`(512)는 수동 지정엔 적용하지 않는다 — 작은 svg 아이콘이 흔하다.

### 3.3 프론트

- `ipc.ts`: `Project.logo?: string | null`; `setProjectLogo(id, relPath: string | null) => call<Project>("set_project_logo", …)`.
- `queries/index.ts`: `useSetProjectLogo()` — `useUpdateProjectPath` 복제: onSuccess `setQueryData(keys.projects, 교체)` +
  `invalidateQueries(["project-logo", id])`(이 키의 **첫 무효화 지점**) + 토스트 "로고를 지정했습니다"/"로고를 해제했습니다";
  onError 토스트(errorMessage).
- 트리 메뉴(`FileTreePanel.tsx` 파일 분기, '이미지 편집' 블록 뒤): `MenuItem icon={ImageIcon} label="프로젝트 로고로 지정"`,
  게이트 **`!menu.isDir && isImage(menu.name)`**(svg 포함 — `menuIsImage`와 다르다, 별도 상수 `menuIsLogoable`).
  onClick → `setLogo.mutate({ id: projectId, relPath: menu.path })`. `projectId`는 패널 prop(outer) — 임베디드 저장소
  파일도 outer 상대경로라 그대로 맞다.
- 행 메뉴(`ProjectList.tsx:451-521`): `project.logo && <MenuItem icon={ImageOff} label="로고 해제" onClick=… relPath:null/>`.
- **`ProjectLogo` 공용 컴포넌트 신설** `src/components/common/ProjectLogo.tsx`:
  ```tsx
  export function ProjectLogo({ projectId, size = 16, className }: {…}) {
    const { data } = useProjectLogo(projectId);
    if (!data) return null;
    return <img src={data.dataUri} width={size} height={size} alt="" aria-hidden draggable={false}
                title={`로고: ${data.source}`} className={`shrink-0 rounded-sm object-contain ${className ?? ""}`} />;
  }
  ```
  `ProjectItem.tsx:128-137`의 인라인 `<img>`를 이것으로 교체(동작 동일), 툴바 `Toolbar.tsx:92` 이름 앞에 `size={16}`,
  모아보기 터미널 셀 헤더 `:1300` `StatusIcon` 뒤에 `size={14}`(h-6 헤더 — 16은 빡빡하다), 브라우저 셀도 동일.
  `useProjectLogo`는 react-query 키 공유라 셀 20개가 떠도 IPC는 프로젝트당 1회.
- 모아보기 칩(`Chip`·묶음 칩)은 **넣지 않는다**(§7 열린 질문).

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src-tauri/src/git/types.rs` | `Project.logo` 필드 | +2 |
| `src-tauri/src/commands/logo.rs` | `set_project_logo` 신설, `project_logo`에 수동 분기·폴백, `encode_logo` 재사용 | ≈ +55 |
| `src-tauri/src/lib.rs` | invoke_handler 등록 | +1 |
| `src/lib/ipc.ts` | 타입·바인딩 | +6 |
| `src/queries/index.ts` | `useSetProjectLogo` | ≈ +22 |
| `src/components/common/ProjectLogo.tsx` | 신설 | ≈ +18 |
| `src/components/sidebar/ProjectItem.tsx` | 인라인 img → `<ProjectLogo>` | −10/+1 |
| `src/components/sidebar/ProjectList.tsx` | "로고 해제" 항목 | ≈ +8 |
| `src/components/tree/FileTreePanel.tsx` | "프로젝트 로고로 지정" 항목 + 게이트 | ≈ +12 |
| `src/components/toolbar/Toolbar.tsx` | 이름 앞 로고 | +1 |
| `src/components/AggregateTerminals.tsx` | 셀 헤더 2곳 | +2 |
| `tests/e2e/suites/44-project-logo.mjs` | 신설(§5) | ≈ +70 |

`add_project`가 만드는 `Project` 리터럴에 `logo: None` 1줄(컴파일이 잡는다).

## 5. 검증

### 5.1 e2e 44 `44-project-logo.mjs`
1. 픽스처 레포에 200×200 PNG 1개 쓰기(30-image-annotate 픽스처 관례) → `list_dir` 무효화.
2. 트리 행 `[data-tree-file="<path>"]`에 `contextmenu` → 메뉴에 "프로젝트 로고로 지정" 존재(svg 파일에도 존재, 폴더엔 없음) → 클릭.
3. 폴링 3s: `get_settings`가 아니라 `list_projects`의 해당 `logo === path`; 사이드바 `[data-project-id] img[title^="로고: "]`의 title이 `로고: <path>`; 툴바 `img[title="로고: <path>"]` 존재.
4. 모아보기 열기 → 셀 헤더 `img[title="로고: <path>"]` 존재 → 닫기.
5. 500KiB **webp**를 지정 → 에러 토스트 문구 포함 "로고로 쓸 수 없는 파일", `logo` 불변.
6. 행 우클릭 → "로고 해제" → `logo === null`, img title이 자동 감지 값(또는 img 없음).
7. finally: 픽스처 파일 삭제, 로고 null.

### 5.2 실기
- 지정 직후 세 표시처 즉시 갱신(무효화 확인). 앱 재시작 후 유지.
- 지정 파일을 탐색기에서 삭제 → 다음 `project_logo`(재시작 또는 무효화)에서 자동 감지로 폴백, 에러 없음.
- svg 지정(≤200KiB) → 그대로 표시. 3MiB jpeg → 64px 썸네일.
- 옛 `projects.json`(logo 키 없음) 로드 → 격리 없음(`.corrupt` 미생성).

## 6. 위험

- `Project` 구조체 변경은 `projects.json` 호환에 직결된다 — `Option` + `#[serde(default)]`로 양방향 안전. 회귀 확인은 5.2 마지막 항목.
- `useProjectLogo`가 처음으로 무효화되는 키가 된다 — 자동 감지 결과는 여전히 세션 캐시(변경 없음).
- 셀 헤더 24px에 14px 이미지 — 정사각이 아닌 로고는 `object-contain`으로 여백. 스트라이프·상태 아이콘과 겹치지 않는다.

## 7. 열린 질문

| 질문 | 기본값 |
|---|---|
| 모아보기 칩·묶음 칩에도 로고(12px) | 넣지 않음 — 칩 N개에 이미지 N개는 소음. 원하면 `Chip` 1줄 |
| 워크스페이스 탭 칩(`TabChip`)에 로고 | 넣지 않음 — 탭 바는 이미 프로젝트 단위 |
| 로고 지정 시 정사각 크롭 옵션 | 없음 — `object-contain` |
| 지정 파일 변경 감시(`repo://changed`로 `project-logo` 무효화) | 하지 않음 — 자동 감지도 안 한다. 필요하면 `events.ts` 1줄 |

## 8. 구현 결과 (2026-09-07~08)

**구현 완료 · 정적 검증 통과(미커밋).** 설계대로 A안 — `Project.logo: Option<String>` 한 필드 + 커맨드 1개.

- `git/types.rs`: `#[serde(default)] pub logo: Option<String>`(옛 `projects.json` 격리 방지). `projects.rs`의 `add_project` 리터럴에 `logo: None`.
- `commands/logo.rs`: `read_manual_logo`(심볼릭 거부·`READ_MAX`·`MIN_BYTES` 미적용) 신설, `set_project_logo`가 **저장 전** `encode_logo`로 검증해 실패 시 거절, `project_logo`는 수동 우선 + 파일이 사라지면 자동 감지로 폴백.
- 프론트: `ipc.setProjectLogo`·`useSetProjectLogo`(`["project-logo", id]`의 첫 무효화 지점), 공용 `components/common/ProjectLogo.tsx`, 사이드바 행(인라인 img 교체)·툴바 이름 앞·모아보기 터미널/브라우저 셀 헤더(`size={14}`), 트리 메뉴 "프로젝트 로고로 지정"(svg 포함), 행 메뉴 "로고 해제".
- e2e 44 신설.

**적대적 리뷰(2026-09-08)에서 확정돼 고친 것:**

| 지적 | 수정 |
|---|---|
| 지정 직후 **별도 모아보기 창의 셀 헤더가 안 바뀐다** — 그 창은 자기 QueryClient를 쓰고(`main.tsx`) `useProjectLogo`는 `staleTime: Infinity`라 영영 다시 안 읽는다. §1의 "즉시 갱신"이 그 표면에서 성립하지 않았다 | `set_project_logo`가 `project://logo-changed`를 emit(`tree://ignore-ready` 모양) → `events.ts`의 `attachLogoEvents`가 `["project-logo", projectId]` 무효화, 모아보기 창은 `main.tsx`에서 직접 붙인다(그 창은 `attachRepoEvents`를 안 부른다) |

**설계와 다른 점**: 문서의 `ErrorCode::Invalid`는 존재하지 않아 검증 실패에 `ErrorCode::Io`를 썼다(선례 `projects.rs`). 문구는 설계 그대로.

**미검증(§5.2 실기)**: 앱 재시작 후 로고 유지, 지정 파일 삭제 시 자동 감지 폴백, 3MiB jpeg 썸네일, 옛 `projects.json` 로드 시 `.corrupt` 미생성, e2e 44 실제 회차.
