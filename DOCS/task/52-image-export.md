# 태스크 52 — 내보내기 엔진·Rust 토큰 폴더 쓰기·다중 내보내기 모달·인스펙터 내보내기 행·프리셋·슬라이스 도구

> 상태: 설계(Design) · 대상: gitpervisor · 근거: 코드 실측 2026-09-04(워킹트리) + 브라우저 실측(Playwright Chromium 152, 2026-09-04 — WebView2 는
> 같은 Skia 인코더·필터 스택이라 동일하다고 본다, **추정**: §5-0 프로브가 dev 앱 CDP 로 재확인) · 선행: 태스크 37(`ExportRow`·`EditorDoc`), 38(`resolveScene`·
> `visualBounds`), 39(`renderScene`·`imageStore.ensure`), 40(`renderOutput` 타일·`estimateRenderBytes`·메모리 원장), 41(사이드카 — 내보내기는 삭제하지 않는다),
> 42(툴 레일 `Tool`·`EDITOR_SHORTCUTS`), 45(인스펙터 4탭 셸), 51(`useImageLibrary` 프리셋 저장소) · `DOCS/screen-capture-design.md` §5.2(레포 밖 쓰기 원칙),
> `DOCS/image-annotation-design.md` §6(저장 경로), `DOCS/pro-image-editor-design.md` §6.3(4K 예산) · 시안: `designs/image-editor-figma-v2.pen` ⑥(다중 내보내기)
> ①(인스펙터 내보내기 행) · 상위: `00-INDEX.md` §10 — **M5 첫 태스크.** 이 트랙에서 **레포 밖에 쓰는 유일한 커맨드**가 여기서 생긴다.

## 1. 요구사항

시안 ⑥ 모달: `내보내기 · 선택 3개 · 총 9개 파일 · 대상 · 3 선택 · 전체 아트보드 2880 × 1605 · 불량 영역 강조 440 × 220 · 번호 뱃지 #3 56 × 56 · 치수선 그룹 620 × 310 ·
센서 위치 120 × 120 · 내보내기 설정 · 프리셋 · 웹 기본 · 배율 · 크기 · 접미사 · 포맷 · 색 프로필 · 1x · 접미사 없음 · PNG · sRGB · 2x · 5760 × 3210 · @2x · 0.5x ·
1440 × 803 · @0.5x · WebP · 너비 1200 · 1200 × 669 · -w1200 · JPG 92% · 배율 추가 · 옵션 · 배경 투명 · 메타데이터 제거 · 텍스트 윤곽선화 · 잘라내기 여백 0 ·
레이어별 파일 분리 · 색 프로필 포함 · 주석 레이어 포함 · hidpi 자동 배율 · 파일명 규칙 적용 · 파일명 · {레이어}_{배율}{접미사}.{확장자} · F:\...\화면캡처자료\export ·
미리보기 · 체커보드 = 투명 영역 · 불량 영역 강조 @2x · 9개 파일 · 예상 용량 14.2 MB · F:\...\화면캡처자료\export 에 저장 · 프리셋 저장 · 취소`,
① 인스펙터 내보내기 행 `1x · 접미사 · PNG · 2x · @2x · 3x · @3x · WebP`, ① 타이틀바 `내보내기`, 툴 레일 아이콘 `슬라이스`(텍스트 라벨 없음 — 심사 고아 항목에서
이 태스크로 배정, INDEX §10 심사 "슬라이스(S) — 슬라이스 영역 객체·내보내기 연동을 정의한 축 없음").

받아들이는 조건:
- 대상(전체 아트보드·노드·슬라이스) × 배율 행(1x/2x/0.5x/너비 N·접미사·포맷·품질·색 프로필) 조합을 **한 번에** 파일로 쓴다. 각 파일의 픽셀은 편집기 프리뷰·
  `저장 (PNG)`와 **같은 `renderScene`**(39)을 지난 결과다 — 미리보기 썸네일도 같은 함수.
- 저장 위치는 **레포 밖**(`F:\...\export`)일 수 있다. 그러나 프론트가 절대경로를 만들어 Rust 에 넘기는 커맨드는 만들지 않는다(`screen-capture-design.md:370-374`
  확정 원칙). 레포 안(원본 폴더)에 쓸 때도 **같은 쓰기 커맨드 하나**를 지난다.
- 옵션 9개가 라벨대로 동작하거나, 이 플랫폼에서 동작할 수 없으면 **비활성 + 툴팁**으로 이유를 말한다(체크만 되고 아무 일도 안 하는 스위치는 두지 않는다).
- `예상 용량`은 포맷·품질·내용을 반영한 값이고, 실행 뒤 실측 합계로 갱신된다.
- 2x·3x 4K 같은 큰 잡이 Windows 저메모리 강제종료(CLAUDE.md OOM 이력)를 부르지 않는다 — 게이트는 40 원장의 `estimateRenderBytes` 하나.
- 노드별 내보내기 행(① 인스펙터)은 문서에 영속되고(37 `NodeBase.exportRows`), 슬라이스 도구(S)로 만든 영역이 모달 대상 목록에 자동으로 오른다.
- 내보내기는 원본 파일·사이드카(41)를 **건드리지 않는다**(평탄화 `저장 (PNG)`와 다르다).

## 2. 현황(근거)

- **쓰기 커맨드는 레포 안 전용 하나**: `write_file_bytes`(`tree.rs:365-407`)가 `resolve_in_repo`(`:1772-1791` — `validate_rel_file` :1753 렉시컬 검증 후 상위
  디렉토리 canonicalize, 레포 루트 밖이면 Io)를 지난다. 심볼릭/디렉토리 거부(`:376-383`), `expected_stamp` 대조(`:384-396`), `overwrite=false`→`AlreadyExists`
  (`:397-403`), **base64 64MB 상한**(`:404-407`). 레포 밖은 원천 불가. `validate_rel_file`·`is_dotgit_component`(`:1717`)는 `fn`(비공개)이라 다른 모듈이 못 쓴다.
- **바이트는 base64 문자열로 건너간다**: 프론트 `writeTo`(`ImageEditor.tsx:731-736`)가 `encodeCanvas(renderOutput(), format, quality)` → `bytesToBase64`
  (`image-codec.ts:113-120`, 32KB 청크 `String.fromCharCode`+`btoa`) → `useSaveImage`(`queries/index.ts:1005-1028`) → `ipc.writeFileBytes`(`ipc.ts:1146-1158`,
  `callMutating` 60s). 2x 4K PNG(≈30MB 추정)면 바이너리 문자열(UTF-16 60MB) + base64 40MB 가 바이트 옆에 **더** 생긴다.
