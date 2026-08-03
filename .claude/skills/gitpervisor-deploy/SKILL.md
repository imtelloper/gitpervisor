---
name: gitpervisor-deploy
description: Gitpervisor 새 버전을 빌드·검증하고 GitHub Releases로 배포해 웹사이트(gitpervisor.aickyway.com)와 앱 내 자동 업데이트에 반영한다. "배포해", "릴리스해", "새 버전 내보내", "사이트에 새 버전 올려" 요청에 사용.
---

# Gitpervisor 배포

버전 상향 → 로컬 빌드·검증 → 커밋/푸시 → 태그 푸시(CI 릴리스) → 사이트 반영까지의 전 과정.

## 반드시 먼저 알아야 할 3가지

1. **서명은 CI에서만 된다.** `TAURI_SIGNING_PRIVATE_KEY`는 GitHub Actions 시크릿 전용이라
   로컬 빌드는 `.sig`와 `latest.json`을 만들 수 없다. **자동 업데이트가 동작하는 릴리스는
   반드시 태그 푸시 → CI 경로**여야 한다. 로컬 deb를 릴리스에 수동 업로드하면 안 된다.

2. **로컬 빌드는 서명 단계에서 exit 1로 끝나는 게 정상이다.**
   ```
   A public key has been found, but no private key. Make sure to set `TAURI_SIGNING_PRIVATE_KEY`
   ```
   이 에러 **앞에** `Finished N bundle at: .../*.deb`가 있으면 설치파일은 완성된 것이다.
   빌드 성공 판정은 exit 코드가 아니라 **번들 파일 존재**로 한다.

3. **사이트 코드는 건드릴 필요가 없다.** `website/lib/github.ts`가 `releases/latest`를
   런타임에 읽어 플랫폼별 에셋을 링크한다(리눅스는 `.deb` 우선). 새 릴리스가 공개되면
   자동으로 반영된다 — 단, 아래 ISR 캐시 주의사항을 볼 것.

## 절차

### 0. 사전 확인

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # cargo가 기본 PATH에 없다
cd /home/generator/gitpervisor
git status -s                          # 커밋 안 된 변경 파악
gh release list -L 3                   # 현재 최신 릴리스 버전
```

### 1. 버전 상향 — 4곳을 함께 올린다

`package.json` · `src-tauri/Cargo.toml` · `src-tauri/tauri.conf.json` · `src-tauri/Cargo.lock`

```bash
NEW=0.3.3
sed -i "0,/\"version\": \"[0-9.]*\"/s//\"version\": \"$NEW\"/" package.json
sed -i "0,/^version = \"[0-9.]*\"/s//version = \"$NEW\"/" src-tauri/Cargo.toml
sed -i "0,/\"version\": \"[0-9.]*\"/s//\"version\": \"$NEW\"/" src-tauri/tauri.conf.json
(cd src-tauri && cargo update -p gitpervisor --precise "$NEW")   # Cargo.lock 동기화
```

확인: 네 값이 모두 같아야 한다.
```bash
grep -m1 '"version"' package.json; grep -m1 '^version' src-tauri/Cargo.toml
grep -m1 '"version"' src-tauri/tauri.conf.json
grep -A1 '^name = "gitpervisor"$' src-tauri/Cargo.lock | grep version
```

> **버전을 반드시 올려야 하는 이유**: 같은 번호로 다른 내용을 배포하면 (a) 어느 빌드인지
> 구분 불가, (b) 자동 업데이터가 버전으로 비교하므로 갱신 판정이 어긋남, (c) 로그·
> `session.json`의 버전 기록으로 사후 추적이 불가능해진다.

### 2. 로컬 빌드 + 검증

```bash
npm run tauri build -- --bundles deb 2>&1 | tee /tmp/gp-build.log | tail -5
```

- `--bundles deb`로 좁히는 이유: AppImage는 `linuxdeploy` 다운로드/실행 실패로 종종 깨지는데,
  로컬 검증에는 deb만 있으면 충분하다. (CI는 전 포맷을 빌드한다.)
- 프론트 타입 오류는 여기서 먼저 걸린다. 미리 `npx tsc --noEmit`으로 확인해도 좋다.
- Rust 테스트: `(cd src-tauri && cargo test --lib)`

산출물을 **반드시** `installers/`로 복사한다(안 하면 옛 바이너리를 설치하게 된다):
```bash
cp src-tauri/target/release/bundle/deb/Gitpervisor_${NEW}_amd64.deb installers/
rm -f installers/Gitpervisor_<이전버전>*             # 구버전 정리
dpkg-deb -f installers/Gitpervisor_${NEW}_amd64.deb Version   # 버전 확인
```

### 3. 실기기 검증 — 릴리스 전에 반드시

**검증 없이 태그를 밀면 안 된다.** 태그 푸시는 곧바로 전체 사용자에게 자동 업데이트로 나간다.

설치는 sudo 비밀번호가 필요하므로 **사용자에게 요청**한다:
```
! sudo dpkg -i /home/generator/gitpervisor/installers/Gitpervisor_<버전>_amd64.deb && (gitpervisor &)
```

설치 후 확인:
```bash
LOG=~/.local/share/com.greathoon.gitpervisor/logs/Gitpervisor.log
tail -30 "$LOG"                                    # 시작 로그·워처 등록 개수
grep -c . "$LOG"                                   # 로그가 노이즈로 도배되지 않는지
pgrep -x gitpervisor >/dev/null && echo "실행 중"
```
바꾼 기능을 실제로 눌러 본다. 회귀가 의심되면 배포를 멈춘다.

### 4. 커밋 + 푸시

```bash
git add -A
git commit -m "릴리스: v${NEW} — <핵심 변경 한 줄>

