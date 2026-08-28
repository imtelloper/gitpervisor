# 파일트리 즉각 반영·확장 속도 — 설계

> 상태: 설계(Design) · 2026-08-28 · `/sc:design` 산출물 · 대상: gitpervisor (Tauri 2 + React 19)
>
> 요구: ① 새 파일 생성 시 트리에 즉각 반영 ② 폴더 클릭(펼침) 지연을 하이엔드급으로 개선

---

## 0. 결정 요약

| # | 항목 | 결론 | 규모 | 위험 |
|---|---|---|---|---|
| A | is_ignored의 git 스폰 제거 | 레포당 **ignored-set 캐시**(`git ls-files --others --ignored --directory` 1회) → list_dir은 **스폰 0회** 동기 조회 | medium | low |
| B | 리스팅·쿼리 고속화 | read_dir 단일 패스 + 쿼리 정책 교체(staleTime ∞ · refetchOnMount always · keepPreviousData) + 하위 1단계 프리페치 | medium | low |
| C | 즉각 반영 | `repo://changed` 핸들러에 **프로젝트 단위** `["dir", projectId]` 무효화 추가 — A가 선행이면 안전 | small | low |

**핵심 판단 4가지**

1. **지연의 정체는 실측으로 확정됐다 — 항목 수가 아니라 git 스폰이다.** 실행 중인 앱에서
   `list_dir`을 직접 계측(2026-08-28, CDP): IPC 기저 왕복은 **3ms**인데 list_dir은 소형 폴더도
   **60ms 바닥**, 234GB 레포(nqvm-vis)에서는 **1.0~3.5초**. 항목 2개짜리 `ML/labels`가 3.4초로
   최악 — 크기 무관. 코드 확인 결과 매 리스팅마다 `git check-ignore -z --stdin`을 **한 번씩
   스폰**한다(tree.rs:527,558-584). Windows 프로세스 생성 + Defender 검사 + 거대 레포의
   ignore 스택/인덱스 로드가 그 시간이다. 레포 스스로도 이를 알고 있다 — list_project_roots가
   동시성을 4로 캡한 이유가 "Windows에서 git 프로세스 폭풍이 서로를 굶긴다"(tree.rs:366-367).
2. **새 파일이 안 보이는 이유는 한 줄이다.** `repo://changed` 핸들러(events.ts:54-64)가
   statuses/diff/log/branches/repo-files만 무효화하고 **`["dir"]`은 빼놓았다.** 워처는 이미
   파일 생성을 감지해 이벤트를 쏘고 있다 — 트리만 구독을 안 한 것.
3. **`["dir"]` 무효화를 지금 추가하면 안 되고, A 이후에 추가해야 한다.** 현행 백엔드에서
   프로젝트 단위 무효화는 "펼쳐진 폴더 수 × git 스폰"의 폭풍이 되어(레포 변경마다!) 8슬롯
   IPC 세마포어를 막고 클릭을 굶긴다 — 무효화 부재는 사실상 이 폭풍의 방어막이었다.
   **A(스폰 제거)가 C(즉각 반영)의 전제다.**
4. **ignore 판정은 새 크레이트 없이 기존 패턴의 확장으로 푼다.** Quick Open이 이미 증명했다:
   `git ls-files` **한 번**이 레포 전체의 답을 준다(tree.rs:448-453). ripgrep의 `ignore`
   크레이트는 의존성 신규 추가인 데다 git 시맨틱(추적 파일은 절대 ignored 아님 ·
   core.excludesFile · .git/info/exclude)을 스스로 재현해야 한다 — git에게 물어보는 쪽이
   정확성이 공짜다. 스폰을 **리스팅당 1회 → 레포당·변경당 1회**로 상각하는 것이 본질이다.

### 실측 기준선 (2026-08-28, dev 빌드, Windows)

| 대상 | 항목 수 | list_dir (3회) | 비고 |
|---|---|---|---|
| gitpervisor/src/components | 27 | 67 / 66 / 63 ms | **바닥 = git 스폰 1회** |
| gitpervisor 루트 | 28 | 927 / 77 / 67 ms | 첫 회 = 콜드 캐시 |
| nqvm-vis/ML/labels | **2** | **3443 / 3514 / 2745 ms** | 거대 레포 — 반복해도 느림 |
| nqvm-vis/ML | 8 | 173 / 1075 / 1863 ms | 배경 git 작업과 경합 |
| (기저) get_settings | — | 3 / 3 / 3 ms | IPC는 문제가 아니다 |

목표: **캐시 히트 시 재펼침 0ms(즉시 렌더), 콜드 리스팅 ≤ 15ms**(read_dir + 동기 셋 조회 + IPC 3ms),
새 파일 자동 반영 **≤ 0.7초**(워처 디바운스 400ms + 코얼레싱 250ms + ms급 refetch).