- **raw body 는 아직 한 번도 안 썼다**: `@tauri-apps/api` `invoke(cmd, args?: InvokeArgs, options?: {headers})`의 `InvokeArgs`가 `ArrayBuffer | Uint8Array`를 받고
  (`node_modules/@tauri-apps/api/core.d.ts:105,127`), Rust 는 `tauri::ipc::Request{body: InvokeBody::Raw(Vec<u8>), headers}`로 받는다
  (`~/.cargo/registry/src/*/tauri-2.11.2/src/ipc/mod.rs:59-63,145-158`). 저장소 grep `ipc::Request` 0건, `ipc::Response` 0건(50 이 `font_read`로 첫 사용 예정).
  WebView2 에서 본문 상한이 있는지는 **미확인**(추정 없음) — CSP 는 `connect-src ipc: http://ipc.localhost`(`tauri.conf.json:16`)로 열려 있다.
- **다이얼로그 플러그인은 등록만**: `lib.rs:838 .plugin(tauri_plugin_dialog::init())`, capability `dialog:default`(`capabilities/default.json:26`), JS 패키지
  `@tauri-apps/plugin-dialog` 설치(`package.json:33`). Rust 쪽 `FileDialogBuilder|pick_folder` 사용 **0건**(grep). 플러그인은 콜백형 `pick_folder`(`tauri-plugin-dialog-2.7.1/src/lib.rs:604`)·
  `blocking_pick_folder`(`:723`)·`set_directory`(`:449`)를 준다. JS `open({directory:true})`은 다이얼로그 결과로 fs 스코프를 넓히는 경로(`commands.rs:162 try_fs_scope`)인데
  이 앱은 `tauri-plugin-fs`를 쓰지 않는다.
- **동시 invoke 유실 방어는 `call` 경로에만 있다**: `ipc.ts:948-950` `MAX_CONCURRENT=8 · INVOKE_TIMEOUT_MS · MAX_ATTEMPTS=3`, 슬롯 대기 `:987-991`, single-flight
  `:962-975`. `callMutating`(`:1015-1036`)은 슬롯을 **타지 않고** 타임아웃만 건다(재시도 금지 — 변경 커맨드). raw body 를 보내는 새 함수도 이 규칙 안에 있어야 한다.
- **사용자 데이터 원자 쓰기·최근 폴더 저장소**: `state.rs:129 SAVE_LOCK` · `:131-133 data_path = app_data_dir/<file>` · `:176-189 save_json_at`(tmp→rename) ·
  `:192-211 load_json/save_json`(손상 시 `.corrupt` 격리 `:140-150`). 잡 레지스트리 관례는 `video.rs:33-45 VideoReg{jobs: Arc<Mutex<HashMap>>}` + RAII `JobGuard`,
  `AppState.video`(`state.rs:53-54`, `:80` 초기화).
- **출력 렌더는 40 이 타일로 바꾼다**: 현행 `renderOutput`(`ImageEditor.tsx:660-691`)은 `out.width=outW`(`MAX_OUTPUT_DIM 16384` :66) 전면 캔버스 1회. 40 §4 가
  `renderOutput(scene, {crop, outW, outH, nodeIds, background, image, tileDevicePx, trim})`와 `estimateRenderBytes(scene,{outW,outH,format}).peak`를 정의하고
  §3.5 메모리 원장(4K 2x 저장 피크 ≤450MB — 인코더 리드백 133MB 포함, **export 수치가 정본**)을 이 태스크가 채운다.
- **예상 용량 선례**: 동영상 `ExportPanel.tsx:73-78 fmtBytes`·`:371-405 estBytes` — 근거가 없으면 숫자 대신 `—`. 이미지는 비트레이트 개념이 없어 이 식을 못 쓴다.
  `src/lib/format.ts:17 formatBytes`(B/KB 정수·MB 소수 1자리)가 앱 공용 표기.
- **인코딩 실측**(Playwright Chromium 152, 64×64 캔버스 `toBlob` 컨테이너 파서): sRGB 캔버스 PNG = `IHDR/IDAT/IEND`뿐(iCCP·sRGB·gAMA·tEXt 없음), JPEG = JFIF +
  **APP2 `ICC_PROFILE`(472B) 자동 삽입**, WebP = `VP8X` + **`ICCP`(456B) 자동 삽입**, `getContext('2d',{colorSpace:'display-p3'})` 캔버스 PNG = `iCCP`(295B) 자동 삽입,
  `image/avif` 요청은 png 로 폴백(기존 jsquash 경로 `image-codec.ts:86-98`). ⇒ '색 프로필 포함' ON/OFF 는 포맷마다 **삽입/제거 방향이 반대**다.
- **모달 z 계층**: 편집기 루트 `fixed inset-0 z-50`(`ImageEditor.tsx:979`, e2e 30/34 `A.modal` 셀렉터 `30:34-36`), 토스트 `z-[55]`(`Toast.tsx:11-16`), 확인·입력·
  QuickPick `z-[60]`(`ConfirmDialog.tsx:18`, `PromptDialog.tsx:41`, `QuickPick.tsx:136`). 메인 창은 `<ConfirmHost/><PromptHost/>`가 `<ImageEditor/>`보다 **앞**에 마운트된다
  (`App.tsx:195-210`) — 편집기 안의 `z-[60]` 요소는 DOM 이 뒤라 확인창을 **덮는다**. 네이티브 자식 웹뷰 위에 뜨는 오버레이는 `useOccludesWebview(true)`(`stores/occlusion.ts:49`)를 건다.
- **인스펙터·툴 레일·단축키 셸은 42/45 소유**: `Tool` 유니온(`types.ts:14-24`, 10종 — `slice` 없음)은 42 가 확장하고, 인스펙터 4탭(속성·텍스트·조정·**내보내기**)은 45 가
  hidden 마운트 셸을 준다(45 §, e2e 30 `A.btn(/오른쪽 90/)` 계약). 이 태스크는 탭 콘텐츠(`ExportSection`)와 도구 동작만 만든다.
- **e2e 전제**: 30 `A.readSaved`(`:252-283`, `read_file_base64` 재디코드 후 좌표 샘플·색 카운트), `fix.status()`(`git-fixture.mjs:90-92` porcelain v2 — 레포 안 쓰기가 git
  변경 목록에 오르는지 교차 검증), 15 `write_file_bytes` 거절 패턴(`15-tree-fileops.mjs:75-95` — `.git::$INDEX_ALLOCATION`·예약명 → `IO`). 번호: e2e **41** `image-export`(INDEX §10.4).
- **심사 판정**(정합성 major·실현가능성 minor): export 원안의 전면 캔버스 `renderJob`(40MP 상한·피크 450MB)은 40 `renderOutput` 타일 호출로 대체, 게이트는
  `estimateRenderBytes.peak` 하나(40MP 는 UI 상수로만). `invokeRaw`는 슬롯 리미터를 우회하면 안 된다. `height` 배율·AVIF P3 는 시안 밖(INDEX §10.5).

## 3. 설계

