---
name: release
description: Cut a new Gitpervisor release — bump the version, tag it, let GitHub Actions build the Windows/macOS/Linux bundles, publish the GitHub Release, and refresh the website so gitpervisor.aickyway.com serves the new download. Use when the user wants to ship/release/deploy a new version, e.g. "빌드하고 배포해줘", "새 버전 배포", "릴리스 올려줘", "ship a new version", "cut a release", or types /release. NOT for local-only builds (use `npm run build:mac` directly) and NOT for deploying only the website.
---

# /release — 새 버전 빌드 + 배포

`gitpervisor` 저장소 전용. 버전을 올리고 태그를 밀면 GitHub Actions가 3개 OS 번들을 빌드해
GitHub Release로 공개하고, 웹사이트(gitpervisor.aickyway.com)의 다운로드 버튼이 그 릴리스를
가리키게 만든다. **끝났다고 보고하기 전에 실제 다운로드 URL이 새 버전을 가리키는지 확인한다.**

## 이 저장소의 배포 구조 (실측 확인됨)

```
버전 상향 → 태그 push → GitHub Actions(release.yml) → GitHub Release 공개
                                                            ↓
                        웹사이트(Next.js on Vercel)가 런타임에 releases/latest API를 읽어 링크
```

- **빌드는 CI가 한다.** `.github/workflows/release.yml`이 `v*` 태그 push에 반응해
  macOS(`universal .dmg`) · Windows(`nsis .exe`) · Linux(`deb`/`rpm`/`AppImage`)를 만든다.
  로컬 릴리스 빌드는 배포에 **불필요**하다 — 웹사이트가 링크하는 건 CI 산출물이다.
- **소요 시간 ~25분.** 직전 릴리스(v0.3.0) 실측 25m24s. 3잡 매트릭스, macOS 유니버설이 가장 느리다.
- **웹사이트는 배포가 거의 필요 없다.** `website/lib/github.ts`가 요청 시점에
  `api.github.com/repos/imtelloper/gitpervisor/releases/latest`를 읽는다
  (`next: { revalidate: 3600 }`). 즉 릴리스가 공개되면 **최대 1시간 안에** 저절로 바뀐다.
  즉시 반영하려면 릴리스 공개 **후에** `main`을 push해 Vercel이 새로 렌더하게 한다(아래 순서 참고).
- **`releaseDraft: false`가 생명줄.** draft면 `/releases/latest` API가 404 → 웹사이트 버튼이
  릴리스 목록 페이지로 폴백한다(다운로드가 안 된다). workflow에 이미 false로 박혀 있으니 건드리지 말 것.
- **버전은 5곳**에 있다: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
  그리고 파생된 `package-lock.json`·`src-tauri/Cargo.lock`. 하나라도 어긋나면 산출물 파일명이
  엇갈린다. **`package-lock.json`은 오래 빠져 있었다** — v0.5.1에서 0.5.0에 멈춘 채 배포됐고,
  `npm ci`가 그 값을 그대로 쓰므로 빌드·테스트를 다 통과하면서 메타데이터만 어긋난다.

## 절차

### 1. 사전 점검 (하나라도 실패하면 여기서 멈추고 보고)

```bash
git branch --show-current          # main 이어야 한다
git status --short                 # 미커밋 변경 확인
gh auth status                     # 인증돼 있어야 태그 push 후 CI 조회가 된다
git fetch --tags origin
```

- **브랜치가 main이 아니면** 멈추고 사용자에게 확인받는다.
- **작업 트리가 더러우면** 변경 목록을 보여주고 "이 변경을 릴리스에 포함할지" 묻는다.
  임의로 커밋하지 않는다. 포함한다면 릴리스 커밋 전에 별도로 커밋한다.
- **현재 버전 확인 + 5곳 일치 검증**:
  ```bash
  grep -m1 '"version"' package.json
  grep -m1 '"version"' src-tauri/tauri.conf.json
  grep -m1 '^version' src-tauri/Cargo.toml
  ```
  어긋나 있으면 먼저 맞춘다.