---

## 1. 현재 구조 (확인된 사실)

```
[클릭]  FileTreePanel: toggleFolder → {expanded && <DirChildren>} 마운트   (지연 로딩)
        useDir ["dir", pid, rel] — staleTime 30s, placeholder 없음 → 첫 펼침마다 '…' 스피너
        ipc.listDir — interactive lane, 8슬롯 세마포어 공유(statuses 50s·sizes 120s와 경합)
[백엔드] tree.rs read_dir_entries: tokio read_dir(엔트리별 await) → git check-ignore 스폰 1회
        → 정렬 → 반환. 캐시 없음.
[워처]  notify-debouncer-full 400ms, 디렉터리 단위 비재귀 감시(IGNORED_DIRS·.git/objects 제외),
        repo://changed = { projectId }만 (경로 없음 — §4 무상태 신호 원칙)
[프론트] events.ts: repo://changed → statuses/diff/log/branches/repo-files 무효화. ["dir"] 없음.
        ["dir"] 무효화는 10곳(생성·삭제·이름변경·이동·이미지·내보내기)의 앱 내 조작뿐.
프리페치: list_project_roots가 루트("")만 시딩. 하위 폴더는 전무.
```

---

## 2. [A] ignored-set 캐시 — 스폰을 레포당 1회로 상각

### 2.1 자료구조 (AppState)

```rust
/// 프로젝트별 ignore 판정 캐시. list_dir이 **동기·무스폰**으로 조회한다.
pub ignore_cache: Mutex<HashMap<String /*projectId*/, IgnoreCache>>,

struct IgnoreCache {
    /// `git ls-files -z --others --ignored --exclude-standard --directory` 출력.
    /// 디렉터리는 접힌 한 줄("node_modules/")로 오므로 거대 레포에서도 출력이 작다.
    ignored_files: HashSet<String>, // 후행 '/' 없는 항목
    ignored_dirs: Vec<String>,      // 후행 '/' 항목 — prefix 판정용 (정렬해 이진탐색)
    fresh: bool,                    // 워처 변경 시 false — 다음 조회가 배경 갱신 킥
}
```

판정: `is_ignored(rel) = name==".git" || ignored_files.contains(rel) || ignored_dirs 중 prefix 일치`.

**시맨틱 보존 3원칙**(현행 check-ignore와 동일해야 함, tree.rs 주석 근거):
- 추적(tracked) 파일은 절대 ignored 아님 → `--others`가 추적 파일을 아예 안 내놓으므로 자동 보존 ✓
- `.git`은 코드에서 강제 ignored ✓ (유지)
- 판정 실패(캐시 없음·git 실패) 시 **디밍 없음으로 폴백**(현행 check_ignored 실패 동작과 동일) ✓

### 2.2 흐름

```
list_dir(pid, rel):
  entries = spawn_blocking(std::fs::read_dir 단일 패스)     ← 엔트리별 tokio await 제거(현행 §4 의심점)
  cache = ignore_cache[pid]
  ├ 있음(fresh 여부 무관) → 동기 판정으로 즉시 응답 (stale이어도 디밍은 근사값으로 OK — 장식이다)
  └ 없음 → is_ignored=false로 즉시 응답
  cache가 없거나 !fresh → 배경 태스크로 갱신 킥(레포당 in-flight 1개 가드)
                          완료 시 fresh=true + `repo://changed`와 동일 경로로 ["dir"] 재검증 유도*
```
\* 구현 시 정정: 완료 신호는 전용 `tree://ignore-ready`로 한다 — `repo://changed` 재사용은
  statuses/log/branches 재조회까지 연쇄시켜(git 스폰 증가) 캐시 갱신마다 상태 파이프라인을
  이중 실행하는 낭비였다. 프론트는 이 신호에 `["dir", projectId]`만 재검증한다.

무효화: 워처 콜백(watcher.rs)에서 repo://changed를 쏘는 그 지점에 `fresh=false` 마킹 한 줄.
`.gitignore` 편집도 레포 변경이므로 같은 경로로 자연 갱신된다.

### 2.3 비용·한계

- 스폰 횟수: 리스팅당 1회 → **레포 변경당 최대 1회**(연속 변경은 fresh 플래그+in-flight 가드가 합침).
- `--directory`가 ignored 디렉터리를 접어 출력하므로 항목 수가 폭발하지 않는다(node_modules = 1줄).
  다만 "ignored 파일이 수만 개인데 디렉터리로 안 접히는" 병리적 레포 대비 **상한 10만 항목 +
  truncated 시 그 레포는 디밍 폴백**(정확성 대신 정직한 강등 — 실측 nqvm-vis로 검증 필요, §8).