### 3.1 잡 모델 — `planExport`(순수) → `renderJob`(40 위임) → `encodeJob` → `export_write`, 직렬

잡 = (대상, 행, 옵션) 하나. `planExport(doc, scene, targets, rows, o)`가 **렌더 없이** 잡 목록(파일명·bounds·outW/outH·에러)을 만들어 모달의 크기 셀·파일 수·
충돌 검사·예상 용량이 전부 이 목록 위에서 돈다.

| 결정 | 선택 | 탈락 |
|---|---|---|
| 잡 렌더 | **40 `renderOutput(scene, {crop: job.bounds, outW, outH, nodeIds, background, image})`** 1회 — 2048² 타일이라 작업 메모리 ≈20MB 상수 | 자체 전면 작업 캔버스(export 원안): 2x 4K 출력 133MB + 작업 133MB. 렌더 진입이 둘이 된다(INDEX §10.4 위반) |
| 노드 대상 bounds | `visualBounds(scene, id)`(38, 효과 여백 포함) ⊕ `padding`(옵션 '잘라내기 여백') ∩ 이미지 경계 → `crop` | 40 `trim` 옵션: 렌더 시점에 계산돼 모달이 크기 셀을 미리 못 보여 준다 |
| 대상 종류 | `{kind:'artboard'}`(크롭·`outW/H` 반영 = `저장 (PNG)`와 같은 프레임) · `{kind:'node', id}`(그룹·프레임·슬라이스 포함 — `subtreeRange` 자손이 `nodeIds`) | 슬라이스를 별도 kind 로: 슬라이스는 `FrameNode`(§3.9)라 node 와 같다 |
| 배율 | 37 `ExportRow.scale: number \| {width:number}` — `x`: `round(bounds.w·s) × round(bounds.h·s)`, `width`: `N × round(bounds.h·N/bounds.w)` | `height`: 시안 밖(INDEX §10.5) |
| 순서 | **직렬**(await 1잡씩), 출력 캔버스는 encode 직후 `width=0` — 피크 = 1잡 | 병렬 인코딩: 캔버스 N개 동시 생존(OOM 이력) |
| 미리보기 | 체크된 첫 대상 × 첫 행을 ≤0.25MP 로 같은 `renderJob` — §3.5 프록시와 **캔버스 공유** | 별도 축소 렌더 경로: 프리뷰≠결과 |

크기 셀 검산(시안 ⑥ 2880×1605): 2x → `5760 × 3210`, 0.5x → `1440 × 803`(802.5 반올림), 너비 1200 → `1200 × 669`(668.75) — 라벨과 일치.
`총 M개 파일 = 체크 대상 수 × 행 수`(시안의 `선택 3개 · 총 9개 파일`은 3×3 예시값). `job.error`: `outW·outH > MAX_JOB_PIXELS(40MP)` 또는 한 변 `> MAX_OUTPUT_DIM`
(`ImageEditor.tsx:66` 16384 이관) — 목록에 회색 + 사유, 실행에서 제외.

### 3.2 레포 밖 쓰기 — Rust 가 다이얼로그를 열고 **경로 대신 토큰**을 준다

| 대안 | 평가 |
|---|---|
| **A. `export_pick_dir`: Rust `pick_folder`(콜백 + `tokio::sync::oneshot`) → `AppState.export_dirs`에 `token(uuid) → PathBuf` 등록(LRU 16) → JS 는 `{token, display}`만. 레포 안은 `export_dir_for_repo(pid, relDir)`가 `resolve_in_repo`를 지나 같은 토큰을 발급. 쓰기 커맨드는 `export_write(token, name, bytes)` 하나** (채택) | 앱이 임의 절대경로에 쓰는 표면 0 유지(`screen-capture-design.md:370-374` 원칙 그대로). 경로 문자열이 JS 를 왕복하지 않는다. 레포 안·밖이 한 코드 경로 |
| B. JS `open({directory:true})` → 새 커맨드 `write_abs(path, bytes)` | 위 원칙 위반 — "프론트가 준 절대경로에 쓰는 커맨드를 만들면 안 된다". 이 웹뷰가 PTY 셸을 띄울 수 있어 새 권한은 아니지만(`commands/terminal.rs`), 표면을 넓힐 이유가 없다 |
| C. `tauri-plugin-fs` 추가 + 다이얼로그 fs 스코프(`commands.rs:162`) | Rust·npm 의존 2개, 파일별 JS `writeFile` N회, 심볼릭·`.git`·예약명 가드가 우리 코드 밖 |
| D. `write_file_bytes` 확장 | `resolve_in_repo` 전용 — 레포 밖은 구조적으로 불가 |

- **다이얼로그 스레드**: `#[tauri::command(async)]` 안에서 `app.dialog().file().set_directory(last).pick_folder(move |p| { let _ = tx.send(p); })` 후 `rx.await` —
  `blocking_pick_folder`(`:723`)는 메인 스레드에서 데드락 위험(플러그인 문서). 취소 = `None` → `null`.