- **새 버전 결정**: 인자로 받았으면 그걸 쓰고(`/release 0.4.0`), 없으면 현재 버전을 보여주며
  patch/minor/major 중 무엇인지 묻는다. 임의로 정하지 않는다.
- **태그 중복 확인** — 이미 있으면 멈춘다:
  ```bash
  git rev-parse -q --verify "refs/tags/v<NEW>" && echo "로컬 태그 존재"
  git ls-remote --tags origin "v<NEW>"
  ```

### 2. 버전 상향 (5곳)

`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`의 version을 편집한 뒤
package-lock.json(`npm install --package-lock-only`)과 Cargo.lock을 갱신한다:

```bash
cd src-tauri && cargo metadata --format-version 1 >/dev/null && cd ..
grep -A1 'name = "gitpervisor"' src-tauri/Cargo.lock | head -2   # 새 버전인지 확인
```

### 3. 사전 검증 — CI를 25분 태우기 전에 로컬에서 거른다

```bash
./node_modules/.bin/tsc --noEmit
cd src-tauri && cargo check --tests && cargo test --lib && cd ..
```

- `npx`는 이 셸에서 `_nvm_lazy` 오류가 나므로 **`./node_modules/.bin/tsc`를 직접 호출**한다.
- 하나라도 실패하면 **태그를 만들지 않는다.** 실패 내용을 그대로 보고하고 멈춘다.
- 릴리스 프로필은 thin LTO + codegen-units=1이라 로컬 릴리스 빌드는 오래 걸린다.
  사용자가 명시적으로 요구하지 않는 한 로컬 `npm run build:mac`은 **하지 않는다**(배포에 안 쓰인다).

### 4. 커밋 + 태그

```bash
git add -A
git commit -m "릴리스: v<NEW> 버전 상향"
git tag -a "v<NEW>" -m "Gitpervisor v<NEW>"
```

커밋 메시지는 기존 관례(`릴리스: v0.3.0 버전 상향 + …`)를 따른다. 릴리스에 포함된 주요 변경이
있으면 한 줄로 덧붙인다.

### 5. 태그를 **먼저** push (여기서 CI 빌드가 시작된다)

```bash
git push origin "v<NEW>"
```

> **순서가 중요하다.** 태그를 먼저 밀고 `main`은 릴리스 공개 후에 민다. 그래야 Vercel이
> 웹사이트를 렌더할 때 이미 새 릴리스가 API에 보여서 다운로드 링크가 **즉시** 새 버전이 된다.
> 반대로 main을 먼저 밀면 릴리스보다 먼저 렌더돼 최대 1시간 동안 옛 버전을 가리킨다.
> 부수 효과로, CI가 실패하면 `main`이 아직 안 밀린 상태라 수습이 쉽다.

### 6. CI 감시 (~25분)

```bash
# 태그 push 직후엔 run이 아직 안 잡힐 수 있다 — 나타날 때까지 짧게 재시도
gh run list --workflow=release.yml --limit 1
gh run watch <RUN_ID> --exit-status
```

- 오래 걸리므로 **백그라운드로 돌리고** 완료 알림을 받는다. 짧은 간격으로 폴링하지 말 것.
- 실패하면 실패 잡의 로그를 뽑아 원인을 보고한다:
  ```bash
  gh run view <RUN_ID> --log-failed | tail -60
  ```
  **실패 시 태그를 반드시 정리한 뒤** 재시도한다(안 그러면 같은 태그를 다시 못 민다):
  ```bash
  git push --delete origin "v<NEW>" && git tag -d "v<NEW>"
  ```

### 7. 릴리스 검증 — 자산 5개 + draft 아님

```bash
gh release view "v<NEW>" --json isDraft,tagName,assets \
  --jq '{tag:.tagName, draft:.isDraft, assets:[.assets[].name]}'
```

다음을 모두 만족해야 한다:

