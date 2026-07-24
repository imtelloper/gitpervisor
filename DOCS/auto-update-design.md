# 자동 업데이트 설계 (Tauri Updater)

홈페이지에서 새 버전을 매번 내려받아 재설치하는 번거로움을 없앤다. 앱이 스스로 새 버전을
확인하고, 설정 › 업데이트에서 **[지금 업데이트하고 재시작]** 한 번으로 갱신된다.

## 원칙
Tauri 2 공식 **`tauri-plugin-updater`**가 서명 검증 → 다운로드 → 설치 → 재실행까지 처리한다.
직접 구현하지 않고, "언제 확인하고 어떻게 보여줄지"만 앱이 담당한다.

## 전체 흐름
```
[CI]  태그 push → tauri-action 빌드 + 서명(.sig) + latest.json 생성 → GitHub Release 자동 공개
[앱]  시작 시(옵트인) 또는 [지금 확인] → updater.check()
        → latest.json fetch (Rust 네이티브 HTTP — 웹뷰 CSP 무관)
        → 버전 비교 → 새 버전이면 설정에 표시 + 토스트
        → [지금 업데이트] → downloadAndInstall(진행률) → minisign 서명 검증
        → NSIS 설치(perMachine = UAC 승격) → relaunch()
```

## 구성요소
| 영역 | 내용 |
|---|---|
| 서명 키 | minisign 키페어. 공개키 → `tauri.conf.json plugins.updater.pubkey`. 개인키+비번 → GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`. **키 분실 = 기존 설치본 자동 업데이트 영구 불가 → 백업 필수.** |
| 플러그인 | `tauri-plugin-updater`, `tauri-plugin-process`(relaunch). `lib.rs`에 등록. |
| capability | `capabilities/desktop.json` — `updater:default`+`process:default`, **windows:["main"] 전용**(외부 브라우저/팝업 webview 격리 유지). |
| 엔드포인트 | `https://github.com/imtelloper/gitpervisor/releases/latest/download/latest.json`. 릴리스가 `draft:false, prerelease:false`라 latest가 항상 최신 정식 릴리스를 가리킨다. 추가 인프라 없음. |
| CI | `release.yml` Build 스텝 env에 서명 시크릿 2개 추가 → tauri-action이 서명·latest.json 자동 생성/업로드. |
| 프론트 | `stores/updater.ts`(상태머신) + 설정 "업데이트" 섹션 + 시작 시 조용한 확인(App.tsx) + 새 버전 토스트. |
| 설치 UX | `installMode: "passive"`(작은 진행 UI). NSIS perMachine이라 업데이트마다 UAC 승격 프롬프트 1회. |
| 확인 주기 | 시작 시(옵트인, localStorage 토글) + 수동 [지금 확인]. |

## 상태 머신 (`stores/updater.ts`)
```
idle → checking → (upToDate | available | error)
available → downloading{progress} → installed → relaunch()
error(오프라인/매니페스트 없음) → 조용히 무시(silent) / 수동 확인만 노출
```

## 보안
- **minisign 서명 검증이 핵심** — 오염된 설치본을 앱이 거부. CI 공급망 하드닝(액션 SHA 고정,
  persist-credentials:false)에 더해 릴리스 토큰 오염 → 트로이 설치본 배포 경로를 2차 차단.
- 다운로드는 Rust 네이티브 HTTP → 웹뷰 CSP 무관, `connect-src` 수정 불필요.
- 업데이트/재실행 권한은 main 창에만 — 외부 콘텐츠 격리 유지.

## 엣지 케이스
- 첫 서명 릴리스(v0.3.2) 전에는 latest.json이 없어 `check()`가 404 → 조용히 무시(정상).
- 오프라인/실패 → 조용히 무시 + 수동 재시도. 다운그레이드 방지(상향 비교만). 실패 시 기존 버전 유지(롤백 없음).
- Linux는 AppImage만 자동 업데이트(deb/rpm 미지원) — Windows 우선이라 무방.

## 설정 (일회성 · 사용자)
```bash
# 1) 키 생성 (이미 생성됨: ~/.tauri/gitpervisor-updater.key[.pub], 비번 없음)
npx tauri signer generate -w ~/.tauri/gitpervisor-updater.key --password ""
# 2) GitHub Secrets 등록
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/gitpervisor-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""
# 3) 개인키 백업(안전한 곳). 절대 커밋 금지(레포 밖 ~/.tauri에 있음).
# 4) v0.3.2 태그로 첫 서명 릴리스 → 0.3.1에서 실제 업데이트 왕복 검증.
```