- ls-files 자체가 거대 레포에서 1~3초일 수 있으나 **배경 실행**이라 클릭을 막지 않는다.

---

## 3. [B] 리스팅·쿼리 고속화

### 3.1 백엔드

- `read_dir_entries`: `spawn_blocking` + `std::fs::read_dir` 단일 패스(엔트리별 `next_entry().await`
  + `file_type().await` 왕복 제거). 정렬 키는 엔트리당 1회 lowercase 사전 계산(현행: 비교당 2회 할당).
- **배치 커맨드 `list_dirs(projectId, rels: Vec<String>)`** 신설 — list_project_roots의
  buffer_unordered 골격 재사용, 결과는 rel별 맵. 용도: 프로젝트 전환·시작 시 저장된 확장
  상태(treeState의 expanded 목록)를 **invoke 1회**로 워밍. 경로 검증은 rel마다 기존
  `validate_rel_dir` 그대로.

### 3.2 프론트 쿼리 정책 (useDir)

| 항목 | 현행 | 변경 | 근거 |
|---|---|---|---|
| staleTime | 30s | **Infinity** | 신선도는 워처(§4)가 책임 — 시간 기반 재조회 제거. focus 시 일제 refetch 폭풍(현행 의심점 #4)도 함께 소멸 |
| refetchOnMount | 기본 | **"always"** | 접었다 펼 때마다 배경 재검증 — 워처 커버리지 밖(IGNORED_DIRS 내부)의 변경도 "펼치면 최신" 보장. 백엔드가 ms급이라 비용이 사실상 0 |
| placeholderData | 없음 | **keepPreviousData** | 재검증 중 '…' 깜빡임 제거 — 캐시를 즉시 그리고 조용히 갱신 |

→ 체감: **재펼침 = 0ms**(캐시 즉시), 첫 펼침 = 콜드 리스팅 1회(≤15ms 목표).

### 3.3 하위 1단계 프리페치

DirChildren이 데이터를 받으면 그 안의 하위 디렉터리 목록을 `background` lane으로
`prefetchQuery`(4개씩 청크 — usePrefetchDiffs의 청크·양보 패턴 재사용, 이미 캐시에 있으면
스킵). 사용자가 다음에 클릭할 폴더는 이미 캐시에 있다 → **첫 펼침도 대부분 0ms**.
background lane은 대기열 맨 뒤라 클릭(interactive)을 굶기지 않는다(ipc.ts 레인 규약).

### 3.4 하지 않는 것

- **가상화(virtualization)**: 수천 항목 디렉터리의 렌더 비용은 별개 문제이고, Shift-범위 선택·
  패널 폭 맞춤이 실제 DOM 행을 읽는 현 구조(FileTreePanel.tsx:470-533)와 충돌한다. 이번 범위 밖.
- **워처 payload에 경로 추가**: "신호만, 상태 없음" 원칙(watcher.rs §4)을 유지한다. A로 refetch가
  ms급이 되면 프로젝트 단위 무효화로 충분하고, 경로 전달은 임베디드 레포 매핑·이동/삭제 케이스의
  복잡도만 산다.
- **check-ignore 배치 공유·디바운스**: 스폰 자체를 없애는 A가 있으면 불필요.

---

## 4. [C] 즉각 반영 — 워처를 트리에 연결

`events.ts`의 repo://changed 핸들러(250ms 코얼레싱 그대로)에 한 줄 추가:

```ts
void qc.invalidateQueries({ queryKey: ["dir", e.payload.projectId] });  // 프로젝트 단위
```

- payload의 projectId를 드디어 쓴다(현행 핸들러는 무시). 다른 프로젝트의 펼쳐진 폴더는 건드리지
  않는다.
- react-query는 **마운트된(=펼쳐진) 쿼리만 refetch**하고 나머지는 stale 마킹만 하므로, 부담은
  "펼쳐진 폴더 수 × ms급 list_dir"이다. A 선행 전제(핵심 판단 3).
- 기존 앱 내 조작 10곳의 `["dir"]` 전체 무효화는 그대로 두되, 워처 경로가 생기므로 사실상
  이중 안전망이 된다(마찰 없음).

**한계(정직 고지)**: IGNORED_DIRS(node_modules·target·.venv 등) 내부와 `.git/objects`는 워처가
의도적으로 안 본다(184k 감시/180MB 사건의 재발 방지 — 완화 불가). 그 안의 외부 변경은 자동 반영되지
않고, **§3.2의 refetchOnMount:"always"가 "접었다 펴면 최신"으로 보완**한다. 새 폴더 생성 직후
그 폴더 내부 추가 변경은 증분 감시 등록(watcher.rs:110-153)까지 짧은 공백이 있다 — 400ms 디바운스와
합쳐 최악 ~1초 지연이며 수용한다.

---

## 5. 변경 지점

| 파일 | 변경 |
|---|---|
| `src-tauri/src/state.rs` | `ignore_cache` 필드 |
| `src-tauri/src/commands/tree.rs` | read_dir 단일 패스화 · check_ignored 스폰 제거 → 캐시 조회 · 캐시 빌더(ls-files --others --ignored --directory) · `list_dirs` 배치 커맨드 |
| `src-tauri/src/watcher.rs` | repo://changed emit 지점에서 ignore_cache `fresh=false` 마킹 |
| `src-tauri/src/lib.rs` | `list_dirs` 등록 |
| `src/queries/index.ts` | useDir 정책(staleTime ∞ · refetchOnMount always · keepPreviousData) · expanded 워밍 훅(list_dirs 시딩 — useProjectRootsPrefetch 패턴) |
| `src/lib/events.ts` | repo://changed에 `["dir", projectId]` 무효화 |
| `src/components/tree/FileTreePanel.tsx` | DirChildren 하위 1단계 프리페치 |
| `src/lib/ipc.ts` | `listDirs` 래퍼(read, background lane) |

---

## 6. 구현 순서

1. **[A] 백엔드 캐시 + read_dir 단일 패스** — 이것만으로 실측 60ms~3.5s → ms급. 회귀 방지:
   시맨틱 3원칙(§2.1) 유닛 테스트(추적 파일 미디밍 · .git 강제 디밍 · 실패 시 무디밍).
2. **[B] 쿼리 정책 + [C] 워처 연결** — 같은 커밋으로(§0 핵심 판단 3: staleTime ∞는 워처 무효화와
   세트일 때만 안전).
3. **[B] 프리페치 + list_dirs 워밍** — 독립적, 마지막.
4. 검증: 실측 재계측(§0 표와 동일 방법, CDP) + "외부 터미널에서 `touch newfile` → 트리 자동 표시
   ≤1초" 시나리오.

---

## 7. 오픈 이슈 (사용자 결정 필요)

| # | 질문 | 선택지 | 권고 |
|---|---|---|---|
| ① | ignore 엔진 | (a) ls-files 캐시(스폰 상각, git 시맨틱 공짜) (b) `ignore` 크레이트(신규 의존성, 시맨틱 자가 재현) | **(a)** — 정확성·의존성 모두 우위. (b)는 (a)의 배경 스폰조차 없애고 싶을 때의 후속 |
| ② | 프리페치 깊이 | (a) 1단계 (b) 2단계+ | **(a)** — 클릭 한 번 앞만 내다보면 체감 0ms는 달성된다. 더 깊으면 거대 레포에서 낭비 |
| ③ | 거대 디렉터리 렌더(가상화) | (a) 이번 범위 밖 (b) 포함 | **(a)** — 별개 결함이고 선택·DnD 구조와 충돌(§3.4). 수천 항목 폴더가 실사용에서 아프면 후속 설계 |

---

## 8. 위험·미검증 영역 — 정직 고지

- **`--directory` 출력 크기는 nqvm-vis에서 실측 전이다.** ignored 디렉터리가 잘 접히는지,
  상한(10만)·truncated 폴백이 실제로 필요한지 구현 초기에 그 레포로 확인한다.
- **stale 디밍 근사**: 캐시 갱신 완료 전 잠깐 옛 디밍이 보일 수 있다(§2.2). 장식 속성이라
  수용하지만, `.gitignore` 편집 직후 몇백 ms간 어긋남이 보이는 것이 신경 쓰이면 재검증 이벤트를
  기다려 디밍만 늦게 칠하는 후속이 가능하다.
- **refetchOnMount:"always"의 총량**: 깊은 트리를 접었다 펴면 하위 전체가 재검증된다 — ms급
  전제에서 무해하나, 병리적(수백 폴더 동시 마운트) 케이스는 background 강등 여지를 남긴다.
- **임베디드 레포**: 워처는 부모 루트를 감시하고 projectId도 부모다 — 임베디드 레포의 합성
  id(`부모::rel`)로 열린 트리가 있다면 `["dir", 부모id]` 무효화에 안 걸린다. 현 트리 UI가
  임베디드를 별도 트리로 여는지 구현 시 확인 필요(안 열면 무-이슈).
- 계측치는 다른 앱들이 메모리 96%를 쓰는 머신에서 나왔다 — 절대값은 흔들리되 "스폰이 지배,
  IPC 3ms" 구조 결론은 견고하다.
