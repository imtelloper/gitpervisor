# SignPath Foundation 무료 코드서명 — 설계

Windows 설치본을 **무료로** Authenticode 서명하기 위한 설계. 유료 대안(Azure Artifact
Signing, 월 $9.99)은 `DOCS/windows-code-signing.md` 참고. **둘은 택일이다** — 동시에 켜지 않는다.

> 이 문서는 설계다. 구현 전에 **Phase 0(자격 심사)을 반드시 먼저 통과**해야 한다.
> 심사에서 떨어지면 아래 CI 공사는 전부 헛일이 된다.

---

## 1. 무엇이 달라지는가 (먼저 알아야 할 4가지)

| 항목 | Azure ($9.99/월) | SignPath Foundation (무료) |
|---|---|---|
| 게시자 표시 | `imtelloper` | **`SignPath Foundation`** — 내 이름이 안 나온다 |
| 릴리스마다 사람 개입 | 없음 (완전 자동) | **매 릴리스 웹 UI에서 수동 승인** |
| CI 변경량 | 스텝 1개 (이미 완료) | **워크플로 구조 분해** (~80줄) |
| 자격 | 신분증만 있으면 통과 | **심사 통과 필요 — 떨어질 수 있다** |

특히 **수동 승인**이 설계 전체를 지배한다. SignPath Foundation은 OSS 릴리스 서명에 대해
매 요청 승인을 요구한다. CI가 사람을 기다리며 멈춰 있는 구조가 된다.

---

## 2. Phase 0 — 자격 심사 (가장 먼저, 코드 손대지 말 것)

신청: https://signpath.org/apply

### 이미 충족한 것

- ✅ **MIT 라이선스** (OSI 승인, 상용 듀얼라이선스 없음)
- ✅ **공개 저장소** (`imtelloper/gitpervisor`, PUBLIC)
- ✅ **이미 릴리스된 상태** (v0.3.5까지 공개 — "서명할 형태로 이미 배포 중"이어야 함)
- ✅ **GitHub 호스티드 러너만 사용** (OSS는 self-hosted 러너 금지)
- ✅ **번들 서드파티가 전부 OSS** — `resources/tools/`의 `biome.exe`·`ruff.exe` 둘 다 MIT.
  (독점 바이너리가 하나라도 있으면 즉시 부적격)

### 심사 전에 준비해야 할 것

- ⬜ **코드서명 정책 페이지** — Foundation 약관이 프로젝트 홈페이지 게시를 요구한다.
  → `website/app/code-signing-policy/page.tsx` 신설 (Phase 1)
- ⬜ **GitHub 계정 MFA 활성화** — 약관 명시 의무
- ⬜ **역할 정의** (Author / Reviewer / Approver). 1인 프로젝트면 본인이 전부 겸하되
  신청서에 그렇게 밝힌다.
- ⬜ README에 기능 설명 — 있음 ✅ (약관: "기능이 다운로드 페이지에 설명되어야 함")

### 솔직한 리스크

> **거절 가능성이 낮지 않다.** 저장소가 2026-06-12 생성(약 2개월), **스타 0개**다.
> 약관의 "actively maintained"는 충족하지만, Foundation은 **프로젝트의 관련성(relevance)을
> 주관적으로 심사**한다. 신생·저인지도 프로젝트가 보류되는 사례가 흔하다.
> 심사는 수일~수주 걸린다.

**그래서 Phase 0을 먼저 한다.** 승인 메일을 받은 뒤에 Phase 1~3을 진행한다.

---

## 3. 핵심 기술 제약 — 설계를 강제하는 두 가지

### 제약 A: SignPath는 NSIS 내부를 서명하지 못한다

SignPath 아티팩트 설정은 `<msi-file>`, `<zip-file>`, `<appx-file>`, `<nupkg-file>` 등의
심층 서명(deep signing)을 지원하지만 **`<nsis-file>` 요소가 없다.**

Tauri Windows 빌드의 구조:

```
Gitpervisor.exe  ──(NSIS 번들링)──>  Gitpervisor_0.3.6_x64-setup.exe
   (앱 본체)                              (설치 프로그램)
```

앱 본체를 서명하려면 **번들링 전에** 서명해야 하는데, 설치본은 **번들링 후에만** 존재한다.
한 번의 서명 요청으로 둘 다 처리할 수 없다 — 순서가 본질적으로 직렬이다.

→ **변형 A(권장)**: 설치본만 서명. 승인 1회. 신고된 문제(AhnLab 앱 격리 검사, SmartScreen)는
   **다운로드된 설치본**에서 발생하므로 이것으로 해결된다. 설치된 `Gitpervisor.exe`는 무서명으로 남는다.
→ **변형 B**: 2패스 빌드로 둘 다 서명. **승인 2회/릴리스**. 아래 6절에 별도 기술.

### 제약 B: 업데이터 `.sig`가 깨진다

`latest.json`의 `signature`는 **설치본 파일 내용에 대한 minisign 서명**이다. SignPath가
설치본에 Authenticode 서명을 박으면 파일 바이트가 바뀌므로 기존 `.sig`가 무효가 된다.