- **최근 폴더**: Rust 가 `save_json(app, "export.json", "lastDir", &path)`에 보관. `export_last_dir`이 **존재 확인 후** 토큰 발급 — JS 가 경로를 되돌려 주는 일이 없다.
- **`export_write` 검증 순서**: ① 토큰 존재(`NotFound`) ② 파일명 = percent-decode → **단일 컴포넌트**(`/`·`\` 포함 거부) + `validate_rel_file`(`.git`·ADS·`..`·예약 장치명 —
  `tree.rs:1753`을 `pub(crate)`로) ③ 폴더 경로 모든 컴포넌트 `is_dotgit_component`(`:1717`, `pub(crate)`) 거부 — 사용자가 다이얼로그로 `.git` 안을 고른 경우 ④ 최종 경로
  `symlink_metadata`: 심볼릭·디렉토리 거부(`write_file_bytes` :376-383 동일) ⑤ `overwrite=0`이면 존재 시 `AlreadyExists` ⑥ 본문 `InvokeBody::Raw` ≤ **64MB/파일**,
  토큰당 배치 누계 ≤ **256MB**(`export_check` 호출 시 리셋) ⑦ 같은 폴더 `<name>.gpv-tmp` → `rename`(`state.rs:186-188` 패턴, `SAVE_LOCK` 은 앱데이터 전용이라 안 잡는다) ⑧ 반환 = 쓴 바이트.
  에러는 `write_io_err`(`tree.rs:98`, Defender 힌트 포함) 재사용.
- **동시 invoke 유실 관례**: `export_check(token, names[])` **1회 배치**로 존재 파일 목록을 받고, 파일별 `export_write`는 **await 직렬**(동시 0).
- **토큰 수명**: 모달 닫힘 `export_release(token)`, LRU 16 초과 시 가장 오래된 것 폐기(고아 토큰이 남아도 경로 노출은 없다).

### 3.3 바이트 전송 — `tauri::ipc::Request` raw body + 헤더

| 대안 | 평가 |
|---|---|
| **A. `invoke('export_write', Uint8Array, {headers:{'x-gpv-dir': token, 'x-gpv-name': encodeURIComponent(name), 'x-gpv-overwrite': '0'\|'1'}})`** (채택) | 사본 0 — `Blob.arrayBuffer()` 결과를 그대로 넘긴다. 헤더는 ByteString 이라 이름은 percent-encode(Rust `percent-encoding` 크레이트 `Cargo.toml:66` 기존) |
| B. base64 인자(`write_file_bytes` 관례) | 2x 4K PNG(≈30MB)에서 바이너리 문자열 60MB + base64 40MB 추가(`bytesToBase64` :113-120). 9파일이면 GC 압박이 반복 |
| C. 파일 9개를 base64 로 묶어 배치 1회 | 수백 MB 문자열 한 덩어리 |

`ipc.invokeRaw(cmd, bytes, headers, timeoutMs)`: `runCall`(`ipc.ts:977-1012`)의 슬롯 획득/반납 6줄을 `withSlot(lane, fn)`으로 빼서 **`call`과 같은 리미터**를 지난다.
`attempts: 1`(변경 커맨드 — 재시도는 파일 중복 쓰기), 타임아웃 120s(64MB 디스크 쓰기 여유). single-flight 는 없다(같은 이름 두 번 = 의도된 덮어쓰기).
**착수 첫 단계 프로브**(INDEX §10.4): dev 앱에서 64MB `Uint8Array` 왕복 1회 — 본문 상한이 있으면 파일 상한을 그 값으로 내리고 표에 기록(§5-0).

### 3.4 인코딩·색 프로필 — 실측이 정한 방향

| 포맷 | Chromium 기본 | '색 프로필 포함' ON | OFF |
|---|---|---|---|
| PNG(sRGB) | 청크 `IHDR/IDAT/IEND`뿐 | **`sRGB`(1B) + `gAMA`(45455) + `cHRM`(sRGB 원색) 청크를 `IHDR` 뒤에 삽입** — CRC32 표 ≈15줄 | 그대로 |
| JPEG | `APP2 ICC_PROFILE` 472B 자동 | 그대로 | **APP2(`ICC_PROFILE\0` 페이로드) 세그먼트 제거** — 마커 순회 ≈20줄 |
| WebP | `VP8X` + `ICCP` 456B 자동 | 그대로 | **`ICCP` 청크 제거 + `VP8X` ICC 플래그(0x20) 해제 + RIFF 크기 갱신** ≈30줄 |
| AVIF | jsquash(sRGB nclx) | 셀 `sRGB` 고정·비활성 + 툴팁 | — |

- **Display P3**: 행의 `색 프로필` 셀 값 `sRGB \| Display P3`. P3 는 캔버스를 `{colorSpace:'display-p3'}`로 만들면 세 포맷 모두 Chromium 이 프로필을 넣는다(실측) —
  40 `renderOutput`에 `colorSpace?: 'srgb'|'display-p3'` 옵션 1개를 요청해 **출력 캔버스만** P3 로 만든다(프리뷰·스크래치는 sRGB 고정 — 색공간 혼합 그리기의 변환 비용 회피).
  sRGB→P3 재인코딩 사본을 만드는 대안(출력 크기 캔버스 +1)은 피크를 133MB 올려 탈락. `ExportRow.profile?` 필드는 정합 검사(2026-09-04)에서 37 §4에 추가됐다 → **37 에 1필드 추가 요청**
  (`profile?: 'srgb'|'display-p3'`, `normalizeNode`가 `'srgb'` 채움) — 접점 §4.
- `ExportRow.format`은 37 철자 `'png'|'jpg'|'webp'|'avif'`(확장자 그대로), 인코더는 `ImgFormat 'jpeg'`(`image-codec.ts:7`) — `encodeJob`이 `jpg→jpeg` 1줄 매핑.
  JPG 품질 = `encodeCanvas(canvas,'jpeg',q)` 기존 인자(`:81-84`).
- 공개 sRGB ICC 바이너리를 자산으로 실어 PNG `iCCP`에 넣는 안 — 탈락: PNG 규격이 `sRGB` 청크 1바이트를 표준 신호로 두고 있고 3KB 자산이 필요 없다.

### 3.5 예상 용량 — 프록시 인코딩

| 대안 | 평가 |
|---|---|
| **A. 대상마다 ≤0.25MP 프록시를 실제 포맷·품질로 인코딩 → `bytes/px × 대상 화소수`, 300ms 디바운스, `(target, row.format, quality, transparentBg, includeAnnotations)` 키 캐시. 미리보기 캔버스와 프록시 공유** (채택) | 포맷·품질·내용(스크린샷 PNG 는 내용 따라 10배 차이) 반영. 비용 ≤1MB·수십 ms |
| B. 전량 실제 인코딩 | 9잡 2x 4K = 수 초·피크 450MB 반복 |
| C. 포맷별 상수 bpp | 품질 슬라이더 무반영, 내용 무시 — 동영상 패널이 같은 상황에서 `—`를 택한 이유(`ExportPanel.tsx:371-405`) |

표기 `formatBytes`(`format.ts:17`), 라벨 `예상 용량`(추정임을 이름이 말한다). 업스케일 벡터의 압축률 편차는 정직하게 '예상'으로 두고 완료 토스트에 **실측 합계**를 쓴다.

### 3.6 옵션 9 — 의미표

| 시안 라벨 | 동작 | 상태 |
|---|---|---|
| 배경 투명 | `background:'transparent'`(39) — 베이스 이미지 제외. JPG 행은 `'#fff'` 강제(비투명) + 셀 툴팁 | 활성 |
| 주석 레이어 포함 | OFF 면 `nodeIds: []`(노드 0, 배경만). 39/40 계약에 **빈 배열 = 노드 없음** 명시 요청(§4 접점) | 활성 |
| 잘라내기 여백 N | 노드 대상 `bounds`를 사방 N oriented px 부풀림(∩ 이미지 경계) | 활성(노드 대상만) |
| 레이어별 파일 분리 | 체크된 그룹/프레임 대상의 **직계 자식**을 각각 잡으로 펼친다(`childrenOf`, 38). 재귀 없음 | 활성 |
| 색 프로필 포함 | §3.4 | 활성(AVIF 행 고정) |
| hidpi 자동 배율 | `devicePixelRatio ≠ 1`이면 `{scale: dpr, suffix: '@{dpr}x'}` 행을 목록 끝에 자동 추가(이 머신 1.5 — 30 §8.2 #2 실측 `scale 1.5`). 모니터 열거(Tauri monitor API)는 필요 없다 | 활성 |
| 파일명 규칙 적용 | ON: `pattern` 사용, OFF: `{레이어}{접미사}.{확장자}`(Figma 기본) | 활성 |
| 메타데이터 제거 | 캔버스 재인코딩은 원본 EXIF/XMP 를 구조적으로 남기지 않는다(실측: JPEG 에 APP1 없음). **항상 참** — 체크·비활성 + 툴팁 '재인코딩은 원본 메타데이터를 남기지 않습니다' | 비활성 |
| 텍스트 윤곽선화 | 래스터 4포맷에서 픽셀 결과 동일(INDEX §10.5) — 비활성 + 툴팁 'SVG 내보내기에서만 적용'. 문서 내 윤곽선화(Ctrl+Shift+O)는 50 | 비활성 |

### 3.7 파일명 규칙

토큰 `{레이어}`(노드 `name ?? defaultLayerName`(44), 아트보드는 원본 stem) · `{배율}`(`2x`·`0.5x`·`w1200`) · `{접미사}` · `{확장자}`(`extOf`) · `{원본}`(원본 stem) ·
`{날짜}`(`YYYYMMDD`). 기본 `{레이어}_{배율}{접미사}.{확장자}` → `불량 영역 강조_2x@2x.png`. 금지문자 `/\:*?"<>|`와 제어문자 → `_`, 끝 점·공백 제거(Win32 정규화),
빈 이름 → `export`. 같은 배치 안 충돌은 `-1`, `-2` 접미(순수 함수 안에서 결정 — Rust 검증은 그 뒤 마지막 방어선). 미리보기 캡션 `불량 영역 강조 @2x` = `{레이어} {접미사}`.

### 3.8 모달·인스펙터 행·프리셋·위치·진행

- **`ExportDialog`**(`Ctrl+Shift+E`·타이틀바 `내보내기`·인스펙터 `내보내기…`): 좌 = 대상 체크리스트(전체 아트보드 + `exportRows.length>0` 노드 + 슬라이스 + 현재 선택의
  `topLevelAncestor` — 기본 체크는 선택·슬라이스), 우 = 행 표(배율·크기·접미사·포맷·색 프로필·[품질]·삭제) + `배율 추가` + 옵션 9 + 파일명 + 위치 + 미리보기(체커보드 =
  CSS `repeating-conic-gradient`, 투명 영역) + `N개 파일 · 예상 용량` + `프리셋 저장 · 취소 · <위치>에 저장`. 헤더 `내보내기 · 선택 N개 · 총 M개 파일`.
- **z 계층 `z-[52]`**: 편집기 50 위, 토스트 55·확인창 60 아래 — `export_write`의 `ALREADY_EXISTS` 덮어쓰기 확인창(z-60)이 모달 **위**에 떠야 한다(`App.tsx:195-210`
  마운트 순서 때문에 `z-[60]`이면 편집기 안 요소가 확인창을 덮는다, §2). e2e 30/34 `A.modal`은 `div.fixed.inset-0.z-50`만 잡으므로 섞이지 않는다. 열린 동안 `useOccludesWebview(true)`.
- **행의 초기값**: 체크 대상이 노드 1개이고 `exportRows`가 있으면 그것, 아니면 51 `exportDefaults.rows`(없으면 내장 `웹 기본`). 모달 안 편집은 노드에 **되쓰지 않는다** —
  노드 행은 인스펙터 `ExportSection`이, 프리셋은 `프리셋 저장`이 각각 저장. 프리셋 = `{id, name, rows, options}`, 내장 `웹 기본` = `[1x '' png, 2x '@2x' png]`.
  저장소는 51 `useImageLibrary`(`image-library.json`, `exportPresets`·`exportDefaults{rows, options, target}`) — 마지막 사용 행·옵션·위치 종류가 다음 모달 기본값.
- **`ExportSection`**(45 인스펙터 `내보내기` 탭 콘텐츠, ① `1x · 접미사 · PNG · 2x · @2x · 3x · @3x · WebP`): 선택 노드의 `exportRows` 편집 — 행 추가/삭제/배율/접미사/포맷 →
  `patchDoc({objects: map(id→{...o, exportRows})}, 'commit', '내보내기 설정')`(41 라벨). 다중 선택은 `readProp`(45) Mixed 규칙. 하단 `내보내기…` = 그 노드만 체크된 모달.
- **저장 위치** 3종: `원본 폴더`(`export_dir_for_repo(pid, dirname(path))`, 기본 — INDEX §10.3 열린 질문) · `최근 폴더`(`export_last_dir`) · `선택…`(`export_pick_dir`).
  표시는 `display` 문자열(Rust 가 준 것). 레포 안 토큰이면 완료 후 `["dir"]·["statuses"]` 무효화(`useSaveImage` :1021-1026 관례) — git 변경 목록에 뜨는 것은 **의도**(원본 옆 저장).
- **실행**: `export_check` 1회 → 존재 파일 있으면 확인창 1회(`N개 파일이 이미 있습니다 — 덮어쓰기`) → 직렬 루프(`ensureAssets`(39)·`ensureTextShaping`(50) 을 **루프 전** 1회 await)
  → 진행 `i/M` + `취소`(`AbortController` — 남은 잡 중단, 쓴 파일은 남긴다) → 토스트 `N/M 파일 · 실측 합계`(창별 토스트 주인 규칙 `events.ts:36-45`는 이 잡이 JS 안에서 끝나므로 불필요).
  성공 시 모달 닫힘 + `export_release`.
- **메모리 게이트**: `estimateRenderBytes(scene,{outW,outH,format}).peak`(40) 합이 원장 목표(2x 4K 450MB)를 넘는 잡은 `job.error`; `health://level` warn 이상
  (`HealthBanner.tsx:63` 리스너와 같은 이벤트 — 40 §3.5)이면 2x 이상 행 실행 전 확인창 1회("메모리 압박 — 그래도 내보내기").

### 3.9 슬라이스 도구(S)

| 대안 | 평가 |
|---|---|
| **A. 슬라이스 = `fills:[]·strokes:[]·clipsContent:false`인 `FrameNode` + `exportRows:[{scale:1,suffix:'',format:'png',quality:90}]` 1행 자동, `name:'슬라이스 N'`. 드래그 생성은 `makeDraft`(`AnnotationLayer.tsx:1155`, 37 분할 뒤 `annotation/pointer.ts`)의 rect 분기와 같은 두 점 → 최상위(`parentId:null`) 끝에 추가** (채택) | 새 kind 0 — 렌더는 39 가 빈 페인트를 그리지 않고, 히트·선택·이동·리사이즈·레이어 패널(44 프레임 행)·히스토리가 프레임 그대로. 모달 대상 목록은 `exportRows.length>0` 규칙으로 자동 포함 |
| B. `kind:'slice'` 신설 | 37 유니온·38 트리·39 렌더·44 패널 exhaustive switch 전부 +1 케이스 — 프레임과 다를 것이 없다 |
| C. 문서 밖(UI 스토어) 슬라이스 | 저장·undo·사이드카(41)에서 빠진다 |

판정 `isSlice(n) = n.kind==='frame' && n.fills.length===0 && n.strokes.length===0 && n.exportRows.length>0` — `ponytail: 휴리스틱. 사용자가 슬라이스에 채우기를 넣으면
일반 프레임이 된다(의도 — Figma 슬라이스도 페인트가 없다)`. 표시: 도구가 `slice`이거나 선택된 슬라이스는 43 `ChromeState.extra`에 점선 rect 1개씩(캔버스 크롬 0줄).
`Tool`에 `'slice'`·키 `S`·`Ctrl+Shift+E`는 42 표 소유(행 2개 요청, §4 접점). 슬라이스는 저장·평탄화 출력에 아무것도 남기지 않는다(빈 프레임).

### 3.10 메모리 — 40 원장 표에 합산(축별 계산 금지)

40 §3.5 목표 `2x 저장 피크 ≤450MB`가 이미 export 수치(출력 133 + 인코더 리드백 133 + Blob 30 + raw body 30)로 잡혀 있다. 이 태스크 추가분: 프록시·미리보기 ≤0.25MP ≈1MB,
프로필 청크 편집은 바이트 배열 1벌 복사(≤64MB 일시). 직렬 실행·`width=0` 즉시 해제로 피크 = 1잡. 1080p 2x 일반 케이스 ≈200MB. 40 실측표 '2x 저장' 행을 **이 태스크의
`runExport` 경로로** 채운다(§7 실기).

### 3.11 만들지 않는 것

- `height` 배율·AVIF Display P3·SVG/PDF 출력(`nodeToSvg` 계약이 생기면 `format:'svg'` + '텍스트 윤곽선화' 활성 — 지금은 없다)·원본 메타데이터 보존(INDEX §10.5).
- 병렬 인코딩·워커 인코딩·잡 큐 영속(창을 닫으면 진행 중 배치는 취소).
- 레이어별 분리의 재귀 펼치기(직계 자식만), 슬라이스 중첩 규칙·자동 이름 편집 UI(레이어 패널 F2 로 충분), 프리셋 가져오기/내보내기, 내보낸 파일 자동 열기·폴더 열기 버튼(`commands/open.rs` 재사용 후속).
- `.gpv.json` 문서 내보내기(41 후속) — 이 모달은 픽셀만.
- 자체 다이얼로그 UI(폴더 선택은 OS 다이얼로그), 경로 텍스트 입력(경로가 JS 에 오지 않는다).

## 4. 계약 (소유: 52 · `src-tauri/src/commands/export.rs`, `src/lib/annotate/export.ts`, `src/components/image/ExportDialog.tsx`, `inspector/ExportSection.tsx`)

```rust
// src-tauri/src/commands/export.rs  (mod.rs +2, lib.rs invoke_handler :943 옆 +6, state.rs AppState.export_dirs +2)
pub struct ExportDirs { map: HashMap<String, ExportDirEntry>, order: VecDeque<String> }          // LRU 16
struct ExportDirEntry { path: PathBuf, in_repo: Option<String> /* project_id */, batch_bytes: u64 }
#[derive(Serialize)] pub struct ExportDir { token: String, display: String, in_repo: bool }
#[tauri::command(async)] async fn export_pick_dir(app, state) -> Result<Option<ExportDir>, IpcError>   // pick_folder 콜백+oneshot, set_directory(최근), 성공 시 export.json 갱신
#[tauri::command] fn export_last_dir(app, state) -> Result<Option<ExportDir>, IpcError>                  // load_json("export.json","lastDir") 존재 확인 후 토큰
#[tauri::command] fn export_dir_for_repo(state, project_id: String, rel_dir: String) -> Result<ExportDir, IpcError> // resolve_in_repo(repo, rel_dir) (빈 rel_dir = 루트)
#[tauri::command] async fn export_check(state, token: String, names: Vec<String>) -> Result<Vec<String>, IpcError>  // 이름 전수 검증(§3.2 ②) 후 존재하는 이름; batch_bytes 리셋
#[tauri::command] async fn export_write(state, request: tauri::ipc::Request<'_>) -> Result<u64, IpcError>
//   headers: x-gpv-dir=token · x-gpv-name=percent-encoded UTF-8 · x-gpv-overwrite=0|1 · body: InvokeBody::Raw(≤64MB) · 배치 ≤256MB · tmp→rename
//   에러: NotFound(토큰) · Io(이름·.git·symlink·dir·상한) · AlreadyExists(overwrite=0) — 문구는 write_file_bytes 와 동일
#[tauri::command] fn export_release(state, token: String)
// tree.rs: validate_rel_file · is_dotgit_component 를 pub(crate) 로 (본문 불변). cargo test: 이름 검증 표(§7)·LRU 폐기.
```

```ts
// src/lib/ipc.ts
export function invokeRaw<T>(cmd: string, body: Uint8Array, headers: Record<string,string>, timeoutMs = 120_000): Promise<T>; // withSlot('interactive') 경유 · attempts 1 · single-flight 없음
ipc.exportPickDir(): Promise<ExportDir | null> · exportLastDir(): Promise<ExportDir | null> · exportDirForRepo(pid, relDir): Promise<ExportDir>
ipc.exportCheck(token, names: string[]): Promise<string[]> · exportWrite(token, name, bytes: Uint8Array, overwrite: boolean): Promise<number> · exportRelease(token): Promise<void>
export interface ExportDir { token: string; display: string; inRepo: boolean }

// src/lib/image-codec.ts (+≈90)
export function pngAddSrgbChunks(bytes: Uint8Array): Uint8Array;   // IHDR 뒤 sRGB·gAMA·cHRM — 이미 있으면 그대로
export function jpegStripIcc(bytes: Uint8Array): Uint8Array;       // APP2 'ICC_PROFILE\0' 세그먼트 제거
export function webpStripIccp(bytes: Uint8Array): Uint8Array;      // ICCP 청크 제거 + VP8X 플래그 + RIFF 크기
export function pngChunks(bytes: Uint8Array): string[];            // e2e·디버그용 청크 타입 목록(순수)

// src/lib/annotate/export.ts (ExportRow 는 37 types.ts import)
export interface ExportOptions { transparentBg: boolean; includeAnnotations: boolean; padding: number; splitLayers: boolean; embedProfile: boolean; hidpiAuto: boolean;
  namingRule: boolean; pattern: string; readonly stripMetadata: true; readonly outlineText: false }
export type ExportTarget = { kind: 'artboard' } | { kind: 'node'; id: ObjId };
export interface ExportJob { target: ExportTarget; row: ExportRow; bounds: Rect; outW: number; outH: number; nodeIds?: readonly ObjId[]; fileName: string; error?: string }
export interface ExportPreset { id: string; name: string; rows: ExportRow[]; options: ExportOptions }   // 51 ImageLibrary.exportPresets 항목
export const MAX_JOB_PIXELS = 40_000_000; export const DEFAULT_PATTERN = '{레이어}_{배율}{접미사}.{확장자}'; export const BUILTIN_PRESETS: ExportPreset[]; // '웹 기본'
export function planExport(doc: EditorDoc, scene: Scene, targets: ExportTarget[], rows: ExportRow[], o: ExportOptions, ctx: { stem: string; dpr: number }): ExportJob[]; // 순수
export function fileNameOf(pattern: string, t: { 레이어: string; 배율: string; 접미사: string; 확장자: string; 원본: string; 날짜: string }): string;              // 순수
export function renderJob(scene: Scene, image: CanvasImageSource, job: ExportJob, o: ExportOptions): HTMLCanvasElement;   // 40 renderOutput 1회(colorSpace = row.profile)
export function encodeJob(canvas: HTMLCanvasElement, row: ExportRow, o: ExportOptions): Promise<Uint8Array>;             // encodeCanvas + §3.4 청크 삽입/제거
export function estimateExport(scene, image, jobs: ExportJob[], o): Promise<{ perJob: number[]; total: number }>;         // ≤0.25MP 프록시 × 화소비, 키 캐시
export function runExport(scene, image, jobs: ExportJob[], dir: ExportDir, o, on: { progress(i: number, n: number): void; signal: AbortSignal }): Promise<{ written: string[]; bytes: number; skipped: number }>;
export function isSlice(n: Node): boolean;
export function sliceNode(a: Point, b: Point, ordinal: number): FrameNode;   // makeDraft 'slice' 분기가 호출

// src/components/image/ExportDialog.tsx  — props { targetIds?: ObjId[] } · z-[52] · useOccludesWebview(true) · role="dialog" aria-label="내보내기"
// src/components/image/inspector/ExportSection.tsx — 45 '내보내기' 탭 콘텐츠(선택 노드 exportRows 편집 + '내보내기…')
// ImageEditor: openExportDialog(targetIds?) · 타이틀바 '내보내기'(42 EditorTitleBar 슬롯, 그 전엔 :1013-1019 '맞춤' 옆)
```

접점(요청) — 이름은 각 소유 문서 §4 그대로:
- **37 §4** `ExportRow`에 `profile?: 'srgb'|'display-p3'` 1필드(`normalizeNode`가 `'srgb'`) — 37 커밋1 전이면 37 이, 후면 이 태스크가 1줄 PR.
- **39/40 §4** `renderOutput`/`RenderOpts`: `nodeIds: []` = 노드 없이 배경만(빈 배열 케이스 명시), `renderOutput` 옵션 `colorSpace?: 'srgb'|'display-p3'`(출력 캔버스 생성 인자 1개 통과).
- **42** `Tool`에 `'slice'`(레일 아이콘 슬라이스, 키 `S` — 42 §3.5 반영됨), `EDITOR_SHORTCUTS` 행 `file.export`(`Ctrl+Shift+E`, Mac `⇧⌘E`, `consume:true`, `when:'always'` — 42 §3.4 파일 그룹 반영됨).
- **43** `ChromeState.extra`에 슬라이스 점선 rect(`dash:[4,4]`, 도구 `slice` 또는 선택 시).
- **45** 인스펙터 `내보내기` 탭 슬롯에 `<ExportSection/>` 마운트, 컨텍스트 바 `내보내기` 버튼 없음(타이틀바만 — 시안 ⑧ 컨텍스트 바에 없다).
- **51** `ImageLibrary.exportPresets: ExportPreset[]`·`exportDefaults: { rows: ExportRow[]; options: ExportOptions; target: 'source'|'last' }` 슬라이스 + `upsertExportPreset/removeExportPreset/setExportDefaults`.

e2e DEV 훅(`window.__gpv.imageEditor` 옆, `ImageEditor.tsx:951-964` 관례): `imageExport = { plan(targets, rows, o): ExportJob[]; run(dir: ExportDir, jobs): Promise<…>;
open(targetIds?): void; dirForRepo(relDir): Promise<ExportDir>; write(token, name, base64: string, overwrite): Promise<number> /* base64→Uint8Array→invokeRaw */; check(token, names);
release(token); pngChunks(base64): string[] }` — `cdp.try`는 JSON 인자만 보내므로 raw body 경로는 페이지 훅으로만 검사한다.

## 5. 단계

0. **프로브**(반나절): `invokeRaw` 스텁 + 임시 커맨드로 64MB `Uint8Array` 왕복(dev WebView2) — 통과/상한값을 40 실측표 옆에 기록. 실패 시 파일 상한 = 실측값, 3x 행은 `job.error`.
1. **Rust**: `export.rs` 신규(≈230: 토큰 레지스트리·6 커맨드·이름 검증·tmp→rename) + `state.rs`(+4) + `mod.rs`/`lib.rs`(+8) + `tree.rs` 가시성 2단어 + `cargo test` 3개(이름 표·LRU·배치 상한).
2. **전송·코덱**: `ipc.ts` `withSlot` 추출 + `invokeRaw` + 래퍼 6(+≈50), `image-codec.ts` 청크 3함수(+≈90).
3. **엔진**: `export.ts` 신규(≈340: plan/fileName/renderJob/encodeJob/estimate/run/slice). 이 시점에 DEV 훅으로 (x-1)~(x-8) 통과 가능(UI 없이).
4. **UI**: `ExportDialog.tsx`(≈540) + `ExportSection.tsx`(≈150) + `ImageEditor`(+45: 열기·단축키 액션·타이틀바 버튼·훅) + 51 프리셋 슬라이스(+40). e2e (m-1)~(m-7).
5. **슬라이스**: `makeDraft` `slice` 분기(+25) + 42 `Tool`/키 행(+4) + 43 크롬 prim(+10). e2e (s-1)~(s-3).
6. **e2e `41-image-export.mjs`** 신설(≈420) + `run.mjs` 등록 1줄(35 뒤·31 앞) + 40 실측표 '2x 저장' 행 채움(§7 실기).

규모 **L**: Rust ≈ +250 · 프론트 ≈ +1,300 · e2e ≈ +420 · 신규 의존 0(`percent-encoding`·`uuid`·`tauri-plugin-dialog` 기존).

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| WebView2 raw body 본문 상한 | `http://ipc.localhost` POST 본문 크기 제한 미확인(추정 없음) | §5-0 프로브 선행. 상한이 있으면 `MAX_JOB_PIXELS`·파일 상한을 그 값으로, 초과 잡은 `job.error` 문구('이 환경의 IPC 상한') |
| 다이얼로그가 메인 스레드를 막음 | `blocking_pick_folder`를 async 커맨드 안에서 부르면 데드락 | 콜백 `pick_folder` + `oneshot`, 커맨드는 `async` |
| `.git` 안을 다이얼로그로 고름 | 레포 밖 토큰이라 `resolve_in_repo`를 안 지난다 | `export_write`가 폴더 컴포넌트 전부 `is_dotgit_component` 검사(③) — 15 스위트의 ADS·끝점 우회 표를 폴더 경로에도 적용 |
| 같은 이름 두 파일이 한 배치에 | `-1` 접미가 순수 함수에서 붙지만 디스크 대소문자 무시로 `A.png`/`a.png` 충돌 | `export_check`가 존재 목록을 돌려주고, 이름 정규화(소문자 비교)로 배치 안 중복도 `-1` |
| 프로필 청크 편집이 파일을 깨뜨림 | 마커/청크 파서 오류 | 순수 함수 + e2e (x-4)가 청크 목록·재디코드 픽셀을 함께 단언. 파서 실패 시 원본 바이트 그대로 + 토스트('프로필 처리 실패 — 원본 인코딩으로 저장') |
| P3 캔버스와 sRGB 스크래치 혼합 | 색공간 변환 비용·색 어긋남 | P3 는 40 출력 캔버스 생성 인자 1개로만, 타일 스크래치·프리뷰는 sRGB 고정. (x-4) P3 행 픽셀은 sRGB 원색 ±3 |
| 예상 용량 오차 | 프록시 압축률 ≠ 실물(업스케일 벡터·PNG 필터) | 라벨 '예상', 완료 토스트 실측. (x-8) 은 단조성(q10<q92<png)만 단언 |
| 취소 뒤 부분 결과 | 중간 취소 시 일부 파일만 존재 | 의도된 동작 — 토스트 `N/M 저장`에 명시, 쓴 파일 목록 반환. tmp 파일은 취소 시점에 없다(rename 단위) |
| 토큰 고아 | 모달이 크래시로 닫혀 `export_release` 누락 | LRU 16 — 고아는 폐기되고, 토큰은 경로를 노출하지 않는다 |
| 메모리 압박 중 2x | 40 원장 초과 | `estimateRenderBytes.peak` 게이트 + `health://level` warn 확인창 1회(40 §3.5) |
| 45 셸·51 라이브러리 미착 | 탭 슬롯·프리셋 저장소가 없다 | deps 40·45 명시(INDEX). 51 이 늦으면 프리셋은 내장 `웹 기본`만 + 저장 버튼 미렌더(비활성 버튼 금지 규칙) |

## 7. 검증

- **e2e 41 (신규, 200px 흰 픽스처 + `rectObj(40,40,120,120,RED)`)**:
  (x-1) 전체 아트보드 2x PNG → 파일 400×400, `readSaved` (160,160)=RED·(10,10)=흰색 / (x-2) 노드 대상 + 배경 투명 + 여백 4 → 크기 = `visualBounds`+8 ×배율, (2,2) α0, 중앙 RED /
  (x-3) 주석 포함 OFF → RED 픽셀 0(백지) / (x-4) 색 프로필 ON PNG → `pngChunks`에 `sRGB`·`gAMA`·`cHRM`, OFF → `IHDR/IDAT/IEND`만; JPEG OFF → APP2 없음, ON → 존재; WebP OFF →
  `ICCP` 없음; P3 행 → `iCCP` 존재 + RED ±3 (파일 바이트는 스위트가 `readFileSync(join(fix.repo, rel))`로 직접 파싱) / (x-5) `write(token,'a/b.png')`·`'..\\x.png'`·`'CON.png'`·
  `'.git::$INDEX_ALLOCATION'` → `IO`, 미발급 토큰 → `NOT_FOUND`, 존재+overwrite=0 → `ALREADY_EXISTS`, 65MB → `IO`, `check`가 존재 이름을 정확히 / (x-6) `dirForRepo('')`
  토큰으로 2x 저장 → `fix.status()`에 `? e2e-export_2x@2x.png` 등장 + `["dir"]` 무효화(`isInvalidated`) / (x-7) 패턴 `{레이어}_{배율}{접미사}` → `불량 영역 강조_2x@2x.png`,
  `a/b:c*?.png` → `a_b_c__.png`, 충돌 → `-1` / (x-8) `estimateExport` 유한 양수, 같은 대상 jpg q10 < q92 < png / (x-9, 수동) 4K 픽스처 2x: 내보내기 중 WebView2 private bytes
  피크 < 450MB·완료 후 복귀 — 40 실측표에 기록.
  (m-1) `Ctrl+Shift+E` → `[role=dialog][aria-label=내보내기]`, 대상 목록 `전체 아트보드` + 노드 이름 행, 헤더 `선택 N개 · 총 M개 파일` = 체크×행 / (m-2) `배율 추가` → 행 +1,
  배율 `너비 1200` → 크기 셀 `1200 × 1200`(200px 픽스처 정방) / (m-3) `프리셋 저장` → `image_library_get().exportPresets` 항목, 재오픈 드롭다운 존재, `웹 기본` 선택 → 행
  `[1x '' png, 2x '@2x' png]` / (m-4) 인스펙터 행 추가 → `getDoc().objects[i].exportRows.length===2`, 히스토리 라벨 `내보내기 설정`, `imageDocs.read` 왕복 유지 /
  (m-5) 미리보기 캔버스 부모가 체커보드 클래스, 배경 투명 ON 시 (2,2) α0 / (m-6) 진행 중 `취소` → `written.length < jobs.length`, 토스트 `/\d+\/\d+/` / (m-7) 메타데이터 제거·
  텍스트 윤곽선화 체크박스 `disabled` + `title` 존재, AVIF 행 프로필 셀 `disabled`.
  (s-1) `setTool('slice')` + pointerSeq 드래그 → `objects` 끝에 `kind:'frame'·fills:[]·exportRows.length===1·name:/슬라이스 1/`, `isSlice` true / (s-2) 모달 대상 목록에
  슬라이스 행 기본 체크 / (s-3) 슬라이스 있는 문서 `saveAs` → 슬라이스 영역 픽셀 = 배경(저장에 흔적 0).
- **Rust `cargo test`**: 이름 검증 표(`a/b`·`..`·`CON`·`.git.`·`x::$DATA`·정상 UTF-8 `불량 영역 강조_2x@2x.png`), LRU 17번째 발급 시 첫 토큰 폐기, 배치 누계 256MB 초과 거절.
- **회귀**: 30(91)·34(32)·35(13) 무변경 통과(모달 `z-[52]`·`role=dialog`는 `A.modal` 셀렉터와 무관, `저장 (PNG)`·`다른 이름으로` 경로 불변), 15 무변경.
- **실기**: 실제 OS 폴더 다이얼로그(취소·레포 밖 폴더·`.git` 폴더 선택 거절 토스트), 9파일 배치 완료 토스트 실측 합계, 창을 닫으며 취소, 4K 2x (x-9) 메모리, doc 창(`connectLabel`)에서 같은 흐름.