| 항목 | 기대값 | 이유 |
|---|---|---|
| `draft` | `false` | true면 `/releases/latest`가 404 → 웹사이트 다운로드가 죽는다 |
| `*_universal.dmg` | 존재 | 웹사이트 macOS 버튼이 `/universal.*\.dmg$/i`를 **가장 먼저** 매칭 |
| `*_x64-setup.exe` | 존재 | Windows 버튼(`/-setup\.exe$/i`) |
| `*.AppImage` | 존재 | Linux 버튼(`/\.appimage$/i` 우선, 없으면 `.deb`) |
| `*.deb`, `*.rpm` | 존재 | Linux 폴백 |

자산 이름 규칙은 `website/lib/github.ts`의 `pick()` 정규식과 맞물려 있다. 이름이 바뀌면
웹사이트 버튼이 릴리스 목록 페이지로 폴백하므로, 매칭 실패는 **배포 실패로 취급**한다.

### 8. main push → 웹사이트 반영

```bash
git push origin main        # Vercel이 여기서 웹사이트를 새로 배포한다
```

### 9. 최종 확인 — 실제 다운로드 URL이 새 버전인지

```bash
# GitHub API가 새 태그를 latest로 보는가
curl -s https://api.github.com/repos/imtelloper/gitpervisor/releases/latest \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['tag_name'], 'draft=',d['draft']); [print(' ',a['name']) for a in d['assets']]"

# 라이브 사이트가 새 버전을 렌더하고, 링크가 새 태그를 가리키는가
curl -s https://gitpervisor.aickyway.com | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -u
curl -s https://gitpervisor.aickyway.com | grep -oE 'https://github.com/[^"]*\.(dmg|exe|AppImage|deb)' | sort -u
```

- 사이트가 아직 옛 버전이면 **실패가 아니다.** Vercel 배포가 끝나지 않았거나 ISR 캐시
  (`revalidate: 3600`)가 남은 것이다. 1~2분 뒤 다시 확인하고, 그래도 옛 버전이면
  최대 1시간 안에 자동 갱신된다고 안내한다. 즉시 원하면 Vercel 대시보드에서 Redeploy.
- 다운로드 링크에 새 태그(`/download/v<NEW>/`)가 박혀 있는 것까지 확인해야 "배포 완료"다.

## 보고

끝나면 다음을 한 번에 보고한다 — 추측하지 말고 실제 출력에 근거해서:

- 새 버전과 태그, CI 소요 시간
- 게시된 자산 5개 이름
- 라이브 사이트가 현재 렌더 중인 버전과 macOS/Windows/Linux 다운로드 URL
- 아직 반영 전이면 그 사실과 예상 반영 시점

## 알려진 함정

- **`.claude/`는 gitignore 대상**이다. `.claude/skills/`만 예외로 추적되도록
  `.gitignore`에 `!.claude/skills/`가 들어가 있다. `.claude/settings.local.json`은 여전히 무시된다.
- **웹사이트가 배포하는 macOS DMG에는 격리 해제 도우미가 없다.** `scripts/build-mac-dmg.sh`가
  만드는 로컬 DMG에는 "처음 실행 — 격리 해제.command"가 들어가지만, 웹사이트가 링크하는 건
  CI가 만든 `universal.dmg`라 그 도우미가 없다. macOS 사용자는 Gatekeeper 격리를 직접
  풀어야 한다(`DOCS/TROUBLESHOOTING.md` 참고). 이걸 바꾸려면 CI가 도우미까지 넣은 DMG를
  만들도록 workflow를 고쳐야 한다 — 릴리스 절차만으로는 해결되지 않는다.
- **`workflow_dispatch`로 돌리지 말 것.** release.yml에 수동 트리거가 있지만 그건 태그가 아닌
  기본 브랜치를 빌드한다. 정식 경로는 태그 push다.