v0.3.5 `latest.json` 실측 — Windows 키가 **2개**다:

```
windows-x86_64       -> Gitpervisor_0.3.5_x64-setup.exe
windows-x86_64-nsis  -> Gitpervisor_0.3.5_x64-setup.exe
```

→ **SignPath 서명 후 `.sig`를 재생성하고 두 키를 모두 갱신**해야 한다.
   하나만 고치면 자동 업데이트가 절반만 동작하는, 겉보기 정상 상태가 된다
   (macOS `app` 번들 누락 사건과 같은 유형).

---

## 4. Phase 1 — 웹사이트 코드서명 정책 페이지

`website/app/code-signing-policy/page.tsx` 신설. 약관 필수 항목:

- 서명 대상 바이너리 목록 (Windows `*_x64-setup.exe`)
- 빌드·서명 파이프라인 설명 (GitHub Actions → SignPath, 원본 검증)
- 승인 역할과 담당자
- 취약점·오용 신고 연락처
- "Windows 게시자는 SignPath Foundation으로 표시된다"는 안내

`app/page.tsx` 푸터에서 링크한다. 신청서에 이 URL을 적는다.

---

## 5. Phase 3 — CI 구조 변경 (설계 스펙)

### 현재 구조의 문제

`tauri-action`이 **빌드 → minisign 서명 → 릴리스 업로드 → latest.json 생성**을 한 스텝에서
원자적으로 처리한다. SignPath 서명은 이 중간에 끼어들 수 없다(비동기 + 사람 승인).

### 새 구조 — 잡 2개로 분리

```
build-tauri (matrix: macOS, ubuntu-x64, ubuntu-arm)
  └─ tauri-action → 릴리스 생성 + latest.json (darwin/linux 키)
        │
        ▼  needs:
build-windows-signed (windows-latest)
  1. tauri build --bundles nsis            (무서명 설치본 + 임시 .sig)
  2. actions/upload-artifact               (설치본 zip → artifact-id)
  3. SignPath submit-signing-request       ◀── 여기서 사람이 승인 (CI 대기)
  4. tauri signer sign                     (.sig 재생성)
  5. gh release upload --clobber           (서명된 exe + 새 .sig)
  6. latest.json 패치                       (windows-x86_64 + -nsis 2개 키)
```

**잡 분리가 필수인 이유**: Windows가 같은 매트릭스에 남아 있으면 `latest.json`을 누가 마지막에
쓰는지 경쟁 상태가 된다. `needs:`로 순서를 못박아 Windows가 항상 마지막에 패치하게 한다.

### 워크플로 스펙

```yaml
  # 기존 build-tauri 매트릭스에서 windows-latest 항목을 제거한다.

  build-windows-signed:
    needs: build-tauri          # latest.json이 이미 존재해야 패치할 수 있다
    if: vars.SIGNPATH_ENABLED == 'true'    # 미설정 시 조용히 건너뜀
    runs-on: windows-latest
    permissions:
      contents: write
      id-token: write           # SignPath 원본 검증용
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
      - uses: swatinem/rust-cache@v2        # 캐시 허용됨(SignPath 제약 아님)
        with: { workspaces: "./src-tauri -> target", key: windows-signed }
      - run: npm ci

      # 1) 무서명 NSIS 빌드. TAURI_SIGNING_PRIVATE_KEY는 반드시 설정한다 —
      #    없으면 createUpdaterArtifacts:true 때문에 exit 1로 죽는다(CLAUDE.md 참조).
      #    여기서 나온 .sig는 4)에서 버리고 다시 만든다.
      - name: Build unsigned NSIS
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          NODE_OPTIONS: --max-old-space-size=4096
        run: npm run tauri build -- --bundles nsis

      - name: Stage installer
        shell: bash
        run: |
          mkdir -p to-sign
          cp src-tauri/target/release/bundle/nsis/*_x64-setup.exe to-sign/

      # 2) SignPath는 GitHub Actions 아티팩트만 받는다(github-artifact-id 필수)
      - uses: actions/upload-artifact@v4
        id: unsigned
        with: { name: unsigned-installer, path: to-sign/ }

      # 3) 서명 요청 → 사람이 SignPath 웹 UI에서 승인할 때까지 블록
      - uses: signpath/github-action-submit-signing-request@v1
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ secrets.SIGNPATH_ORGANIZATION_ID }}
          project-slug: gitpervisor
          signing-policy-slug: release-signing
          artifact-configuration-slug: nsis-installer
          github-artifact-id: ${{ steps.unsigned.outputs.artifact-id }}
          wait-for-completion: true
          wait-for-completion-timeout-in-seconds: "3600"   # 기본 600초는 사람 승인에 부족
          output-artifact-directory: signed/

      # 4) 서명으로 바이트가 바뀌었으므로 minisign 서명을 다시 만든다
      - name: Re-sign for updater
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        shell: bash
        run: npx tauri signer sign signed/*_x64-setup.exe

      # 5) + 6) 업로드 후 latest.json의 windows 키 2개를 갱신
      - name: Upload & patch latest.json
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        shell: bash
        run: |
          TAG="${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref_name }}"
          EXE=$(ls signed/*_x64-setup.exe)
          gh release upload "$TAG" "$EXE" "$EXE.sig" --clobber
          gh release download "$TAG" -p latest.json -O latest.json --clobber
          SIG=$(cat "$EXE.sig") URL="https://github.com/${{ github.repository }}/releases/download/$TAG/$(basename "$EXE")" \
            python - <<'PY'
          import json, os
          d = json.load(open('latest.json'))
          # 두 키 모두 갱신 — 하나만 고치면 자동 업데이트가 절반만 동작한다
          for k in ('windows-x86_64', 'windows-x86_64-nsis'):
              d['platforms'][k] = {'signature': os.environ['SIG'], 'url': os.environ['URL']}
          json.dump(d, open('latest.json', 'w'), indent=2)
          PY
          gh release upload "$TAG" latest.json --clobber
```