<상세>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

### 5. 태그 푸시 → CI가 릴리스를 만든다

```bash
git tag "v${NEW}" && git push origin "v${NEW}"
```

`.github/workflows/release.yml`이 `v*` 태그에 반응해:
- macOS(universal `.dmg`) / Ubuntu(`.deb` `.rpm` `.AppImage`) / Windows(NSIS `.exe`) 빌드
- minisign 서명(`.sig`) + `latest.json` 업데이트 매니페스트 생성
- **`releaseDraft: false`라 자동 공개**된다(초안 아님)

진행 확인:
```bash
gh run list --workflow=release.yml -L 3
gh run watch                                   # 완료까지 대기
gh release view "v${NEW}" --json assets --jq '[.assets[].name]'
```

기대 에셋 **10개** (v0.3.2 실측 기준):

```
Gitpervisor-<v>-1.x86_64.rpm          + .sig      ← ubuntu-22.04
Gitpervisor_<v>_amd64.AppImage        + .sig      ← ubuntu-22.04
Gitpervisor_<v>_amd64.deb             + .sig      ← ubuntu-22.04
Gitpervisor-<v>-1.aarch64.rpm         + .sig      ← ubuntu-22.04-arm
Gitpervisor_<v>_aarch64.AppImage      + .sig      ← ubuntu-22.04-arm
Gitpervisor_<v>_arm64.deb             + .sig      ← ubuntu-22.04-arm
Gitpervisor_<v>_x64-setup.exe         + .sig      ← windows-latest
Gitpervisor_<v>_universal.dmg                     ← macos (신규 설치용, .sig 없는 게 정상)
Gitpervisor_<v>_universal.app.tar.gz  + .sig      ← macos (자동 업데이트용)
latest.json                                       ← 자동 업데이트 매니페스트
```