- **버전을 되돌리는 릴리스는 하지 말 것.** `/releases/latest`는 시맨틱 최신이 아니라
  **가장 최근 게시된** 릴리스를 준다.

## Windows 개발기(`F:\gitpervisor`)에서

옛 `gitpervisor-deploy` 스킬의 내용 중 이 머신에만 해당하는 것을 옮겼다(v0.8.1 실측, 2026-09-17).

- **`cargo`가 PATH에 없다** — 셸마다 `export PATH="$HOME/.cargo/bin:$PATH"`. `tsc`는
  `./node_modules/.bin/tsc` 그대로 된다.
- **`git add -A` 금지.** 이 트리는 여러 세션이 같이 쓴다 — 남의 미추적 파일(`designs/…`,
  `.playwright-mcp/` 등)이 릴리스 커밋에 휩쓸려 들어간다. 버전 파일 5개만 골라 add 한다.
- **태그 전에 전체 e2e** — `node tests/e2e/shard.mjs`(3샤드 ≈5분, CLAUDE.md「검증」). 같은 트리를 쓰는
  세션이 있으면 SendMessage 로 `src/`·`tests/` 저장 정지를 합의하고 돌린다(저장 한 번이 vite 리로드로
  회차를 통째로 오염시킨다). 화면이 잠겨 있으면 클립보드 스위트(52·60)가 환경 탓으로 빨갛다.
- **태그 생성과 푸시는 각각 한 줄짜리 별도 호출**로 한다(`git tag -a v<NEW> -m … <sha>` /
  `git push origin v<NEW>`). `&&` 로 묶으면 권한 검사가 통째로 막아 로컬 태그조차 안 생긴 적이 있다.
  사용자가 릴리스를 명시하지 않았으면 태그 푸시는 사용자에게 그 한 줄을 부탁한다.
- **CI 가 끝나면 `installers/` 를 CI 산출물로 바꾼다** — 로컬 빌드 exe 를 넣지 마라:
  ```bash
  gh release download "v<NEW>" -p '*x64-setup.exe' -D installers/ --clobber
  rm -f installers/Gitpervisor_<이전버전>_x64-setup.exe
  ```
- **Windows setup.exe 는 지금 코드 서명이 안 된다(NotSigned)** — Azure 서명 시크릿이 저장소에 없다
  (`DOCS/windows-code-signing.md`). 확인은 Git Bash 에서
  `env -u PSModulePath powershell.exe -NoProfile -Command "(Get-AuthenticodeSignature '<경로>').Status"`.
  **릴리스 에셋을 사후 서명하지 마라** — 파일이 바뀌어 업데이터 `.sig` 검증이 깨진다.
- **자동 업데이트 검증은 에셋 개수가 아니라 `latest.json` 의 플랫폼 키로** 한다 — `darwin-aarch64`·
  `darwin-x86_64`·`linux-x86_64`·`linux-aarch64`·`windows-x86_64` 가 모두 있고 각각 `signature` 가 붙어야 한다.
  v0.3.2~v0.3.4 는 에셋도 CI 도 멀쩡했는데 macOS 만 업데이트가 죽어 있었다(매트릭스에 `app` 번들 누락).
- **로컬 릴리스 번들이 꼭 필요하면**(CI 전 설치본 검증 등) 공유 트리가 아니라 태그 커밋의 워크트리에서
  `npm run tauri build -- --bundles nsis` 로 빌드한다 — 공유 트리엔 남의 미커밋 코드가 섞여 검증한 물건과
  나가는 물건이 달라진다. 성공 판정은 exit code(서명 단계는 로컬에서 늘 실패)가 아니라 번들 파일 존재로.
- `cargo test --lib` 의 preview HLS 통합 테스트는 병렬 실행에서 루프백 RST 로 간헐 실패한 적이 있다
  (원인 미확정, 테스트가 전송 끊김에 3번 재시도하도록 완화함 — 커밋 `cb364aa`). 다시 빨가면 단독
  실행과 `-- --test-threads=1` 로 먼저 가려라.
