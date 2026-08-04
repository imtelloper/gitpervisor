# Windows 코드서명 (Authenticode)

## 왜 필요한가

v0.3.5까지의 Windows 설치본(`Gitpervisor_*_x64-setup.exe`)은 **무서명**이다
(`Get-AuthenticodeSignature` → `NotSigned` 실측). 웹브라우저로 내려받은 무서명 실행파일은:

- **AhnLab V3 / V3 Lite**: '앱 격리 검사'가 설치파일을 격리 환경에서 먼저 실행·분석한다.
  검사 중에 사용자가 다시 더블클릭하면 "앱 격리 검사 중지" 팝업이 반복되며 설치가
  진행되지 않는다 — v0.3.5에서 실제 발생한 증상.
- **Windows SmartScreen**: "알 수 없는 게시자" 경고로 실행을 막는다.

둘 다 근본 원인은 같다: **Authenticode 서명이 없다.** 신뢰된 인증서로 서명된 파일은
격리 검사 대상에서 대부분 제외되고, SmartScreen 평판도 누적된다.

## 채택 방식: Azure Artifact Signing (구 Trusted Signing)

- **월 $9.99** (Basic, 월 5,000건 — 개인 릴리스에 충분), 서명 초과분 건당 $0.005
- **개인 개발자 가입 가능** — 법인 불필요. 신분증 + 셀피로 신원확인(Individual validation)
- 인증서를 Azure가 단기 발급·관리 — 인증서 파일/USB 토큰 관리가 없다
- CI 통합이 가장 깔끔하다: `artifact-signing-cli`(구 `trusted-signing-cli`) + Tauri `signCommand`

대안 비교: OV 인증서(연 $200~400 + 클라우드 서명 API 별도 요금이 흔함, CI 통합 번거로움),
SignPath OSS(공개 오픈소스 한정, 서버측 서명이라 Tauri의 번들링-중-서명 흐름과 안 맞음).

## 1회 설정 (사용자가 직접 해야 하는 부분)

1. Azure 구독 생성 → 포털에서 **Trusted Signing(리브랜딩 후 Artifact Signing) 계정** 리소스 생성.
   리전을 고르면 엔드포인트가 정해진다(예: East US → `https://eus.codesigning.azure.net`).
2. 리소스 안 **Identity Validation → Individual** 진행(신분증+셀피, 승인까지 수 시간~수일).
3. 승인 후 **Certificate Profile**(Public Trust) 생성.
4. Microsoft Entra ID → **앱 등록** 하나 생성, **클라이언트 시크릿** 발급.
5. Trusted Signing 리소스의 IAM에서 그 앱에 **Trusted Signing Certificate Profile Signer**
   역할 부여(리브랜딩 후 메뉴 명칭은 Artifact Signing…으로 보일 수 있다).
6. GitHub 저장소 Settings → Secrets and variables → **Actions**에 6개 등록:

| 시크릿 | 값 |
|---|---|
| `AZURE_TENANT_ID` | Entra 테넌트 ID |
| `AZURE_CLIENT_ID` | 앱 등록의 클라이언트 ID |
| `AZURE_CLIENT_SECRET` | 앱 등록의 클라이언트 시크릿 |
| `AZURE_SIGN_ENDPOINT` | 리전 엔드포인트 URL (예: `https://eus.codesigning.azure.net`) |
| `AZURE_SIGN_ACCOUNT` | Trusted/Artifact Signing 계정 이름 |
| `AZURE_SIGN_PROFILE` | 인증서 프로필 이름 |

등록 이후의 릴리스(태그 푸시)부터 자동 서명된다. **시크릿이 없으면 CI는 조용히 무서명으로
빌드한다**(기존과 동일) — `release.yml`의 "Prepare Windows code signing" 스텝이 게이트다.

## 동작 방식 / 지켜야 할 것

- `release.yml` Windows 잡이 `artifact-signing-cli`를 설치하고, `--config`로
  `bundle.windows.signCommand`를 주입한다. Tauri는 **번들링 중에** 앱 exe → NSIS 설치본
  순서로 서명하고, 업데이터 서명(`.sig`)은 그 뒤 최종(서명된) 파일 기준으로 생성된다.
- **릴리스에 올라간 에셋을 사후 서명(post-sign)하면 절대 안 된다.** 파일 내용이 바뀌어
  `.sig` 검증이 실패하고 자동 업데이트가 전면 불능이 된다. macOS `app` 번들 누락 사건과
  같은 '겉으로는 멀쩡해 보이는' 유형이므로 특히 주의.
- 업데이터용 minisign 키(`TAURI_SIGNING_PRIVATE_KEY`)와는 **완전히 별개**의 체계다. 혼동 금지.
- `sign.windows.json`은 CI에서만 생성되며 `.gitignore`에 있다(계정명 노출 방지).

## 릴리스 후 검증

```powershell
# 릴리스에서 setup.exe를 내려받아:
Get-AuthenticodeSignature .\Gitpervisor_<버전>_x64-setup.exe | Format-List Status, SignerCertificate
# Status: Valid + 서명자 이름이 나와야 한다. NotSigned면 시크릿/CI 로그 확인.
```

`latest.json` 플랫폼 키 확인(배포 스킬의 기존 절차)은 그대로 수행한다.

## 알려진 이슈

- tauri-action + trusted-signing-cli 조합에서 트레이 아이콘 파일까지 서명을 시도하다
  실패한 사례가 있다([tauri#13991](https://github.com/tauri-apps/tauri/issues/13991), closed).
  서명 스텝이 실패하면 CI 로그에서 **어떤 파일을 서명하다 죽었는지**부터 확인한다.
- 서명해도 SmartScreen 평판은 다운로드가 쌓이며 점진 해소된다(수일~수주).
  AhnLab 앱 격리 검사는 서명만으로 대부분 해소된다.

## 서명 도입 전 임시 대처 (v0.3.5 등 무서명 버전을 설치해야 할 때)

1. "앱 격리 검사 중지" 팝업 → 확인 누르고 **1~2분 대기 후 한 번만** 재실행.
   검사가 끝나 정상 판정되면 그대로 설치된다. 검사 중 반복 더블클릭이 팝업 루프의 원인.
2. 안 되면 V3 Lite **환경설정 → 검사 예외 설정**에 설치파일(또는 다운로드 폴더)을 추가하고 설치.
3. 안랩에 **오진(정상 파일) 신고**: https://www.ahnlab.com → 고객지원 → 악성코드 신고센터에
   setup.exe를 zip으로 첨부해 정상 파일 등록 요청(반영까지 수일). 단, 릴리스마다 파일이
   바뀌어 매번 다시 걸리므로 근본 해결은 서명이다.
