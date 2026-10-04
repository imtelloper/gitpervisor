# macOS 코드서명 (자체 서명 인증서)

## 왜 필요한가

v0.11.x까지의 macOS 앱은 **번들이 서명되지 않았다**(`codesign -d -r-` → `code object is not signed
at all`). 실행 파일에만 링커가 붙인 ad-hoc 서명이 있고, 그 식별자도 빌드마다 무작위다
(`gitpervisor-511cb81a08dcddf4`).

macOS는 Downloads·Desktop·Documents 같은 보호 폴더 접근 허용(TCC)을 **앱의 서명 신원**(designated
requirement)에 묶어 저장한다. 서명이 없으면 묶을 신원이 없어 허용이 남지 않고, 그래서
**"Gitpervisor.app이(가) 다운로드 폴더의 파일에 접근하려고 합니다"가 계속 다시 뜬다**(2026-10 실사례).
Downloads는 즐겨찾기 기본 항목이라(`commands/favorites.rs`) 앱이 실제로 읽는다. 터미널 안 셸이
읽는 것도 앱 몫으로 묻는다.

해결은 **매 릴리스를 같은 인증서로 서명**하는 것이다. 신원이 같으면 한 번 허용이 업데이트 뒤에도
유지된다.

## 채택 방식: 자체 서명 인증서

- 무료. 인증서 `CN=Gitpervisor Code Signing`, RSA 3072, 2046-09-29 만료, SHA-1 `B2BE003E2A21D26B51935ED8B661E93DB34DFE6C`.
- 서명된 앱의 신원: `identifier "com.greathoon.gitpervisor" and certificate root = H"b2be003e…"`.
  자체 서명이라 leaf가 곧 root여서 codesign이 `root`로 적는다(Apple 발급이면 `leaf`).
- **하지 못하는 것**: Apple 발급 인증서가 아니라 공증(notarization)을 못 받는다. 처음 내려받아 열 때
  나오는 "확인되지 않은 개발자" 경고는 그대로다. 그건 Apple Developer ID($99/년)의 일이다.
- 공증을 안 받으니 hardened runtime은 끈다(`tauri.conf.json` `bundle.macOS.hardenedRuntime: false`).
  켜 두면 이득 없이 라이브러리 검증·권한 entitlement 요구만 생긴다. Developer ID로 옮길 때 다시 켠다.

## CI 흐름 (`.github/workflows/release.yml`)

`Prepare macOS code signing` 단계가 macOS 잡에서만 돈다(시크릿이 없으면 건너뛰고 지금처럼 무서명).

1. p12를 임시 키체인에 넣고 사용자 검색 목록 **맨 앞에** 더한다. codesign은 `--keychain`을 줘도
   검색 목록에 없는 키체인에서는 신원을 못 찾는다(`no identity found`, 로컬 실측). 기존 목록은 한 줄씩
   읽어 그대로 잇는다 — 경로에 공백이 있을 수 있어서다(이 맥: `…/iOS Developer: … .keychain`).
2. 인증서를 **코드서명 용도로 신뢰 등록**한다(`sudo security add-trusted-cert -d -r trustRoot -p codeSign`).
   자체 서명은 이게 없으면 `find-identity -v`에 안 나오고 codesign이 거부한다.
   신뢰 설정 변경은 root여도 **화면에서 승인**을 요구해, 화면 없는 셸에서는
   `SecTrustSettingsSetTrustSettings: … no user interaction was possible`로 거부된다(`osascript … with
   administrator privileges`로 실측). 그래서 러너에서는 먼저
   `sudo security authorizationdb write com.apple.trust-settings.admin allow`로 그 승인 규칙을 연다.
   일회용 러너라 가능한 일이다 — 개발 맥에서는 하지 말고 진짜 터미널 창에서 `sudo`로 등록한다.
3. 신원 SHA-1을 `APPLE_SIGNING_IDENTITY`로 넘긴다. Tauri가 번들링 **중에** 서명한다.
   업데이터 `.app.tar.gz`·`.sig`도 서명된 앱 기준으로 만들어진다.

`APPLE_CERTIFICATE` 경로는 쓸 수 없다. Tauri(2.11)는 그 인증서를 Apple 발급 이름
(`Developer ID Application:` 등)으로만 찾는다.

빌드 뒤 `Verify macOS code signature` 단계가 식별자와 인증서 SHA-1까지 맞는지 본다. 릴리스는 이미
공개된 뒤이므로 이 단계가 빨개지면 "서명이 빠진(또는 다른) 채로 나갔다"는 경보다.

## 1회 설정

GitHub 저장소 Settings → Secrets and variables → **Actions**에 2개를 등록한다. 값은 개발 맥의
`~/.gitpervisor-signing/`에 있다(레포 밖, 권한 600).

| 시크릿 | 값 |
|---|---|
| `MACOS_SIGNING_P12` | `pbcopy < ~/.gitpervisor-signing/signing.p12.base64` |
| `MACOS_SIGNING_P12_PASSWORD` | `pbcopy < ~/.gitpervisor-signing/p12-password.txt` |

## 지켜야 할 것

- **인증서를 바꾸거나 잃어버리지 마라.** 신원이 바뀌면 모든 macOS 사용자에게 권한 창이 한 번씩 다시
  뜬다. `~/.gitpervisor-signing/`(특히 `key.pem`·`signing.p12`)을 백업해 둔다. 잃어버렸으면 새로 만들되
  위 SHA-1과 이 문서를 함께 고친다.
- 릴리스 에셋을 사후 서명하지 마라. Windows와 같은 이유로 업데이터 `.sig`가 깨진다.
- 로컬에서 서명된 번들을 만들어 보려면 그 맥에도 같은 신뢰 등록이 한 번 필요하다(위 2번 명령을 **진짜
  터미널 창**에서 — `!`나 osascript로는 승인 창을 못 띄워 실패한다). 신원이 검색 목록의 키체인에 있어야
  하므로 워크플로의 `Prepare macOS code signing` 스크립트를 `sudo` 줄만 빼고 돌린 뒤
  `APPLE_SIGNING_IDENTITY=B2BE003E2A21D26B51935ED8B661E93DB34DFE6C npm run tauri build -- --bundles app`.
  끝나면 검색 목록을 원래대로 되돌리고 임시 키체인을 지운다.