**`latest.json`의 플랫폼 키를 반드시 확인하라** — 에셋 개수만 세면 macOS 누락을 놓친다:
```bash
curl -sL "https://github.com/imtelloper/gitpervisor/releases/download/v${NEW}/latest.json" \
  | python3 -c "import json,sys; print(sorted(json.load(sys.stdin)['platforms']))"
```
`darwin-aarch64` / `darwin-x86_64`가 없으면 **macOS 사용자만 자동 업데이트를 못 받는다.**
원인은 거의 항상 macOS 매트릭스에 `app` 번들이 빠진 것이다 — Tauri 업데이터는 macOS에서
`.dmg`가 아니라 `.app.tar.gz`를 쓰므로 `--bundles app dmg` 여야 한다.
(v0.3.2~v0.3.4가 실제로 이 상태였다: 에셋은 멀쩡히 생성됐고 dmg 다운로드도 정상이라
겉으로는 아무 문제가 없어 보였다.)

`.sig`들과 `latest.json`이 없으면 자동 업데이트가 동작하지 않는다 — CI 로그를 확인한다
(가장 흔한 원인은 `TAURI_SIGNING_PRIVATE_KEY` 시크릿 누락).

### 6. 사이트 반영 — ISR 캐시 주의

사이트는 `getLatestRelease()`가 `next: { revalidate: 3600 }`으로 **1시간 캐시**한다.
릴리스를 공개해도 최대 1시간 동안 옛 버전이 보일 수 있다.

즉시 반영하려면 사이트를 재배포시킨다(호스팅 플랫폼이 main push에 자동 빌드):
```bash
git commit --allow-empty -m "chore: v${NEW} 공개 후 사이트 재배포 트리거"
git push
```
(이 저장소의 기존 관행이다 — 커밋 `09cebbc` 참고.)

확인:
```bash
curl -s https://gitpervisor.aickyway.com/ | grep -oE 'Gitpervisor_[0-9.]+_amd64\.deb' | head -1
```
새 버전 파일명이 나와야 한다. 다운로드 자체도 확인:
```bash
curl -sI -L "https://github.com/imtelloper/gitpervisor/releases/download/v${NEW}/Gitpervisor_${NEW}_amd64.deb" \
  | grep -iE "^HTTP|content-length" | tail -2
```
`HTTP/1.1 200` + 실제 크기가 나와야 한다.

## 체크리스트

- [ ] 버전 4곳 일치
- [ ] 로컬 deb 빌드 완료(서명 exit 1은 무시) + `installers/` 복사
- [ ] `cargo test --lib` 통과, `npx tsc --noEmit` 통과
- [ ] **실기기 설치·동작 확인**
- [ ] 커밋·푸시
- [ ] 태그 푸시 → CI 성공 → 에셋 9개(`.sig`·`latest.json` 포함) 확인
- [ ] 사이트 재배포 트리거 → 사이트에 새 버전 링크 확인
- [ ] deb 다운로드 URL 200 확인

## 함정 모음

| 증상 | 원인 / 대처 |
|---|---|
| `cargo: command not found` | `export PATH="$HOME/.cargo/bin:$PATH"` |
| 빌드가 exit 1인데 deb는 있음 | 서명 단계(개인키 CI 전용). **실패 아님** |
| AppImage `failed to run linuxdeploy` | 로컬에서 흔함. `--bundles deb`로 우회(CI는 정상) |
| 릴리스는 됐는데 사이트가 옛 버전 | ISR 1시간 캐시 → 빈 커밋으로 사이트 재배포 |
| 사이트 리눅스 버튼이 AppImage를 가리킴 | `website/lib/github.ts`의 `linux:` 선택 순서 확인(deb 우선이어야 함) |
| 자동 업데이트가 안 옴 | 릴리스에 `.sig`/`latest.json` 누락 — CI를 거치지 않았을 가능성 |
| **macOS만** 자동 업데이트가 안 옴 | `latest.json`에 `darwin-*` 키가 없다. macOS 매트릭스에 `app` 번들 누락(`--bundles app dmg` 여야 함). 에셋 개수·dmg 다운로드는 정상이라 겉으로 안 드러난다 |
| 릴리스가 draft로 남음 | `release.yml`의 `releaseDraft: false` 확인. draft면 `/releases/latest` API가 404라 사이트가 폴백 |
| `sudo` 비밀번호 요구 | 설치는 사용자가 `! sudo dpkg -i …`로 직접 실행 |