### 저장소에 추가할 파일

`.signpath/policies/gitpervisor/release-signing.yml` — **기본 브랜치에 있어야** SignPath가
소스·빌드 정책을 검증한다(원본 검증의 근거). 내용은 SignPath 프로젝트 설정 화면이 안내하는
템플릿을 따른다.

### GitHub 시크릿 / 변수

| 이름 | 종류 | 값 |
|---|---|---|
| `SIGNPATH_API_TOKEN` | Secret | SignPath 사용자 API 토큰 |
| `SIGNPATH_ORGANIZATION_ID` | Secret | SignPath 조직 ID |
| `SIGNPATH_ENABLED` | Variable | `true` (미설정 시 Windows 잡 자체를 건너뜀) |

---

## 6. 변형 B — 앱 본체까지 서명 (승인 2회)

변형 A는 설치된 `Gitpervisor.exe`가 무서명으로 남는다. 다운로드 시점 문제(AhnLab·SmartScreen)는
해결되지만, 실행 중 일부 백신 탐지나 방화벽 "알 수 없는 게시자" 표시는 남는다.

둘 다 서명하려면 2패스가 필요하다:

1. `cargo build --release` (앱 exe만)
2. **SignPath 승인 #1** → 서명된 exe를 `target/release/`에 되돌려 놓음
3. `npm run tauri build -- --bundles nsis --config '{"build":{"beforeBuildCommand":""}}'`
   → cargo가 소스 변경 없음으로 판단해 재링크하지 않고, 서명된 exe를 그대로 번들링
   → `beforeBuildCommand`를 비우는 이유: 프론트 재빌드로 산출물이 바뀌면 cargo가 재컴파일해
     서명된 exe를 **덮어써 버린다**
4. **SignPath 승인 #2** (설치본)
5. 이하 변형 A와 동일

**권장하지 않는다.** 3단계는 cargo의 신선도 판정에 의존하는 취약한 트릭이고, 릴리스마다
승인 2회를 사람이 눌러야 한다. 변형 A로 시작해서, 실행 중 탐지가 실제로 보고되면 그때 올린다.

---

## 7. 검증

```powershell
# Authenticode — 게시자가 SignPath Foundation이어야 한다
Get-AuthenticodeSignature .\Gitpervisor_<버전>_x64-setup.exe | Format-List Status, SignerCertificate
```

```bash
# 업데이터 — windows 키 2개의 signature가 새 .sig와 일치해야 한다
curl -sL ".../releases/download/v<버전>/latest.json" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print({k:v['signature'][:24] for k,v in d['platforms'].items() if k.startswith('windows')})"
```

**실제 자동 업데이트를 한 번 돌려봐야 한다.** `.sig` 재생성이 어긋나도 파일은 멀쩡히 올라가
겉으로는 정상으로 보인다. 이전 버전을 설치해 두고 업데이트가 실제로 적용되는지 확인한다.

---

## 8. 최종 판단

| | Azure | SignPath |
|---|---|---|
| 비용 | 월 $9.99 | 무료 |
| 게시자 | imtelloper | SignPath Foundation |
| 릴리스당 사람 손 | 0 | **승인 클릭 1회 + CI 대기** |
| 구현 작업 | **완료** | 웹 페이지 + 정책 파일 + CI 분해 ~80줄 |
| 실패 위험 | 없음 | **심사 거절 가능(스타 0, 2개월)** |

연 $120을 아끼는 대가는 **릴리스마다 사람이 붙어야 하는 파이프라인**과 **심사 통과 여부에
대한 불확실성**이다. 릴리스가 잦다면 Azure가, 릴리스가 뜸하고 비용을 0으로 유지하고 싶다면
SignPath가 맞다.

**권장 진행 순서**: Phase 0 신청 → 승인되면 Phase 1~3 구현 → 거절되면 Azure로 간다.
신청은 무료·무위험이므로 먼저 넣어 보고 결과를 보고 결정하는 것이 합리적이다.
