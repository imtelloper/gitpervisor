# API 클라이언트 탭 — 기능 설계서 (Standard 티어)

> 상태: 설계(Design) · 대상: gitpervisor (Tauri 2.11.2 + React 19) · 1차 타깃 플랫폼: **Windows (WebView2)**
> 산출물 성격: `/sc:design` — 구현 코드가 아니라 아키텍처·계약(타입/커맨드/이벤트)·단계 계획. 시그니처/타입 스케치는 포함, 본문 구현은 제외.
> 자매 설계서: `DOCS/browser-feature-design.md`(톤·§번호·옵션비교표·리스크 레지스터 Rn·Phase 수용기준·CDP DoD 체계를 차용했다).

## 0. 요구사항

Postman/Insomnia/curl처럼 **임의 HTTP 요청을 작성·전송하고 응답을 검토하는** API 클라이언트 탭을 Viewer/DB/터미널/브라우저와 나란히 추가한다. 핵심 가치:

- **접속해서 바로 테스트**: 메서드·URL·헤더·바디·인증을 폼으로 조립해 dev 서버나 외부 API에 요청을 쏜다.
- **CORS-free**: 프론트 `fetch()`가 아니라 **Tauri 백엔드(reqwest)가 직접 소켓을 연다**. 프리플라이트가 없고, `Set-Cookie`·`Date`·`Server` 같은 forbidden response header까지 원본 그대로 확보하며, DNS→connect→TLS→TTFB 타이밍을 단계별로 분해해 노출한다.
- **컬렉션·환경·히스토리**: 요청을 트리에 저장하고, `{{var}}` 환경 변수로 치환하며, 최근 요청을 기록한다.

핵심 제약(설계 출발점): **`reqwest`가 현재 `src-tauri/Cargo.toml`의 직접 의존에는 없다**(직접 확인, line 22~46). 다만 `reqwest`(+hyper/h2/rustls 핵심 스택)는 **이미 빌드 트리에 컴파일돼 있다** — `tauri 2.11.2`가 transitive로 `reqwest 0.13.4`를 끌어온다(`Cargo.lock:3607`, 소유 `tauri @ 4535/4564`). `base64 0.22.1`도 이미 트리에 있다(`Cargo.lock:158`). 따라서 HTTP 엔진을 위해 필요한 일은 **새 무거운 의존을 들이는 것이 아니라, tauri가 쓰는 reqwest 0.13을 직접 의존으로 노출하고 필요한 feature만 켜는 것**이다(§4.6). 신규 컴파일 증분은 추가 feature와 `serde_urlencoded`에 한정된다. `tokio`/`serde`/`serde_json`/`futures`/`uuid`도 존재한다.

---

## 1. 결론 — 백엔드 HTTP 엔진 + browser식 독립 탭 + 클라이언트 측 치환·인증

API 클라이언트 Standard는 세 축으로 구성한다. 각 축은 기존 코드에서 검증된 패턴을 그대로 미러링한다.

| 축 | 결정 | 근거(기존 코드) |
|---|---|---|
| **HTTP 전송** | 백엔드 `http_request` 단일 async 커맨드 + `http_cancel` 취소 커맨드 | `commands/sync.rs`의 git 네트워크 I/O(async fn + emit), `commands/browser.rs`의 `async fn browser_open` — "네트워크 I/O ⇒ async 커맨드" 규칙(`commands/mod.rs` 노트) |
| **탭 모델** | browser식 **독립 탭**(`items: Record<id, Item>` + `tabIds: string[]`), 분할 패널 미지원 | `src/stores/browser.ts:55-80` items/tabIds, `WorkspaceTabs.tsx` 브라우저 등록 |
| **영속** | localStorage **`gp:apiclient`**, 즉시 저장, 구→신 마이그레이션 | `browser.ts:90`(gp:browser), `terminals.ts:144`(gp:terminals) |
| **치환·인증** | **프론트(전송 직전)** `resolveRequest()` 순수 함수가 1회 수행 | store는 raw 템플릿만 보관, db.ts 액션(상태 set + IPC) 패턴 |

### 1.1 왜 백엔드로 쏘나 (CORS-free 장점)

| 구조 | CORS 우회 | 원본 헤더 | 타이밍 분해 | 취소 | 판정 |
|------|-----------|-----------|-------------|------|------|
| 프론트 `fetch()` | ❌ 프리플라이트/forbidden header 차단 | ❌ Set-Cookie·Date 못 봄 | ❌ Resource Timing만(부정확) | AbortController | ✗ |
| **단일 `http_request`(버퍼)** | ✅ | ✅ | ✅ reqwest 단계 계측 | ✅ 레지스트리+abort | **✅ 채택** |
| 스트리밍 Channel(`term_open` 식) | ✅ | ✅ | ✅ | ✅ | Standard엔 과함(§4.7) |

브라우저 탭은 *임의 적대 원격 콘텐츠*를 네이티브 자식 webview로 렌더해 `BROWSER-NO-IPC` 격리·점유(occlusion)·hung-invoke 방어 같은 무거운 장치가 필요했다. API 클라이언트 Standard는 **전부 메인 React webview 안에서 DOM으로 그린다**(자식 webview 없음). 따라서:

- 점유/bounds 동기화(`ResizeObserver`+`setBounds`)·show/hide·per-attempt 타임아웃 reconcile **불필요**(브라우저 `BrowserPane.tsx`의 복잡도 대부분 생략).
- 네트워크는 `fetch`가 아니라 백엔드 `http_request`로 보낸다 — CORS 우회, 임의 헤더(Origin/Cookie 포함) 설정, TLS 옵션 제어가 목적.
- CDP 9222는 메인 React webview를 **완전히** 커버한다(브라우저 기능 §11 DoD가 "child 내부는 9222 미커버"라 수동/스크린샷에 의존했던 한계가 여기엔 없다). → **API 클라이언트는 CDP로 100% 자동 검증 가능**.

### 1.2 왜 독립 탭인가 (탭 모델 옵션 비교)

| 모델 | 분할 지원 | 복수 탭 | 등록 비용 | 판정 |
|---|---|---|---|---|
| PaneKind에 'apiclient' 추가(터미널식) | O | O | 중(PaneTree/PaneControls 분기) | ❌ 3분할 자체 레이아웃과 충돌 |
| dbProjects식 예약어 'apiclient' | X | X(1개) | 소 | ❌ 복수 탭 불가 |
| **browser식 items/tabIds 독립 탭** | X | O | 소 | ✅ 채택 |

API 클라이언트는 좌(트리)·중(빌더)·우(응답)의 3분할 레이아웃을 자체적으로 가지므로 터미널/브라우저처럼 `Pane` 트리 리프로 쪼개는 것은 의미가 없다. 단, **여러 요청 탭을 동시에 띄우고 싶다**는 요구가 강해 DB식 단일 탭은 부족하다. 따라서 `terminals.ts`의 `PaneKind`를 건드리지 않고 브라우저의 `items/tabIds` 모델만 차용한 **독립 store `useApiClient`**로 구현한다. `PaneTree.tsx`/`PaneControls.tsx`는 **수정하지 않는다**.

---

## 2. 범위 — Standard 포함 / Full 제외

| 영역 | Standard 포함 | Full 티어로 연기 |
|---|---|---|
| 전송 | GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS, 버퍼 응답 | 응답 스트리밍·대용량 다운로드·WebSocket·GraphQL 전용 UI |
| 바디 | none/json/raw/urlencoded/formData(파일=메모리 1회 업로드)/**binary**(base64·파일경로 1회 업로드) | 스트리밍 업로드, 바이너리 응답 파일 저장 |
| 인증 | none/inherit/bearer/basic/apikey(헤더·쿼리 주입) | OAuth2 풀 플로우(auth code/PKCE 자동 토큰 교환) |
| 환경변수 | `{{var}}` 1패스 치환, Global+Collection 2계층 | 중첩 변수·`\{{` 이스케이프·폴더 단위 override·env 상속 체인 |
| 컬렉션 | 폴더/요청 트리, 자체 JSON 영속 | import/export(Postman/OpenAPI/cURL), 컬렉션 러너·시퀀스 실행 |
| 타이밍 | ttfb/download/total 정확 + dns/connect/tls 근사 | 커스텀 hyper Connector 정확 단계 타이밍 |
| 레이아웃 | 독립 탭만 | 분할 패널 내 API 클라이언트(`PaneKind`에 `"apiclient"`) |
| 스크립트 | **없음**(인젝션 표면 0 — §10.5) | pre-request/test 스크립트 엔진(별도 샌드박스 위협모델) |

**확장 호환 원칙**: 데이터 모델의 요청/환경/컬렉션은 위 항목용 optional 필드를 미리 선언해 두고, `loadPersisted`의 마이그레이션 분기(`terminals.ts:82` `migrateLeafContent`·`browser.ts:106` 패턴)로 Full 전환 시 무손실 업그레이드를 보장한다.

---

## 3. 아키텍처 개요

```
┌─ React webview ─ WorkspaceTabs ─ 탭칩(Send) ─ ApiClientTab(lazy) ──────────┐
│  useApiClient(items/tabIds/collections/environments/history)               │
│  RequestBuilder → resolveRequest(env치환 + applyAuth) → PreparedRequest    │
│    invoke("http_request", { requestId, req })  ← 단일 응답(버퍼)            │
│    invoke("http_cancel",  { requestId })       ← 진행 중 abort             │
└────────────────────────────────────────────────────────────────────────────┘
                     ↓ async 워커 스레드
┌─ Rust (commands/http.rs) ───────────────────────────────────────────────────┐
│  AppState.http: HttpReg { inflight: Map<requestId, AbortHandle> }            │
│  ① 클라이언트 빌드(redirect/TLS/timeout) → ② 요청 조립                       │
│  ③ Abortable로 감싸 send → ④ bytes 버퍼 수집(상한 truncate)                 │
│  ⑤ 타이밍 분해(DNS/connect/TLS/TTFB/total) → HttpResponse 반환               │
└──────────────────────────────────────────────────────────────────────────────┘
                     ↓ reqwest (rustls + hyper)
               TCP / TLS / HTTP(1.1·2)
```

데이터 흐름 원칙: **store는 raw 템플릿(`{{var}}` 미해석)만 보관**하고, 치환·인증 주입은 전송 직전 `resolveRequest`가 1회 수행해 최종 `PreparedRequest`를 만든다. 저장물에 해석된 값이 섞이지 않아 env 전환 시 재해석만으로 충분하고, 시크릿이 평문 URL로 영속되지 않는다.

`AppState`(`state.rs` line 22~36)에 `pub http: Mutex<HttpReg>` 한 필드를 추가하고, `terminals`/`browser` 레지스트리와 **동일한 패턴**(`Mutex<HashMap<String, _>>`)으로 in-flight abort handle을 보관한다.

---

## 4. 백엔드 HTTP 엔진 — `src-tauri/src/commands/http.rs`

`terminal.rs`/`browser.rs` 미러: 백엔드가 단일 진실, `requestId`는 프론트가 생성(invoke 응답 유실돼도 "아는 id"로 `http_cancel` 가능 → 고아 in-flight 방지, 동시 invoke 응답 유실에 견고 — 메모리: tauri-webview2-ipc-gotchas).

### 4.A 요청 모델 — `HttpRequest`

- `method`: 임의 문자열(`reqwest::Method::from_bytes`).
- `url`: 절대 URL. 쿼리는 url 인라인 + `query` 목록을 reqwest `.query(&pairs)`로 병합.
- `headers`: `Vec<HeaderKv>` — **순서/중복 보존**(`HashMap` 금지, 같은 키 여러 개 가능). disabled 행은 프론트에서 제거 후 전송.
- `body`: `BodyKind` 태그드 유니온(§4.A.1).
- `timeoutMs`: 옵션, 기본 30s. reqwest `Client::builder().timeout()` + 별도 `tokio::time::timeout` 이중 가드(connect hang 대비).
- `followRedirects` / `maxRedirects`: `false`면 `redirect::Policy::none()`, `true`면 `limited(max)`.
- `verifyTls`: `false`면 `danger_accept_invalid_certs(true)` + `danger_accept_invalid_hostnames(true)`. 기본 `true`. 응답에 실제 사용된 값을 echo해 UI가 "검증 꺼짐" 경고를 표시.

#### 4.A.1 `BodyKind` 처리

| variant | reqwest 조립 | Content-Type |
|---------|-------------|--------------|
| `none` | 본문 없음 | 설정 안 함 |
| `json` | `.body(raw_string)` | `application/json`(헤더에 없으면 보충) |
| `raw` | `.body(text)` | 사용자 헤더 그대로 |
| `formUrlencoded` | `Vec<KvPair>` → `serde_urlencoded` → body | `application/x-www-form-urlencoded` |
| `formData` | `reqwest::multipart::Form` 조립(§4.A.2) | `multipart/form-data; boundary=…`(reqwest 자동) |
| `binary` | `Vec<u8>`(base64 디코드 또는 파일 읽기) | 사용자 지정 or `application/octet-stream` |

**중요**: 사용자가 `headers`에 직접 `Content-Type`을 넣었으면 그 값을 우선한다. 단 multipart는 boundary를 reqwest가 생성하므로 사용자가 넣은 `Content-Type`은 무시한다(덮어쓰면 boundary 불일치로 깨짐 — 이 예외만 명시 처리).

#### 4.A.2 멀티파트(`formData`) — `MultipartPart`

각 파트는 `field`(이름) + 둘 중 하나:
- **text 파트**: `value: String` → `Part::text(value)`.
- **file 파트**: `filePath: String`(+옵션 `fileName`, `contentType`) → `tokio::fs::read` → `Part::bytes(data).file_name(name).mime_str(ct)`.

Standard 티어는 파일을 **메모리로 읽어 한 번에** 올린다. 큰 파일 방어로 `filePath` 크기를 사전 확인해 상한(예 100MB) 초과 시 `Io` 에러로 거절.

### 4.B 응답 모델 — `HttpResponse`

- `status: u16`, `statusText: String`(`StatusCode::canonical_reason`).
- `httpVersion: String`(`HTTP/1.1`·`HTTP/2.0`).
- `headers: Vec<HeaderKv>` — **원본 순서·중복 그대로**(특히 `set-cookie` 다중). lossy UTF-8 문자열.
- `cookies: Vec<SetCookie>` — `Set-Cookie`만 파싱한 편의 필드(UI 쿠키 탭용).
- `timing: HttpTiming`(§4.B.1).
- `body: ResponseBody` — `{ base64, contentType, size, truncated }`. 프론트가 contentType 보고 텍스트/JSON/이미지/hex 렌더.
- `redirects: Vec<RedirectHop>` — 체인(§4.B.2).
- `remoteAddr: Option<String>` — 실제 접속 IP:port(`Response::remote_addr`). "CORS 없는 백엔드 요청" 증거이자 디버깅 가치.

#### 4.B.1 타이밍 분해

reqwest는 단계별 타이밍 API를 노출하지 않으므로(hyper 내부), **두 가지를 결합**한다:

1. **본 요청 정확 측정**: `Instant::now()` 기준으로 (a) send→첫 바이트 = `ttfbMs`, (b) `bytes_stream` 누적 전후 = `downloadMs`, (c) 합 = `totalMs`.
2. **DNS/connect/TLS 근사**: `tokio::net::lookup_host`로 host 해석 시간 = `dnsMs`, 그 IP로 `TcpStream::connect` 시간 = `connectMs`, https면 핸드셰이크까지 한 번 더 측정 = `tlsMs`(본 요청과 별개 사전 프로빙).

> ⚠️ 정정 추적: 초안은 "reqwest가 DNS/connect/TLS를 직접 준다"고 가정했으나 **거짓**이다. reqwest/hyper는 단계 타이밍을 공개 API로 노출하지 않는다. 따라서 Standard에서는 `ttfb`·`download`·`total`은 **정확 측정**, `dns`·`connect`·`tls`는 **사전 프로빙 근사값**으로 제공하고 응답에 `timingExact: false` 플래그로 근사임을 표기한다. 정밀 단계 타이밍이 필요하면 Full 티어에서 커스텀 `Connector`(`hyper-util` + 콜백)로 격상한다.
>
> ⚠️ **사전 프로빙의 부작용·한계(R5와 연동)**: 프로빙은 본 요청과 **다른 소켓**으로 lookup/connect/handshake를 한 번 더 수행하므로 — (1) keep-alive·DNS 캐시·로드밸런서 영향으로 프로빙 값이 본 요청과 **무관해질 수 있어** 워터폴 오해를 오히려 키운다, (2) 동일 호스트에 **연결을 2회** 여는 셈이라 rate-limit·방화벽이 의심할 수 있다(단 connect/handshake까지만이라 비멱등 요청 전송은 아니다), (3) 추가 RTT로 `totalMs` 체감 지연. 따라서 프로빙은 **`send` 직전 1회 best-effort**로만 수행하고 실패해도 무시(해당 단계는 `0`/`NaN` 처리)하며, `timingExact=false`가 이미 근사임을 알리듯 "**connect 프로빙은 본 요청과 별개 소켓이라 참고용**"임을 UI·R5에 명시한다. 부작용이 부담되면 프로빙 자체를 **옵션화(기본 off)**해 `dns/connect/tls`를 미보고로 두는 선택지를 남긴다.

#### 4.B.2 리다이렉트 체인

`redirect::Policy::custom`의 `attempt` 콜백에서 각 hop의 `previous` URL·status를 `Arc<Mutex<Vec<RedirectHop>>>`에 쌓아 최종 응답에 동봉한다. `followRedirects=false`면 첫 3xx를 그대로 반환(체인 길이 0~1).

#### 4.B.3 미정의 세부 규칙 (구현 전 확정)

위에서 빠진 경계 규칙을 명문화한다. 모두 Standard 범위에서 결정 가능하다.

- **압축 해제 vs size 보고**: gzip/brotli/deflate/zstd가 켜져 있으면 reqwest가 **자동 해제**한다. `ResponseBody.size`·`truncated` 판정(`maxBodyBytes`)은 **해제된(디코드된) 바이트** 기준으로 한다(사용자가 보는 실제 본문 크기와 일치, 워터폴 `downloadMs`는 네트워크 수신 시점 기준이라 별개). `Content-Length` 헤더(압축 전 wire 크기)와 `size`가 다를 수 있음을 UI 툴팁에 표기.
- **쿼리 병합 순서·중복**: URL 인라인 쿼리 + `query: Vec<KvPair>`를 합칠 때 **인라인이 먼저, `.query(&pairs)`가 뒤에 append**된다(reqwest가 둘 다 보존, 중복 키 제거 안 함 — 의도된 동작). 같은 키 중복은 **양쪽 다 전송**한다(헤더와 동일하게 순서·중복 보존). percent-encoding은 reqwest `Url`/`serde_urlencoded`에 위임(이중 인코딩 금지 — 프론트는 raw 값만 넘김).
- **Content-Type 자동 보충·중복**: `json` variant는 headers에 `Content-Type`이 **없을 때만** `application/json` 보충(사용자 명시 우선, §4.A.1). headers가 `Vec`라 같은 `Content-Type`이 여러 개 들어올 수 있는데, 이 경우 **사용자 입력을 그대로 전송**하고 보충하지 않는다(중복 판정은 case-insensitive 헤더명 비교). charset은 사용자 명시값을 건드리지 않는다.
- **커스텀 메서드**: 백엔드는 `reqwest::Method::from_bytes`로 임의 문자열 메서드를 허용하지만(§4.A), 프론트 `HttpMethod`는 7종 고정이다. Standard UI는 7종 드롭다운만 노출하되 **계약상 커스텀 메서드 입력 경로를 막지 않도록** `PreparedRequest.method: HttpMethod | string`으로 둔다(§5.1). 커스텀 메서드 입력 UI는 Full 티어.

### 4.5 요청 취소 — `http_cancel`

`futures::future::abortable`로 send 미래를 감싸 `AbortHandle`을 얻고, `AppState.http.inflight`(`Mutex<HashMap<requestId, AbortHandle>>`)에 등록한다. 패턴은 `TerminalSession`(`terminal.rs` line 16-29)이 `closed: Arc<AtomicBool>`로 수명을 제어하는 것과 동형이며, 레지스트리 보관은 `BrowserReg`(`browser.rs` line 40-43)와 동일.

- `http_request` 진입 시 `inflight.insert(requestId, abort_handle)`, 종료 시(성공/실패/취소) `inflight.remove(requestId)` — RAII 가드(`OpGuard` 식, `state.rs` line 69-78)로 패닉 경로도 정리. **락 보유 규칙**: 가드는 `Arc<Mutex<HttpReg>>`만 들고 있다가 insert(생성 시)·remove(drop 시)에서만 순간 잠근다. `inflight.lock()`을 `send().await` 동안 보유하면 안 된다(std MutexGuard는 !Send → .await 가로지르면 Send 위반/데드락 — db.rs `client_of`가 Arc만 짧게 빼는 패턴과 동일). 자세한 동시성 규칙은 §4.9 `HttpReg` 주석.
- `http_cancel(requestId)`: `inflight`에서 핸들을 꺼내 `.abort()`. 없으면 no-op(이미 끝난 요청 — 멱등, `browser_set_visible` 식).
- abort된 future는 `Aborted` → `Cancelled` `ErrorCode`로 매핑해 반환(프론트가 "취소됨" 표시, 에러 토스트 억제).
- **탭/프로젝트 닫기 시 자동 취소**: 마운트 해제 effect에서 그 탭의 모든 requestId를 abort(§9.1.4).

### 4.6 추가 의존성 (Cargo.toml)

> ⚠️ **버전 핀 정정(Cargo.lock 확인)**: `reqwest`는 **이미 트리에 존재**한다 — `tauri 2.11.2`가 transitive로 `reqwest 0.13.4`를 끌어온다(`Cargo.lock:3607-3608`, 소유 `tauri @ Cargo.lock:4535/4564`). 따라서 직접 의존을 **`reqwest = "0.13"`으로 핀**해 tauri가 이미 쓰는 버전과 통일한다(트리 1벌 유지). 0.12로 추가하면 0.12↔0.13이 semver 비호환이라 Cargo가 reqwest/hyper/h2 계열을 **2벌 컴파일** → R3(빌드시간·바이너리 증가) 완화 의도와 정반대 결과. `base64`도 `0.22.1`이 **이미 트리에 다수 존재**(`Cargo.lock:158-160`)하므로 `0.22`로 통일(신규 의존 아님). 신규 비용은 **추가 feature(multipart/gzip/brotli/zstd/cookies)와 `serde_urlencoded`뿐**이다.
>
> ⚠️ **0.12→0.13 API 변경점 재검토 필요**: 본 설계의 redirect(`redirect::Policy` custom·`limited`·`none`, §4.B.2/§10.3), `bytes_stream`(§4.7), `multipart`(§4.A.2) 사용처는 0.13에서 시그니처·동작이 달라졌을 수 있으므로 구현 착수 전 0.13 docs로 확인한다.

```toml
# tauri가 이미 reqwest 0.13.4를 끌어오므로 직접 의존도 0.13으로 통일(트리 1벌).
reqwest = { version = "0.13", default-features = false, features = [
    "rustls-tls",        # TLS 검증 토글·플랫폼 독립(schannel 의존 제거)
    "http2",             # HTTP/2 + httpVersion 보고
    "charset",
    "gzip", "brotli", "deflate", "zstd",  # 자동 압축 해제(Standard 기본 켬)
    "json",
    "multipart",         # §4.A.2 formData 업로드
    "stream",            # 큰 바디 안전 처리(미래 스트리밍 여지)
    "cookies",           # set-cookie 파싱 보조
] }
serde_urlencoded = "0.7"   # formUrlencoded 본문/쿼리 인코딩 (신규)
base64 = "0.22"            # binary 바디·응답 bytes ↔ JSON 직렬화 (0.22.1 이미 트리에 존재 — 버전 통일)
```

**TLS 선택 근거**: 트리에 이미 `native-tls`(tiberius, Cargo.toml line 40)가 있어 재사용도 가능하나, `default-features = false` + `rustls-tls`를 택한다. 이유: (1) `danger_accept_invalid_hostnames`까지 토글 가능(schannel은 일부 제약), (2) Windows schannel 전역 인증서 정책에 끌려가지 않아 `verifyTls` 토글이 **결정론적**, (3) 향후 Linux 빌드 시 OpenSSL 시스템 의존 제거. native-tls와 rustls는 트리에서 **공존**(충돌 없음). ⚠️ 결정 필요: 사내 루트 CA를 schannel 저장소에만 깐 환경에선 native-tls가 더 매끄러움 — 환경에 따라 feature 교체 여지(§12).

### 4.7 큰 응답 바디 — 버퍼 vs 스트리밍

**Standard 티어는 전량 버퍼(`resp.bytes().await`)로 충분하다.** 근거:
- 응답 모델이 `body.base64` 단일 필드로 한 번에 넘어가는 단순 계약 → `ResultGrid`·`renderCell` 재사용과 정합.
- 기존 IPC가 단일 응답 반환(`db_query`, `get_file_diff`)이고 스트리밍은 `term_open`처럼 **진짜 무한/장기 스트림**에만 Channel을 쓴다 — API 응답은 유한하므로 과설계.

**안전장치**: `maxBodyBytes` 상한(기본 25MB)을 두고 `resp.bytes_stream()`을 누적하며 상한 초과 시 **잘라서** `truncated=true`로 반환(메모리 폭발·거대 base64 IPC 페이로드 방지 — base64는 ~1.33배 부풀고 WebView2 동시 invoke 유실 위험). 진짜 스트리밍 다운로드(파일 저장)는 Full 티어 별도 커맨드로 격리한다.

### 4.8 IpcError 매핑

`error.rs`의 `ErrorCode` enum(line 5-15)에 네트워크 구분용 코드를 추가하고, reqwest 에러를 분류한다.

```
추가: Network(연결 거부 등 일반), DnsFailure, ConnectionRefused, TlsError, Cancelled, InvalidUrl
재사용: Timeout(이미 존재), Io(파일/멀티파트 읽기)
```

분류 로직(`classify_failure`(`sync.rs` line 107)와 동형):
- `e.is_timeout()` → `Timeout`("요청이 시간 초과되었습니다").
- `e.is_connect()` + 원인에 `dns`/`failed to lookup`/`name resolution` → `DnsFailure`("호스트를 찾을 수 없습니다").
- `e.is_connect()` + `connection refused`/`os error 10061` → `ConnectionRefused`("연결이 거부되었습니다 — 서버/포트 확인").
- 원인에 `certificate`/`tls`/`handshake`/`invalid peer cert` → `TlsError`("TLS 인증서 검증 실패 — 검증 토글 또는 인증서 확인"). `verifyTls=false` 안내 포함.
- scheme이 `http`/`https`가 아님 → `InvalidUrl`(§10.5 allowlist).
- `Aborted`(취소) → `Cancelled`.
- 그 외 connect → `Network`, 본문/멀티파트 I/O → `Io`.

`stderr` 필드에는 reqwest 에러 체인 전체(`format!("{e:#}")` 또는 `source()` 순회)를 넣어 UI 상세에 노출(`IpcError::git`이 stderr를 채우는 관습과 동일).

### 4.9 Rust 데이터 모델 (commands/http.rs)

```rust
// 모든 직렬화는 기존 커맨드 관습대로 #[serde(rename_all = "camelCase")].
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use futures::future::AbortHandle;

// ===== 요청 =====

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,                 // "GET" | "POST" | ...
    pub url: String,
    #[serde(default)]
    pub query: Vec<KvPair>,             // 순서/중복 보존
    #[serde(default)]
    pub headers: Vec<HeaderKv>,         // 순서/중복 보존 (HashMap 금지)
    #[serde(default)]
    pub body: BodyKind,
    pub timeout_ms: Option<u64>,        // 기본 30_000
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
    pub max_redirects: Option<usize>,   // 기본 10
    #[serde(default = "default_true")]
    pub verify_tls: bool,
    pub max_body_bytes: Option<usize>,  // 기본 25MB, 초과 시 truncate
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvPair { pub key: String, pub value: String }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderKv { pub name: String, pub value: String }

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BodyKind {
    None,
    Json { text: String },                       // 원문 그대로 전송
    Raw  { text: String },                        // Content-Type은 headers 따름
    FormUrlencoded { fields: Vec<KvPair> },
    FormData { parts: Vec<MultipartPart> },
    Binary { base64: String, content_type: Option<String> },
}
impl Default for BodyKind { fn default() -> Self { BodyKind::None } }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartPart {
    pub field: String,
    pub value: Option<String>,        // text 파트
    pub file_path: Option<String>,    // file 파트(택1)
    pub file_name: Option<String>,
    pub content_type: Option<String>,
}

fn default_true() -> bool { true }

// ===== 응답 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub http_version: String,         // "HTTP/1.1" | "HTTP/2.0"
    pub headers: Vec<HeaderKv>,       // 원본 순서·중복(set-cookie 다중 포함)
    pub cookies: Vec<SetCookie>,      // set-cookie 파싱 편의 필드
    pub timing: HttpTiming,
    pub body: ResponseBody,
    pub redirects: Vec<RedirectHop>,
    pub remote_addr: Option<String>,  // 실제 접속 IP:port
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseBody {
    pub base64: String,               // 원본 bytes (프론트가 contentType 보고 디코드)
    pub content_type: Option<String>,
    pub size: usize,                  // 수신 바이트 수
    pub truncated: bool,              // max_body_bytes 초과로 잘림
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpTiming {
    pub dns_ms: f64,
    pub connect_ms: f64,
    pub tls_ms: f64,
    pub ttfb_ms: f64,        // send → 첫 바이트(정확)
    pub download_ms: f64,    // 본문 수집(정확)
    pub total_ms: f64,       // 정확
    pub timing_exact: bool,  // false = dns/connect/tls는 사전 프로빙 근사(§4.B.1)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedirectHop { pub status: u16, pub url: String, pub location: Option<String> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
    pub expires: Option<String>,
    pub max_age: Option<i64>,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: Option<String>,
}

// ===== 취소 레지스트리 (AppState에 추가) =====

// ⚠️ 동시성 규칙 — std Mutex를 .await 경계 너머로 보유 금지.
// inflight는 std `Mutex`(state.rs/db.rs가 전부 std Mutex/RwLock인 기존
// 패턴과 일치)다. http_request는 abortable send를 길게 .await하는 async
// 함수이므로, `inflight.lock()`은 **insert/remove 순간에만 짧게** 획득하고
// **send().await 동안 가드를 절대 들고 있지 말 것**. std MutexGuard는 !Send라
// .await를 가로질러 보유하면 컴파일 거부(Send 위반)되거나 데드락 위험.
// db.rs(최상위 모듈 src/db.rs, lib.rs는 db::db_query로 등록 — commands/ 밑 아님)의
// `client_of`(db.rs:509-517)가 락을 잡아 DbClient를 clone하고 즉시 푸는 패턴, state.rs:69-78
// OpGuard가 Arc<Mutex>만 들고 drop 시점에만 짧게 remove하는 패턴을 그대로 따른다.
// → RAII 가드(아래 §4.5)는 AbortHandle 등록/해제 책임만 지고 락 자체는 들지 않는다.
#[derive(Default)]
pub struct HttpReg {
    pub inflight: HashMap<String, AbortHandle>,  // requestId → abort
}

// ===== 커맨드 시그니처 =====

#[tauri::command]
pub async fn http_request(
    state: tauri::State<'_, crate::state::AppState>,
    request_id: String,             // 프론트 UUID
    req: HttpRequest,
) -> Result<HttpResponse, crate::error::IpcError>;
// 1) 클라이언트 빌드: timeout/redirect(custom로 hop 수집)/tls 토글
// 2) RAII로 inflight 등록 (abortable + AbortHandle), drop 시 remove
// 3) 사전 프로빙으로 dns/connect/tls 근사 (§4.B.1)
// 4) 요청 조립(method/url/query/headers/body) → Abortable send
// 5) ttfb 측정, headers/set-cookie/redirects/remote_addr 수집
// 6) bytes_stream 누적(상한 truncate) → download 측정
// 7) HttpResponse 직렬화 반환

#[tauri::command]
pub fn http_cancel(
    state: tauri::State<'_, crate::state::AppState>,
    request_id: String,
) -> Result<(), crate::error::IpcError>;
// inflight에서 AbortHandle 꺼내 abort (멱등, 없으면 no-op)
```

`http_request`는 네트워크 I/O이므로 **반드시 `async`**. `http_cancel`은 맵 조작뿐이라 동기(`browser_set_visible`·`term_close`와 동일).

---

## 5. 프론트 데이터 모델 — 영속·마이그레이션

> 영속 패턴은 `src/stores/browser.ts`(gp:browser, items/tabIds, loadPersisted 마이그레이션)와 `src/stores/terminals.ts`(gp:terminals, migrateLeafContent)에서 검증된 패턴을 그대로 차용한다. **store는 raw 템플릿만 보관**한다.

### 5.1 TypeScript interface — `src/stores/apiclient.ts`

```typescript
export type HttpMethod =
  | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

// BodyMode는 백엔드 BodyKind(§4.A.1)와 대응한다. "form"은 하위 토글 formType로
// urlencoded↔multipart를 가른다(아래 ApiRequest.body.formType). "binary"는
// §2 범위표에 명시 포함된 Standard 항목(바이너리 1회 업로드, base64/파일경로).
export type BodyMode = "none" | "json" | "form" | "raw" | "binary";

/** "form" 모드의 하위 구분 — 백엔드 FormUrlencoded vs FormData(multipart) 분기. */
export type FormType = "urlencoded" | "multipart";

/** 헤더/쿼리/env 변수 공용 행. enabled=체크박스(DB Key-Value 편집 UI 패턴). */
export interface KvRow {
  id: string;          // crypto.randomUUID()
  enabled: boolean;
  key: string;         // {{var}} 템플릿 허용
  value: string;       // {{var}} 템플릿 허용
}

/** form 행 — KvRow 확장. multipart일 때만 파일 파트 필드를 채운다(urlencoded는 text만).
 *  백엔드 MultipartPart(§4.A.2: field+value | filePath+fileName+contentType)와 1:1. */
export interface FormRow extends KvRow {
  partKind: "text" | "file";   // "text"=value 사용, "file"=filePath 사용
  filePath?: string;           // partKind==="file" — 백엔드가 tokio::fs::read
  fileName?: string;           // 옵션 파일명 override
  contentType?: string;        // 옵션 파트 Content-Type
}

/** 인증 프리셋(§7). 모든 입력값은 {{var}} 치환 대상. */
export type AuthConfig =
  | { kind: "none" }
  | { kind: "inherit" } // 상위 폴더(컬렉션)의 folderAuth 위임
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "apikey"; key: string; value: string; in: "header" | "query" };

/** 컬렉션 트리의 한 요청(= DbSidebar의 Collection/Table 대응). */
export interface ApiRequest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;               // base URL(쿼리스트링 분리 권장), {{var}} 템플릿
  params: KvRow[];           // 쿼리 파라미터
  headers: KvRow[];
  body: {
    mode: BodyMode;          // none/json/form/raw/binary
    rawType: string;         // raw 모드의 Content-Type
    text: string;            // json/raw 본문
    form: FormRow[];         // form 모드의 행(urlencoded는 text 행만, multipart는 file 행 가능)
    formType: FormType;      // "form" 모드를 urlencoded↔multipart로 분기(기본 "urlencoded")
    // binary 모드(§2 Standard) — 택1
    binaryPath?: string;     // 파일 경로(백엔드가 읽음)
    binaryBase64?: string;   // 또는 인라인 base64
    binaryContentType?: string;
  };
  auth: AuthConfig;
}

/** 트리 노드 — 폴더/요청 통합(browser.ts items 미러). */
export type ApiNode =
  | {
      kind: "folder";
      id: string;
      parentId: string | null; // null=루트(rootIds에 포함)
      name: string;
      childIds: string[];      // 자식 순서(폴더+요청 혼합)
      folderAuth: AuthConfig;  // 컬렉션/폴더 스코프 인증 위임점(inherit 해석)
    }
  | {
      kind: "request";
      id: string;
      parentId: string | null;
      request: ApiRequest;
    };

/** 독립 API 클라이언트 탭 1개 (browser.BrowserItem 대응).
 *  ⚠️ **단일 진실**: 폼 편집본(draft)을 영속 items에 두지 않는다 — 매 키입력마다
 *  subscribe 즉시저장이 localStorage write를 유발(폭주)하기 때문(browser.ts는 url
 *  확정 시에만 저장). items에는 **현재 선택된 requestNodeId만** 영속하고, 편집 중
 *  draft는 비영속 store.draftById[tabId]에만 둔다. '저장'(Ctrl+S) 시 draftById →
 *  nodes에 커밋. §5.4 subscribe 화이트리스트(§5.2)는 draftById를 제외한다. */
export interface ApiClientItem {
  id: string;            // 탭 id == activeTab 슬롯 키
  projectId: string;
  title: string;         // 칩 라벨 (요청명 또는 "API 1")
  requestNodeId: string | null;  // 빌더에 로드된 요청 노드(nodes 참조). null=새 요청 초안
  view: "params" | "headers" | "body" | "auth";   // 요청 하단 탭
  responseView: "body" | "headers" | "cookies";    // 응답 탭
  bodyFmt: "pretty" | "raw" | "preview";
}

// ---- §6. 환경(Environment) ----

export interface EnvVar {
  key: string;
  value: string;     // {{var}} 미허용(리터럴) — 1패스 치환이므로 중첩 무의미
  secret: boolean;   // true=히스토리 마스킹(§6.4) + 영속 절충 문서화(§5.3)
}

export type EnvScope = "global" | "collection";

export interface ApiEnvironment {
  id: string;
  name: string;
  scope: EnvScope;
  collectionId: string | null; // scope==="collection"일 때 대상 최상위 폴더 id
  vars: EnvVar[];
}

// ---- §4. 히스토리 ----

/** 전송 시점 요약 + 응답 메타 + 타임스탬프(본문 미저장). browser.ts pushHistory 미러. */
export interface HistoryEntry {
  id: string;
  requestNodeId: string | null; // 역참조(삭제됐으면 null)
  method: HttpMethod;
  url: string;        // 해석본이되 시크릿 마스킹된 display 문자열(§6.4)
  status: number;     // 0=네트워크 실패
  statusText: string;
  durationMs: number;
  sizeBytes: number;
  contentType: string | null;
  at: string;         // ISO 8601
}

// ---- 전이 상태(비영속) ----

/** 응답 — store.responses[id]에 임시 보관, 영속 안 함(db.ts result 미러).
 *  백엔드 HttpResponse(§4.B)와 1:1 정합. 평탄화하면 §10.3 리다이렉트 경로·
 *  §8.1 remoteAddr/timing 워터폴·§4.7 truncated 배지·이미지 preview가 데이터 없이 죽는다. */
export interface ApiResponse {
  status: number;
  statusText: string;
  httpVersion: string;                 // §4.B "HTTP/1.1" | "HTTP/2.0"
  headers: KvRow[];
  cookies: KvRow[];                     // SetCookie 파싱본(§4.B SetCookie 미러 — UI 쿠키 탭)
  bodyText: string;                    // 텍스트/JSON 디코드본(contentType 텍스트류일 때)
  bodyBase64: string;                  // 원본 bytes(§4.B ResponseBody.base64) — 이미지/바이너리 preview용
  contentType: string | null;
  sizeBytes: number;                   // 수신 바이트(§4.B ResponseBody.size)
  truncated: boolean;                  // §4.7 maxBodyBytes 초과로 잘림 → 경고 배지
  timing: HttpTiming;                  // §4.B HttpTiming 미러(아래) — 워터폴 단계분해
  redirects: RedirectHop[];            // §4.B.2 체인 — §10.3 리다이렉트 경로 표시
  remoteAddr: string | null;           // §4.B 실제 접속 IP:port — §8.1 표시
  durationMs: number;                  // = timing.totalMs 편의 미러(StatusBar용)
  error: string | null;
}

/** 백엔드 HttpTiming(§4.B.1) 프론트 미러. timingExact=false면 dns/connect/tls는 근사. */
export interface HttpTiming {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  downloadMs: number;
  totalMs: number;
  timingExact: boolean;
}

/** 백엔드 RedirectHop(§4.B.2) 프론트 미러. */
export interface RedirectHop {
  status: number;
  url: string;
  location: string | null;
}

/** 전송 바디 — 백엔드 BodyKind(§4.A.1, §4.9)와 **동형의 태그드 유니온**.
 *  string|null 단일로는 multipart(파일 파트)·binary(base64)를 표현 못해
 *  §4.A.2 멀티파트 전체가 프론트→백엔드 계약에서 단절된다. invoke 페이로드에
 *  이 값을 그대로(camelCase) 실어 백엔드 BodyKind로 역직렬화한다. */
export type PreparedBody =
  | { kind: "none" }
  | { kind: "json"; text: string }
  | { kind: "raw"; text: string }
  | { kind: "formUrlencoded"; fields: { key: string; value: string }[] }
  | { kind: "formData"; parts: PreparedMultipartPart[] }
  | { kind: "binary"; base64?: string; filePath?: string; contentType: string | null };

/** 백엔드 MultipartPart(§4.A.2) 미러 — text 파트는 value, file 파트는 filePath. */
export interface PreparedMultipartPart {
  field: string;
  value?: string;
  filePath?: string;
  fileName?: string;
  contentType?: string;
}

/** §6 치환 결과 — 평문(전송용) + 마스킹(표시/히스토리용) + 미정의 토큰. */
export interface PreparedRequest {
  method: HttpMethod | string;       // 커스텀 메서드 허용(백엔드 from_bytes) — §4.A
  url: string;                       // 평문 최종 URL(쿼리 병합 후)
  headers: Record<string, string>;   // 평문, auth 주입 완료
  body: PreparedBody;                // 태그드 유니온(백엔드 BodyKind와 1:1)
  contentType: string | null;        // json 보충 등 편의(headers에 없을 때만 적용)
}
export interface ResolveResult {
  prepared: PreparedRequest;  // 평문 — 전송에만 사용
  displayUrl: string;         // 마스킹 — 히스토리/표시
  unresolved: string[];       // vars에 없던 토큰명(§6.3)
}

// ---- Zustand store 형태 ----

export interface ApiClientState {
  // 영속 필드(localStorage 'gp:apiclient')
  items: Record<string, ApiClientItem>;          // 독립 탭(browser.items 미러)
  tabIds: string[];                              // 독립 탭 순서(browser.tabIds 미러)
  nodes: Record<string, ApiNode>;                // 컬렉션 트리(폴더+요청 통합)
  rootIds: string[];                             // 최상위 노드 순서
  environments: Record<string, ApiEnvironment>;
  activeEnvId: string | null;                    // Global 스코프 활성
  activeEnvByCollection: Record<string, string>; // collectionId → envId
  history: HistoryEntry[];                       // 상한 100, 최근 우선
  expandedFolders: string[];                     // 트리 펼침(영속, db.expandedConns 패턴)

  // 전이 상태(비영속 — subscribe 화이트리스트 제외)
  activeRequestId: string | null;
  responses: Record<string, ApiResponse>;
  sending: Record<string, boolean>;
  draftById: Record<string, ApiRequest>;         // 미저장 폼 편집본 — **단일 진실**(비영속). 영속 items엔 안 둠(키입력 write 폭주 방지)
  envDialogOpen: boolean;

  // 탭 생명주기 (browser.openBrowser/closeBrowser 미러)
  openTab: (projectId: string) => string;
  closeTab: (id: string) => void;
  // 빌더 편집 — **비영속 draftById만 갱신**(영속 items.draft 아님 → localStorage write 폭주 회피)
  patchDraft: (id: string, patch: Partial<ApiRequest>) => void;
  setView: (id: string, view: ApiClientItem["view"]) => void;
  setResponseView: (id: string, v: ApiClientItem["responseView"]) => void;
  setBodyFmt: (id: string, f: ApiClientItem["bodyFmt"]) => void;
  // 트리/저장
  addFolder: (parentId: string | null, name: string) => string;
  addRequest: (parentId: string | null, init?: Partial<ApiRequest>) => string;
  updateRequest: (id: string, patch: Partial<ApiRequest>) => void;
  moveNode: (id: string, newParentId: string | null, index: number) => void;
  removeNode: (id: string) => void;               // 폴더면 하위 재귀 삭제
  toggleFolder: (id: string) => void;
  selectRequest: (tabId: string, requestId: string) => void; // openCollection 대응
  saveDraft: (tabId: string, collectionId: string) => void;
  // 환경
  addEnvironment: (env: Omit<ApiEnvironment, "id">) => string;
  setEnvVar: (envId: string, index: number, patch: Partial<EnvVar>) => void;
  removeEnvironment: (envId: string) => void;
  setActiveEnv: (envId: string | null, collectionId?: string) => void;
  openEnvDialog: () => void;
  closeEnvDialog: () => void;
  // 전송 (치환+인증+IPC 조합, db.runQuery 대응)
  send: (tabId: string) => Promise<void>;
  abort: (tabId: string) => void;
  pushHistory: (e: HistoryEntry) => void;
  replayHistory: (tabId: string, idx: number) => void;
  clearResponse: (id: string) => void;
}
```

### 5.2 영속 화이트리스트

`browser.ts:251-256`처럼 `subscribe`에서 **영속 필드만** 직렬화한다.

| 필드 | 영속 | 근거 |
|------|------|------|
| `items`, `tabIds` | ✅ | 독립 탭(browser.items/tabIds 미러) |
| `nodes`, `rootIds` | ✅ | 컬렉션 트리 |
| `environments`, `activeEnvId`, `activeEnvByCollection` | ✅ | env 구성 |
| `history` | ✅ (상한 100) | browser.history 미러 |
| `expandedFolders` | ✅ | UX상 트리 펼침은 복원이 자연스럽다(db.expandedConns는 비영속이나 일탈) |
| `activeRequestId` | ❌ | 전이(browser.loading, db.activeConnId 비영속과 동일) |
| `responses`, `sending`, `draftById`, `envDialogOpen` | ❌ | 응답·전송중·미저장 편집본은 세션마다 초기화 |

⚠️ **시크릿 영속 결정**: `EnvVar.secret:true`의 `value`도 **localStorage에 평문 저장**된다(브라우저류 데스크톱 앱 한계 — OS 시크릿 저장소 연동은 Full 티어). 단 §6.4로 **히스토리에는 평문이 안 남는다**. 이 절충을 문서화한다(browser.ts가 세션 쿠키를 복구 불가로 둔 것과 같은 명시적 한계). Full 티어에서 Windows Credential Manager + tauri-plugin-store 백엔드 보관으로 격상하는 확장점을 남긴다.

### 5.3 loadPersisted — 마이그레이션 1패스

`browser.ts:97` 골격 그대로. JSON.parse 실패 시 `empty` 반환(손상 무시) — terminals.ts:167, browser.ts:121 동일.

```typescript
const PERSIST_KEY = "gp:apiclient";
const HISTORY_CAP = 100;  // browser.ts:53과 동일 패턴, 캡만 100

interface Persisted {
  items: Record<string, ApiClientItem>;
  tabIds: string[];
  nodes: Record<string, ApiNode>;
  rootIds: string[];
  environments: Record<string, ApiEnvironment>;
  activeEnvId: string | null;
  activeEnvByCollection: Record<string, string>;
  history: HistoryEntry[];
  expandedFolders: string[];
  // 구버전 마이그레이션 후보(browser.ts browsers[]→items 미러)
  requests?: unknown[];
}

function loadPersisted(): Persisted {
  // tabIds·rootIds·expandedFolders는 배열, items·nodes·environments·
  // activeEnvByCollection은 Record. browser.ts:98(tabIds:[])과 정합.
  // `as unknown as` 캐스팅을 쓰지 말 것 — 캐스팅이 타입 가드를 무력화해
  // tabIds:{} 같은 (런타임 .map/.filter 불가) 버그를 가린다.
  const empty: Persisted = {
    items: {}, tabIds: [], nodes: {}, rootIds: [],
    environments: {}, activeEnvId: null, activeEnvByCollection: {},
    history: [], expandedFolders: [],
  };
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<Persisted>;
    // 구버전(requests 배열) → nodes 맵 마이그레이션 (browser.ts browsers[]→items 미러)
    if (Array.isArray(p.requests)) { /* 변환 로직: req → nodes[req.id] */ }
    return {
      items: p.items ?? {}, tabIds: p.tabIds ?? [],
      nodes: p.nodes ?? {}, rootIds: p.rootIds ?? [],
      environments: p.environments ?? {},
      activeEnvId: p.activeEnvId ?? null,
      activeEnvByCollection: p.activeEnvByCollection ?? {},
      history: Array.isArray(p.history) ? p.history : [],
      expandedFolders: p.expandedFolders ?? [],
    };
  } catch { return empty; }  // 손상 데이터는 버리고 시작(browser.ts:121)
}
```

### 5.4 subscribe 즉시 저장

```typescript
// browser.ts:247 / terminals.ts:355와 1:1 대응. 디바운스 없음.
useApiClient.subscribe((s) => {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({
      items: s.items, tabIds: s.tabIds,
      nodes: s.nodes, rootIds: s.rootIds,
      environments: s.environments, activeEnvId: s.activeEnvId,
      activeEnvByCollection: s.activeEnvByCollection,
      history: s.history, expandedFolders: s.expandedFolders,
    }));
  } catch { /* 무시 */ }
});
```

---

## 6. 환경변수 `{{var}}` 치환 엔진 — `src/lib/apiclient.ts`

순수 엔진은 컴포넌트 밖 모듈에 두어 단위 테스트가 용이하게 한다. 치환은 전송 직전 `resolveRequest`가 1회 수행한다.

### 6.1 적용 지점

전송 직전 다음 필드에 1회 적용:
- **URL** (base + 인라인 쿼리)
- **헤더** value (key는 적용 안 함 — 헤더명은 고정 토큰)
- **쿼리 파라미터** key·value 양쪽
- **바디**: `raw`/`json`/`text`는 문자열 전체, `form`/`urlencoded`는 각 value
- **인증 설정값**(token/username/password/apiKey) — §7 주입 전에 치환

### 6.2 알고리즘 — 단일 1패스(비재귀) + 미정의 보존

```typescript
function substitute(template: string, vars: Record<string, string>): { out: string; missing: string[] } {
  const missing: string[] = [];
  const out = template.replace(/{{\s*([\w.-]+)\s*}}/g, (m, name) => {
    if (name in vars) return String(vars[name]);
    missing.push(name);
    return m; // 미정의는 원문 보존
  });
  return { out, missing };
}
```

- **1패스 고정**(재귀 금지). 변수 값 안에 또 `{{x}}`가 있어도 재해석하지 않는다 → 무한루프/예측불가 차단. (Full 티어에서 깊이 제한 재귀를 옵션화.)
- **미정의 변수**: 원문 토큰(`{{name}}`)을 **그대로 남긴다**(삭제·빈문자 치환 아님). 사용자가 빠진 변수를 눈으로 확인 가능 + 경고 수집.
- **이스케이프**: Standard에서는 **이스케이프 미지원**, 정규식이 `{{ }}` 짝만 매칭하므로 단일 `{`/`}`는 영향 없음.
- 결과는 항상 문자열(`String(value)`) — 숫자/불리언 env 값도 안전.

### 6.3 미정의 변수 수집

`resolveRequest`는 해석 중 매칭됐으나 `vars`에 없는 토큰명을 `unresolved: string[]`로 모아 반환한다. UI는 전송 전 토스트(`useUi.pushToast` — ui.ts:100 패턴)로 경고("정의되지 않은 변수 {{x}}"). 전송은 막지 않는다(사용자 의도일 수 있음).

### 6.4 시크릿 마스킹

- `secret:true` env 변수는 **치환 실행(전송)에는 평문**으로 들어가되, **히스토리/표시용 문자열에는 마스킹**(`••••`)된다.
- 두 결과를 분리 반환: `resolveRequest` → `{ prepared: PreparedRequest(평문), displayUrl: string(마스킹), unresolved }`.
- 히스토리(§5.1)에는 `displayUrl`(마스킹본)만 기록 → 시크릿이 localStorage에 평문 영속되는 것을 차단.
- 마스킹 집합 = "현재 병합 vars 중 secret 값들의 실제 문자열". 해석 후 결과에서 해당 평문을 `••••`로 치환(부분 문자열 매칭). 빈 문자열·1자 시크릿은 마스킹 생략(오탐 방지).

⚠️ **부분문자열 매칭의 본질적 한계(R2 잔존 표면)**:
- **인코딩 변형은 못 잡는다**. 시크릿이 `basic` 인증의 `base64(user:pass)`로 들어가거나, `apikey`가 쿼리스트링에서 percent-encode되면 **평문과 문자열이 달라** 부분문자열 매칭을 빠져나간다. Standard 마스킹 대상은 `displayUrl`(마스킹본)뿐이고, 이 한계 때문에 인코딩된 시크릿은 displayUrl에서도 마스킹되지 않을 수 있다. 권고 보완: 마스킹 집합을 "**평문 + 그 base64/percent-encoded 변형**"으로 확장(여유 있으면), 아니면 최소한 이 한계를 명시.
- **응답 패널·CDP에는 평문 노출**. 마스킹은 history(localStorage 영속)에만 적용된다. `bearer`/`basic` 토큰이 URL 외 헤더에서만 쓰이면 헤더는 history에 저장되지 않아 **localStorage 누수는 없으나**, `PreparedRequest.headers`(평문)·요청 미리보기·응답 패널·CDP DOM에는 **평문이 그대로 노출**된다. 이 잔존 표면은 R2에 포함(Full 티어 keyring 격리 §10.2에서 해소).

### 6.5 env 스코프 병합 — 전역 vs 컬렉션

**스코프 2계층**(Standard 범위):
1. **Global** (`scope:"global"`, `collectionId:null`): 모든 요청에 적용되는 기본 env.
2. **Collection** (`scope:"collection"`, `collectionId:<폴더id>`): 특정 최상위 폴더(컬렉션) 안의 요청에만.

치환 시 **병합 우선순위**(낮음→높음): Global 활성 env → Collection 활성 env. 같은 key는 Collection이 덮는다. `activeEnvId`는 Global 활성 env 1개, Collection 활성은 `activeEnvByCollection: Record<collectionId, envId>`로 관리(터미널 `activeTab[projectId]` 패턴 미러). 다단계 상속/folder-level override는 Full 티어로 미룬다.

### 6.6 순수 엔진 함수 시그니처

```typescript
/** 1패스 치환(재귀 금지). 미정의 토큰은 원문 보존. */
export function substitute(template: string, vars: Record<string, string>): { out: string; missing: string[] };

/** Global+Collection env 병합(Collection 우선). secret 분리 반환. */
export function mergeVars(state: ApiClientState, requestNodeId: string): { vars: Record<string, string>; secretValues: string[] };

/** 치환 → auth 주입 → 쿼리 병합 → 평문/마스킹 산출(§6,§7).
 *  body 분기: mode==="form" && formType==="multipart" → PreparedBody.formData
 *  (FormRow.partKind로 text/file 파트 산출), formType==="urlencoded" → formUrlencoded,
 *  mode==="binary" → binary{base64|filePath}, json/raw/none은 동명 variant.
 *  → 반환 PreparedRequest.body는 백엔드 BodyKind와 동형의 태그드 유니온(PreparedBody). */
export function resolveRequest(
  req: ApiRequest,
  vars: Record<string, string>,
  secretValues: string[],
  inheritedAuth: AuthConfig, // inherit 해석된 상위 폴더 auth
): ResolveResult;
```

---

## 7. 인증 프리셋 → 헤더/쿼리 주입

`AuthConfig`는 종류 태그 유니온. 주입은 **치환(§6) 이후** `applyAuth(prepared, auth, vars)`가 헤더/쿼리에 합성한다.

| 종류 | 입력 | 주입 결과 |
|------|------|-----------|
| `none` | — | 없음 |
| `inherit` | — | 상위 폴더(컬렉션)의 auth를 위임(§6.5 스코프). 최상위까지 none이면 없음 |
| `bearer` | `token` | 헤더 `Authorization: Bearer <token>` |
| `basic` | `username`,`password` | 헤더 `Authorization: Basic <base64(user:pass)>` — `btoa(unescape(encodeURIComponent(...)))`로 UTF-8 안전 인코딩 |
| `apikey` | `key`,`value`,`in:"header"\|"query"` | `in==="header"` → 헤더 `key: value`; `in==="query"` → 쿼리 `key=value` |

- 모든 입력값(token/user/pass/key/value)은 `{{var}}` 치환 대상(§6.1).
- 주입은 **요청 노드의 명시 헤더를 덮지 않고 추가**한다. 단 동일 헤더명이 명시돼 있으면(예: 사용자가 직접 `Authorization` 행 추가) **사용자 명시값 우선**(auth 주입 스킵) — 예측 가능성.
- `inherit`: `nodes[parentId].folderAuth`를 루트까지 거슬러 첫 non-`none`/non-`inherit`를 찾는다(§6.5 컬렉션 스코프 인증과 동일 경로).

---

## 8. UI / 컴포넌트

> 신규 컴포넌트는 `src/components/apiclient/` 디렉터리에 모은다(db/browser와 평행). 모든 chrome는 기존 Tailwind 토큰(`bg-base/raised/panel`, `text-fg/-muted/-dim`, `border-edge`, `text-accent`)이라 `data-theme` 전환에 자동으로 따라온다. 새 CSS 변수 추가 없음.

### 8.1 ASCII 레이아웃 목업

3-컬럼 + 중앙 상하 split. 좌 사이드바는 `usePanelWidth('gp:apiclient-sidebar-width', 240, 180, 480)`, 응답 패널은 `usePanelWidth('gp:apiclient-response-width', 480, 320, 900, "left")`로 폭 영속(우측 패널이므로 `side="left"`, `use-panel-width.ts:12` 규약).

```
┌─ ApiClientTab (flex h-full min-w-0) ───────────────────────────────────────────────┐
│ ┌─ CollectionSidebar ─┐┌─ RequestPanel (flex-1) ──────────┐┌─ ResponsePanel ──────┐ │
│ │ aside w=240 (영속)   ││ ┌ RequestBuilder (h-9) ────────┐ ││ ┌ StatusBar (h-8) ──┐ │ │
│ │  [COLLECTIONS    +] ││ │[GET▾][ {{base}}/users  ][Send]│ ││ │ 200 OK · 142ms·2KB│ │ │
│ │  ▾ Users            ││ │           [env: prod ▾]       │ ││ └───────────────────┘ │ │
│ │    • GET  list   ●  ││ └───────────────────────────────┘ ││ ┌ Tabs ─────────────┐ │ │
│ │    • POST create    ││ ┌ ReqTabs(Params/Headers/Body/  │ ││ │[Body][Headers(5)] │ │ │
│ │  ▾ Auth             ││ │       Auth) h-8 ──────────────┐ ││ │      [Cookies(2)] │ │ │
│ │    • POST login     ││ │ ┌ KeyValueEditor / BodyEditor ┐ ││ └───────────────────┘ │ │
│ │  ▸ Orders           ││ │ │ ☑ key      value      ✕     │ ││ ┌ [Pretty][Raw]    ┐ │ │
│ │                     ││ │ │ ☑ Authorization {{tok}} ✕   │ ││ │      [Preview]    │ │ │
│ │ ─ HISTORY ───────── ││ │ │ ☐ ───add row───             │ ││ │ ┌ monaco RO json ┐│ │ │
│ │  GET /users   200   ││ │ └─────────────────────────────┘ ││ │ │ {              ││ │ │
│ │  POST /login  401   ││ │                                 │ ││ │ │   "id": 1,     ││ │ │
│ │                     ││ │                                 │ ││ │ │   "name": ".." ││ │ │
│ │ [≡resize]           ││ │                                 │ ││ │ └────────────────┘│ │ │
│ └─────────────────────┘└───────────────────────────────────┘└─[resize≡]────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

레이아웃 골격:
```
<div className="flex h-full min-w-0">
  <CollectionSidebar tabId projectId />            {/* aside relative + ResizeHandle */}
  <div className="flex min-w-0 flex-1 flex-col bg-base">
    <RequestBuilder tabId />                        {/* h-9, DbWorkspace QueryEditor 헤더 미러 */}
    <RequestTabs tabId />                           {/* flex-1: Params/Headers/Body/Auth */}
  </div>
  <ResponsePanel tabId />                           {/* relative + ResizeHandle side="left" */}
</div>
```

### 8.2 컴포넌트 트리

```
ApiClientTab (lazy)                          // 3컬럼 루트 + usePanelWidth ×2 + 탭 스코프 단축키
├─ CollectionSidebar                         // DbSidebar.tsx aside 골격 미러
│   ├─ FolderNode / RequestNode (재귀)       // ConnNode→DatabaseNode→CollNode 치환
│   └─ HISTORY MetaSection                   // DbSidebar MetaSection 패턴
├─ RequestPanel
│   ├─ RequestBuilder                        // DbWorkspace QueryEditor 헤더 미러
│   │   ├─ <select method>  (§8.4 색)
│   │   ├─ <input url>      (focus:border-accent, {{var}} 오버레이는 M2)
│   │   ├─ <select env>  + [톱니 → EnvDialog]
│   │   └─ Send 버튼  (주요버튼, Ctrl+↵ 힌트)
│   └─ RequestTabs (SubTabs: Params/Headers/Body/Auth, 카운트 배지)
│       ├─ KeyValueEditor   (Params/Headers 공용)
│       ├─ BodyEditor       (none/json/form/raw, MonacoBox 공유)
│       └─ Auth 폼          (DbConnection Field: select + 조건부 입력)
├─ ResponsePanel                             // relative + ResizeHandle side="left"
│   ├─ StatusBar (h-8)                       // 상태코드 색 배지/ms/KB
│   ├─ SubTabs (Body/Headers(n)/Cookies(n))
│   └─ Body 뷰토글 [Pretty(MonacoBox RO)/Raw(<pre>)/Preview(iframe/img)]
├─ KeyValueEditor                            // 신규 공통 — 4곳 재사용(헤더/쿼리/form/env)
├─ BodyEditor
├─ MonacoBox                                 // @monaco-editor/react 얇은 래퍼(readOnly prop)
└─ EnvDialog                                 // 모달: 좌 환경목록 + 우 변수 KeyValueEditor
```

### 8.3 탭 등록 지점 — `WorkspaceTabs.tsx` (browser 미러)

`WorkspaceTabs.tsx`는 이미 4종(Viewer/DB/Terminal/Browser)을 같은 패턴으로 등록한다. apiclient는 **브라우저 등록 코드를 미러링**한다.

**(A) 칩 데이터 소스** — 브라우저 셀렉터(`WorkspaceTabs.tsx:38-44`)를 복제:
```ts
const apiTabIds = useApiClient((s) => s.tabIds);
const apiItems  = useApiClient((s) => s.items);
const apiTabs = apiTabIds
  .map((id) => apiItems[id])
  .filter((t): t is NonNullable<typeof t> => !!t && t.projectId === projectId);
const openApiClient  = useApiClient((s) => s.openTab);
const closeApiClient = useApiClient((s) => s.closeTab);
```

**(B) 칩 렌더 루프** — `WorkspaceTabs.tsx:94-103`(browsers.map) 뒤에 추가. 아이콘 lucide `Send`(13px):
```tsx
{apiTabs.map((t) => (
  <TabChip key={t.id} active={active === t.id}
    icon={<Send size={13} />} label={t.title}
    onClick={() => setActiveTab(projectId, t.id)}
    onClose={() => closeApiClient(t.id)} />
))}
```

**(C) 콘텐츠 마운트** — `WorkspaceTabs.tsx:121-134`에 추가. **active일 때만 마운트**(monaco lazy, 비활성 탭 메모리 절감 — 브라우저처럼 "항상 마운트"할 이유인 네이티브 rect 추적 연속성이 없다):
```tsx
{apiTabs.map((t) => (
  <div key={t.id} className={active === t.id ? "h-full" : "hidden"}>
    {active === t.id && <ApiClientTab tabId={t.id} projectId={projectId} />}
  </div>
))}
```

**(D) NewTabControls 메뉴** — `WorkspaceTabs.tsx:140-207`. `onNewApiClient` prop 추가, "새 브라우저" MenuItem(`:194-201`) 뒤에 "새 API 클라이언트"(아이콘 `Send`) 한 항목. 호출부(`:104-107`)에 `onNewApiClient={() => openApiClient(projectId)}` 전달.

`PaneTree.tsx`/`PaneControls.tsx`는 수정하지 않는다(분할 패널 비대상 — §1.2).

### 8.4 스타일 토큰 매핑 (메서드 / 상태코드 색)

기존 토큰만 사용한다. **메서드 색**(lib `method-color.ts` = `change-kind.ts`의 `KIND_BADGE` 패턴):

| 메서드 | className |
|---|---|
| GET | `text-add` (초록, 안전 읽기) |
| POST | `text-warn` (노랑, 생성) |
| PUT / PATCH | `text-mod` (파랑, 수정) |
| DELETE | `text-danger` (빨강) |
| HEAD / OPTIONS | `text-fg-dim` (회색) |

**상태코드 색**(StatusBar 배지, 모양은 status 배지 토큰 `shrink-0 rounded px-1 text-[10px] leading-4`):

| 범위 | className |
|---|---|
| 2xx | `bg-ok/20 text-ok` |
| 3xx | `bg-mod/20 text-mod` |
| 4xx | `bg-warn/20 text-warn` |
| 5xx / 네트워크 오류 | `bg-danger/20 text-danger` |

응답 표/트리의 셀 값 색은 `renderCell()`(`DbWorkspace.tsx:138-158`)을 복사·확장(null=`text-fg-dim`, boolean=`text-add`, number=`text-mod`, object=`text-mod`).

### 8.5 핵심 컴포넌트 재사용 매핑

- **CollectionSidebar**: `DbSidebar.tsx` aside 골격(`:479-509`)·`MetaSection`(접기 그룹 `:59-93`)·`MetaRow`·`depth*16` 패딩. `ConnNode→DatabaseNode→CollNode`(`:399/295/259`)를 `FolderNode→RequestNode`로 치환. 요청 노드 클릭 → `selectRequest(id)`(`openCollection` 미러). 우측 hover 액션(`opacity-0 group-hover:opacity-100`) `Pencil`/`Trash2`.
- **RequestBuilder**: `DbWorkspace.tsx` `QueryEditor` 헤더 바(`:29-70` — `h-9 ... border-b border-edge px-3`). 메서드/env는 네이티브 `<select>`(DB limit select `:39-50` 스타일). URL `<input className="w-full rounded border border-edge bg-base px-2 py-1 outline-none focus:border-accent">`. Send 주요 버튼(`:62-69` 동형, 전송 중 disabled + "전송 중…").
- **ResponsePanel**: StatusBar는 DB 결과 푸터(`:394-400`) `bg-panel px-3 py-1 text-[11px]` 톤. Pretty 뷰는 monaco **read-only**(`:72-93` `<Editor>` 옵션: `readOnly:true, minimap:{enabled:false}, automaticLayout:true, fontSize:13`, `theme`는 settings로 `gitpervisor-dark|gitpervisor-monokai`). JSON 워커는 `monaco-setup.ts:16-17`에 이미 등록. Preview: `text/html`→`<iframe sandbox>`(브라우저 iframe 모드 차용), `image/*`→`<img>`.
- **KeyValueEditor**(신규 공통, 4곳 재사용): `InsertRowDialog`의 label+input(`:465-491`) + DbConnection Field 패턴. 각 행 `☑ enabled`(`accent-accent`) · key · value · `✕`(`Trash2` size 12, hover `text-danger`). 마지막에 항상 빈 "추가 행"(입력 시 새 행 append). `readOnly` 모드(응답 Headers/Cookies 표시용 — 입력 대신 텍스트, 토글/삭제 숨김).
- **BodyEditor**: 모드 세그먼트 `[none][json][form][raw]`. json은 MonacoBox(편집 가능, `Ctrl+Shift+F` format). form은 KeyValueEditor. raw는 `<textarea>` + content-type 입력. none은 `EmptyState`.
- **EnvDialog**: 모달 토큰 `fixed inset-0 z-50 flex items-center justify-center bg-black/50` + `w-[460px] rounded-lg border border-edge bg-panel p-5 shadow-xl`(`InsertRowDialog`/`ConfirmDialog` 패턴). 좌 환경목록(추가/삭제/이름변경) + 우 변수 KeyValueEditor.

**monaco lazy 로드 준수**: `ApiClientTab`은 기존 코드가 **named export**라(`DbWorkspace`는 `lazy(() => import("../db/DbWorkspace").then((m) => ({ default: m.DbWorkspace })))`, `WorkspaceTabs.tsx:24-25` 확인됨) **`ApiClientTab`도 named export로 두고 동일하게** `lazy(() => import("../apiclient/ApiClientTab").then((m) => ({ default: m.ApiClientTab })))`로 가져온다. `lazy(() => import(...))`(default 가정)로 쓰면 named export라 런타임에 깨진다. monaco(약 2~3MB)는 **탭을 처음 열 때만** 끌려와 초기 화면 부담이 없다(DB 탭과 동일 전략).

### 8.6 단축키 (탭 내부 스코프)

`ApiClientTab` 루트의 `onKeyDown`(또는 monaco `editor.addCommand` — `DbWorkspace.tsx:86-91` 패턴). 탭 활성 시에만 동작(전역 충돌 회피):

| 키 | 동작 |
|---|---|
| `Ctrl+Enter` | Send (DB 실행과 동일 관례) |
| `Ctrl+S` | 현재 요청을 컬렉션에 저장 (`preventDefault`) |
| `Ctrl+L` | URL 입력 포커스 (주소창 관례) |
| `Ctrl+Shift+F` | Body/Response JSON 포맷 (monaco format-document) |
| `Esc` | 열린 모달(EnvDialog) 닫기 |

---

## 9. 통합 · IPC layer

### 9.1 기존 탭 수명주기·프로젝트 전환과의 통합

**9.1.1 activeTab 슬롯 통합 (terminals.ts가 단일 진실)**: `activeTab[projectId]`는 이미 `"viewer" | "db" | tabId(UUID)`를 담는 배타 슬롯이다(`terminals.ts:112`, `WorkspaceTabs.tsx:32`). API 클라이언트 탭도 **같은 슬롯에 UUID로 들어가** 자동으로 배타성(Viewer/DB/Terminal/Browser/ApiClient 중 하나만 활성)을 얻는다. 브라우저 `openBrowser → setActiveTab(projectId, id)`(`browser.ts:159`)을 미러링한다.

**9.1.2 독립 탭만 — 분할 패널 미지원 (Standard 경계)**: `terminals.ts`의 `PaneKind`를 건드리지 않고 브라우저의 `tabIds` 모델만 차용(§1.2). 분할 지원은 Full 티어로 연기.

**9.1.3 프로젝트별 상태 격리**: 탭은 `projectId`로 태깅하고 `tabs.filter(t => t.projectId === projectId)`로 렌더(`WorkspaceTabs.tsx:40-42`). 탭은 항상 마운트하지 않고 **active일 때만 마운트**(`WorkspaceTabs.tsx:123` 터미널 패턴). 단, **in-flight 요청은 store(전역)에 두어** 탭을 떠나도 응답이 도착하면 store에 반영되게 한다.

**9.1.4 탭 닫기·프로젝트 제거 정리**: `closeTab`은 닫을 때 **해당 탭의 in-flight 요청을 취소**(`abort(reqId)` → `http_cancel`)하고, 활성 탭이었으면 `"viewer"`로 환원한다(`browser.ts:175`, `terminals.ts:229` 패턴).

### 9.2 IPC Layer — `src/lib/apiclient.ts` + `src/lib/ipc.ts`

브라우저 `src/lib/browser.ts`의 철학을 따른다: **"백엔드가 단일 진실, 프론트는 invoke 래퍼 + 응답을 store에 반영"**. 단 점유/bounds 관련 single-flight·hung-invoke 장치는 제거하고, 대신 **요청 취소(abort)**를 더한다.

```typescript
// src/lib/apiclient.ts (IPC 래퍼)
export async function sendRequest(reqId: string, prepared: PreparedRequest): Promise<ApiResponse>;
  // invoke("http_request", { requestId: reqId, req: prepared })
  // prepared.body는 PreparedBody 태그드 유니온(§5.1) — camelCase 그대로 실으면
  // 백엔드 BodyKind로 역직렬화된다. multipart 파일 파트(filePath)·binary(base64/filePath)도
  // 이 경로로만 전달 가능(string|null이었으면 §4.A.2 멀티파트가 단절됨).
export function abortRequest(reqId: string): void;
  // invoke("http_cancel", { requestId: reqId })
```

- `ipc.ts`의 `httpRequest`는 `callMutating<ApiResponse>("http_request", { requestId, req: prepared }, 120_000)`로 호출한다. **재시도 금지**(변경/비멱등 네트워크 호출). 타입(`PreparedRequest`/`ApiResponse`)은 `lib/apiclient.ts`에서 재노출.
- **단일 진실은 백엔드의 reqwest 핸들**. 프론트는 `reqId`만 알면 취소 가능(브라우저가 "아는 id로 close 가능" 한 것과 동형 — invoke 응답 유실돼도 고아 방지).
- **이벤트 없음(Standard 최소화)**: 요청 단위가 짧아 이벤트 스트리밍이 불필요하므로 1차는 `invoke` 응답만 쓴다. 진행률·대용량 스트리밍이 필요해지면 `terminal.rs`의 `Channel<T>` 패턴(`term_open`의 `on_data`)을 그대로 도입할 자리를 남긴다.

### 9.3 데이터 흐름 요약

```
┌─ ApiClientTab (React) ─ 요청 폼 편집 ─────────────────────────────┐
│  patchDraft(id, patch) → store.draftById[id] 갱신(비영속, 단일 진실) │
│  saveDraft(id, collId)  → draftById[id] → nodes 커밋(영속, write 1회) │
└─ send(id) ───────────────────────────────────────────────────────┘
        ↓ resolveRequest(req, mergeVars(global+collection))
   ┌─ §6 치환(1패스, 미정의 보존) → §7 applyAuth ─┐
   │  prepared(평문) + displayUrl(마스킹) + unresolved │
   └────────────────────────────────────────────────┘
        ↓ ipc.httpRequest(reqId, prepared)   ← 백엔드 http_request
   ┌─ 응답 ─ responses[id]=ApiResponse(전이) ─ pushHistory(display+meta) ─┐
   └────────────────────────────────────────────────────────────────────┘
        ↓ subscribe → localStorage("gp:apiclient")  (items/nodes/env/history만)
```

---

## 10. 보안 · 격리

### 10.1 위협 모델 — "사용자가 의도적으로 임의 요청을 쏘는 로컬 개발 도구"

이 도구의 본질은 Postman/curl과 같다: **사용자 본인이 임의 URL·헤더·바디로 요청을 보내는 것**이 정상 기능이다. 따라서 "임의 요청 차단"은 위협이 아니다. 진짜 위협은 ① 저장된 **시크릿(토큰) 누수**, ② **리다이렉트를 통한 Authorization 헤더의 의도치 않은 제3자 전송**, ③ **TLS 검증 비활성화의 사고성 상시화**, ④ 프로젝트 간 환경/토큰 **교차 오염**이다. 브라우저 기능의 핵심 위협(적대 원격 JS의 특권 invoke)은 **여기엔 없다** — Standard는 스크립트 엔진이 없어 인젝션 표면이 0이다(§10.5).

### 10.2 시크릿 디스크 저장 절충 (Standard) / OS 키체인 격상 (Full)

- **Standard**: `EnvVar.secret:true`의 value는 localStorage `gp:apiclient`에 평문 저장된다(§5.2). 단 §6.4로 **히스토리에는 마스킹**되어 평문이 안 남는다. 이 절충을 명시 문서화한다.
- **Full 확장점**: `db.rs:176-198`의 keyring 패턴(`keyring::Entry::new("gitpervisor-apiclient", secretId)`, Windows Credential Manager)으로 격상. localStorage에는 `{ kind:"secret", ref: secretId }` 참조만 남기고, 시크릿 *읽기*는 프론트로 반환하지 않고 **`http_request` 내부에서만 keyring을 읽어 헤더에 주입** → 시크릿이 JS heap·CDP·DOM·history에 노출되는 표면을 없앤다.

### 10.3 리다이렉트 / Authorization 헤더 누수 방지 ⭐

브라우저 `navigation_gate`(`browser.rs:96`)에 대응하는 **API 클라이언트판 게이트**(§4.B.2 custom redirect policy에서 구현):
- **기본 정책**: 리다이렉트가 다른 origin(scheme+host+port 변경)으로 넘어가면 `Authorization`·`Cookie`·`Proxy-Authorization` 헤더를 **자동 제거**(curl `--location` 표준 안전 동작). reqwest 기본 redirect 정책은 이를 보장하지 않을 수 있으므로 **커스텀 `redirect::Policy`로 cross-origin 시 민감 헤더 strip**을 명시 구현한다.
- **scheme 다운그레이드 차단**: https→http 리다이렉트는 기본 거부. 사용자가 옵션으로 허용 가능하되 기본 off.
- `HttpResponse.redirects`를 프론트로 반환해 **응답 패널에 리다이렉트 경로를 표시**(토큰이 어디로 갔는지 검증 가능).

### 10.4 TLS 검증 기본 ON

`verifyTls`는 기본 true. off는 **요청 단위 옵션**이며, off인 요청은 응답 패널에 **경고 배지("TLS 검증 꺼짐")**를 띄운다. 전역 off는 제공하지 않는다(사고성 상시화 방지).

### 10.5 스크립트 인젝션 표면 0 / scheme allowlist

- **Standard에는 pre-request/test 스크립트 실행 엔진이 없다.** 임의 JS 실행 = 인젝션 표면이 **존재하지 않는다**. env 치환은 순수 문자열 치환(`{{var}}` → value)이며 코드 실행이 아니다(§6.2). Full 티어가 스크립트 엔진을 추가할 때 비로소 샌드박싱이 위협 모델에 들어온다.
- **URL 검증**: `http_request`는 `http`/`https` scheme만 허용(`browser.rs:97` `navigation_gate` 미러). `file:`/`tauri:`/`data:` 등은 `ErrorCode::InvalidUrl`로 거부.

### 10.6 다층 방어 요약

| 방어선 | 위협 | 구현 근거 |
|---|---|---|
| cross-origin 헤더 strip | 리다이렉트 토큰 누수 | reqwest custom redirect policy(§10.3) |
| scheme allowlist (http/https) | 로컬파일·특권 스킴 | browser.rs:96 미러(§10.5) |
| TLS 기본 on + 요청단위 off | MITM | reqwest rustls(§10.4) |
| 히스토리 시크릿 마스킹 | localStorage 평문 잔존 | §6.4 |
| 스크립트 엔진 부재 | 코드 인젝션 | §10.5 (Standard 경계) |
| (Full) keyring 격리 | 토큰 디스크·heap 노출 | db.rs:176-198 재사용(§10.2) |

---

## 11. 단계별 구현 태스크

### 11.1 Phase 표 (산출물 / 수용 기준)

의존성: A→B(보안은 백엔드 위에), A→C(프론트는 커맨드 계약 필요), C→D, (B,D)→E. A와 (C의 store/탭 골격)은 계약 시그니처(§4.9, §5.1) 고정 후 부분 병렬 가능.

| Phase | 목표 | 주요 산출물 | 수용 기준(AC) |
|---|---|---|---|
| **A. 백엔드 IPC 골격** | `http_request`/취소 커맨드 | `Cargo.toml` reqwest 추가; `commands/http.rs`(신규 — http_request, http_cancel, 모델); `error.rs`에 Network/DnsFailure/ConnectionRefused/TlsError/Cancelled/InvalidUrl 추가; `state.rs` HttpReg 필드; `lib.rs` invoke_handler 등록; `commands/mod.rs` re-export | `cargo build`·clippy 통과(rustls+native-tls 공존). `httpbin.org/get` status 200·헤더·timing·remoteAddr 채워짐. http/https만 허용, file:// 거부 |
| **B. 보안 코어** | 리다이렉트 strip·TLS·취소 | custom redirect policy(cross-origin 헤더 strip + https→http 거부), verifyTls 요청옵션, abortable+inflight RAII 등록, classify_err 매핑 | `httpbin.org/redirect/3`→redirects 길이 3, `followRedirects=false`면 302 그대로. 자가서명 사이트 verifyTls=false 성공·true `TlsError`. 진행 중 http_cancel→`Cancelled`. cross-origin 리다이렉트 후 도착 서버에 Authorization 없음 |
| **C. 프론트 통합** | store·IPC 래퍼·탭 등록 | `src/stores/apiclient.ts`(useApiClient, gp:apiclient 영속, loadPersisted 마이그레이션); `src/lib/apiclient.ts`(substitute/mergeVars/resolveRequest/applyAuth + sendRequest/abortRequest); `src/lib/ipc.ts` httpRequest 추가; `WorkspaceTabs.tsx` 탭칩+NewTabControls 메뉴+조건부 마운트 | 메뉴→탭 생성→activeTab 전환, 프로젝트 전환 시 탭 격리, 탭 닫기 시 in-flight abort. 다른 탭(Viewer/DB/Terminal/Browser) 무회귀 |
| **D. UI 패널** | 빌더·응답·env·치환 UI | `ApiClientTab`·`CollectionSidebar`·`RequestBuilder`·`RequestTabs`·`ResponsePanel`·`KeyValueEditor`·`BodyEditor`·`MonacoBox`·`EnvDialog`·`method-color.ts` | 실 요청 송수신 UI 동작, `{{var}}` 치환 표시, 미정의 변수 토스트, TLS off 경고 배지, 응답 Pretty(monaco)/Raw/Headers/Cookies |
| **E. CDP 검증·롤아웃** | §11.3 시나리오 자동화 | CDP 검증 스크립트, 리스크 레지스터 마감 | §11.3 시나리오 전부 green. release 빌드에서 9222 미노출 확인. out-of-scope(§2) 명문화 |

### 11.2 변경/신규 파일 목록 (바로 구현 착수용)

**백엔드 (Rust)**

| 파일 | 변경 | 내용 |
|---|---|---|
| `src-tauri/Cargo.toml` | 수정 | `reqwest 0.13`(**tauri가 이미 0.13.4 사용 — 버전 통일로 트리 1벌**; default-features=false, rustls-tls/http2/charset/gzip/brotli/deflate/zstd/json/multipart/stream/cookies) + `serde_urlencoded 0.7`(신규) + `base64 0.22`(**이미 트리 존재 — 버전 통일**) 추가. tokio/serde/serde_json/futures/uuid 재사용. native-tls(tiberius)와 공존 |
| `src-tauri/src/commands/http.rs` | **신규** | HttpRequest/HttpResponse/BodyKind/MultipartPart/HttpTiming/RedirectHop/SetCookie/HttpReg 모델. `async fn http_request`(client 빌드/abortable RAII 등록/사전 프로빙 타이밍/bytes_stream truncate/set-cookie 파싱/remote_addr) + `fn http_cancel`(멱등 abort) + classify_err |
| `src-tauri/src/commands/mod.rs` | 수정 | `mod http;` + `pub use http::*;`(diff와 sync 사이, line 1~13 / 15~27 블록) |
| `src-tauri/src/state.rs` | 수정 | use에 `HttpReg` 추가(line 7). AppState에 `pub http: Mutex<HttpReg>`(line 35 browser 옆). `AppState::new`에 `http: Mutex::new(HttpReg::default())`(line 48) |
| `src-tauri/src/error.rs` | 수정 | ErrorCode enum(line 5~15)에 Network/DnsFailure/ConnectionRefused/TlsError/Cancelled/InvalidUrl 추가. Timeout·Io 재사용. SCREAMING_SNAKE_CASE 유지 |
| `src-tauri/src/lib.rs` | 수정 | invoke_handler!(line 77~137)에 `commands::http_request`, `commands::http_cancel` 추가(browser_* 그룹 다음, monitor 앞). on_window_event Destroyed에 http abort_all은 선택(요청 종료 시 자동 정리) |

**프론트 (TypeScript / React)**

| 파일 | 변경 | 내용 |
|---|---|---|
| `src/stores/apiclient.ts` | **신규** | useApiClient zustand. browser.ts 골격(items/tabIds + loadPersisted gp:apiclient + subscribe 화이트리스트). 트리·환경·전송 액션. send는 db.runQuery 패턴(sending 토글 + resolveRequest + ipc.httpRequest) |
| `src/lib/apiclient.ts` | **신규** | 순수 엔진(substitute 1패스/mergeVars/resolveRequest/applyAuth bearer·basic-base64·apikey/maskSecrets) + IPC 래퍼(sendRequest/abortRequest). 컴포넌트와 분리해 단위 테스트 가능 |
| `src/lib/ipc.ts` | 수정 | ipc 객체에 `httpRequest(reqId, prepared)` = callMutating<ApiResponse>("http_request", ...). 재시도 금지. 타입 재노출 |
| `src/components/apiclient/ApiClientTab.tsx` | **신규** | 3컬럼 루트 + usePanelWidth ×2 + 탭 스코프 단축키. DbWorkspace 구조 미러. lazy 임포트 대상 |
| `src/components/apiclient/CollectionSidebar.tsx` | **신규** | DbSidebar aside + MetaSection/MetaRow + depth*16. FolderNode→RequestNode 트리(메서드 색 점, selectRequest, hover Pencil/Trash2) + 하단 HISTORY. ResizeHandle |
| `src/components/apiclient/RequestBuilder.tsx` | **신규** | h-9 헤더(QueryEditor 미러). method `<select>`(§8.4) + URL input + env `<select>` + Send 주요버튼(Ctrl+↵) |
| `src/components/apiclient/RequestTabs.tsx` | **신규** | SubTabs(Params/Headers/Body/Auth, 카운트 배지) + 본문(KeyValueEditor/BodyEditor/Auth 폼) |
| `src/components/apiclient/ResponsePanel.tsx` | **신규** | StatusBar(상태코드 색/ms/KB) + SubTabs(Body/Headers/Cookies) + Body 뷰토글[Pretty MonacoBox RO/Raw/Preview]. running→Center, error→Center danger |
| `src/components/apiclient/KeyValueEditor.tsx` | **신규 공통** | 헤더/쿼리/form-data/env 4곳 공용. ☑·key·value·✕ + 자동 추가 행. readOnly 모드. InsertRowDialog label+input |
| `src/components/apiclient/BodyEditor.tsx` | **신규** | 모드 세그먼트[none/json/form/raw]. json/응답Pretty 공용 MonacoBox. form→KeyValueEditor. raw→textarea. none→EmptyState |
| `src/components/apiclient/MonacoBox.tsx` | **신규** | @monaco-editor/react `<Editor>` 얇은 래퍼(language/value/readOnly/theme). DbWorkspace:72-93 옵션 재사용 |
| `src/components/apiclient/EnvDialog.tsx` | **신규** | 환경 관리 모달(fixed inset-0 bg-black/50 + w-[460px] bg-panel). 좌 환경목록 + 우 변수 KeyValueEditor. setEnvironment 저장 |
| `src/lib/method-color.ts` | **신규** | methodColor(method)→className, statusColor(code)→className. change-kind.ts KIND_BADGE 패턴(§8.4) |
| `src/components/workspace/WorkspaceTabs.tsx` | 수정 | import(Send + useApiClient + lazy ApiClientTab); apiTabs 셀렉터(:38-44 뒤); 칩 루프(:103 뒤); 콘텐츠 마운트 active만(:134 뒤); NewTabControls onNewApiClient prop + MenuItem '새 API 클라이언트' + 호출부 전달 |

### 11.3 CDP(9222) 검증 시나리오

API 클라이언트는 전부 메인 React webview라 `evaluate_script`로 완전 자동화된다(브라우저 §11 한계 없음). 9222는 debug 빌드에서만 열린다(`lib.rs:44-45` 확인됨).

**로컬 에코 서버 픽스처(E2E 재현성)**: 시나리오 1~4는 외부 의존(httpbin.org) 없이 재현 가능해야 하므로, 테스트용 **로컬 에코 서버**를 `scripts/` 아래 Node 단일 파일(의존 0 — Node 내장 `http`)로 둔다. 제공 엔드포인트: `GET/POST /echo`(요청 method·헤더·바디를 JSON으로 되돌려줌), `GET /redirect/:n`(n회 같은-origin 302 체인), **cross-origin 302**(다른 포트로 Location), `GET /slow?ms=5000`(취소 테스트용 지연), 자가서명 TLS 리스너(verifyTls 테스트). 시나리오 3의 cross-origin은 **두 포트**(예 :8731 출발 → :8732 도착)를 띄워 검증한다. CI/로컬에서 이 서버를 먼저 기동한 뒤 CDP 시나리오를 돌린다.

1. **실 요청 송수신(E2E)**: CDP attach → `useApiClient.getState().openTab(projectId)` → URL=로컬/공개 에코, POST, 헤더 `X-Test:1`, JSON 바디 → Send → `responses[id]` 폴링 → status 200·에코 헤더/바디 일치 단언.
2. **env 치환**: env에 `BASE_URL=http://127.0.0.1:<port>`, URL=`{{BASE_URL}}/echo` → Send → 서버가 치환된 실제 URL 수신 단언 + 미정의 토큰 토스트 검증.
3. **리다이렉트 헤더 strip**: 로컬 서버가 cross-origin 302 → `Authorization` 포함 요청 → 도착 서버에 `Authorization` 없음 + `redirects` 검증.
4. **취소**: 5초 지연 응답 → Send 직후 abort → Promise reject·UI "취소됨"·inflight 비워짐 단언.
5. **격리 회귀 가드**: TLS off 요청에 경고 배지, scheme allowlist가 `file://` 거부, 시크릿이 `localStorage.getItem("gp:apiclient")` 직렬화 문자열에 마스킹 정책대로 처리됨 단언.

---

## 12. 리스크 레지스터

| ID | 리스크 | 심각도 | 완화 | Phase |
|---|---|---|---|---|
| R1 | reqwest 기본 redirect가 cross-origin 헤더를 strip 안 함 → 토큰 누수 | High | custom `redirect::Policy` 명시 구현 + §11.3 ③ 회귀 테스트 | B |
| R2 | 시크릿이 localStorage/CDP/history에 평문 잔존 | High(Standard 절충) | 히스토리 마스킹(§6.4) + Full에서 keyring(§10.2) + §11.3 ⑤ 회귀 단언 | B/E |
| R3 | reqwest 빌드 시간·바이너리 증가 | **Low** | **핵심 스택(reqwest 0.13/hyper/h2/rustls)은 tauri 경유로 이미 빌드됨**(Cargo.lock:3607, base64 0.22.1도 트리 존재). 직접 의존을 0.13으로 핀해 트리 1벌 유지(0.12 추가 시 2벌 컴파일 — §4.6). 증분은 추가 feature(multipart/gzip/zstd/cookies)+`serde_urlencoded` 한정 | A |
| R4 | 취소 토큰 누수(좀비 in-flight) | Med | RAII drop으로 inflight map 정리(OpGuard 철학), 탭 닫기 시 일괄 abort(§9.1.4) | A/C |
| R5 | 타이밍 dns/connect/tls가 근사라 워터폴 오해 | Med | `timingExact:false` 플래그 + UI 근사 표기. 정밀은 Full Connector | A/D |
| R6 | TLS off가 사고로 상시화 | Low | 전역 off 미제공, 요청단위만+경고 배지(§10.4) | D |
| R7 | rustls가 사내 사설 CA 미신뢰 → 정상 요청 실패 | Low | verifyTls off로 우회(문서화). Full에서 커스텀 CA 또는 native-tls 교체(§4.6) | D |
| R8 | 25MB 초과 응답 base64가 IPC 페이로드 부풀려 invoke 유실 | Med | maxBodyBytes truncate(§4.7), 큰 응답은 Full 파일저장 커맨드로 분리 | A |
| R9 | 동시 다중 탭에서 requestId 충돌 → 취소 오작동 | Low | 프론트 생성 UUID(terminals/browser 동일 전제) | A/C |
| R10 | env 1패스 치환의 미정의 변수가 조용히 전송됨 | Low | unresolved 수집 + 전송 전 토스트(§6.3), 막진 않음 | C/D |

---

## 13. 결정이 필요한 항목 (기본 권고 포함)

1. **reqwest TLS 백엔드** — *권고: rustls-tls*(verifyTls 결정론적 토글·플랫폼 독립). 사내 루트 CA를 Windows 인증서 저장소에만 설치한 환경에선 native-tls(tiberius가 이미 사용)가 유리 — verifyTls off 우회 또는 rustls 커스텀 루트 주입으로 보완. ⚠️ 참고: reqwest/hyper/rustls **핵심 스택은 tauri 경유로 이미 트리에 빌드돼 있다**(Cargo.lock:3607). 직접 의존은 0.13으로 핀해 트리 1벌을 유지(0.12 추가 시 2벌 컴파일)하면 되고, 빌드시간 증분은 feature 한정이라 R3는 Low(§4.6).
2. **타이밍 정밀도** — *권고: Standard는 사전 프로빙 근사(timingExact=false).* 프론트 워터폴 UI 요구 수준이 높으면 처음부터 커스텀 hyper Connector로 정확 단계 타이밍(구현 복잡도↑).
3. **시스템 프록시** — reqwest 기본은 HTTP_PROXY/HTTPS_PROXY 인식. 사내망에서 의도와 다를 수 있어 명시 토글(`useSystemProxy`) 노출 여부 결정.
4. **시크릿 영속** — *권고: Standard는 localStorage 평문 + 히스토리 마스킹 절충(문서화).* Full에서 Windows Credential Manager + 백엔드 주입으로 격상.
5. **복수 탭 vs 단일 탭** — *권고: browser식 복수 탭.* 탭 스트립 혼잡이 문제면 DB식 단일 탭으로 축소 가능.
6. **Params↔URL 동기화 방향** — 1차는 표→URL 단방향. URL 직접 편집 시 표 역파싱은 M2로 미룰지 결정.

---

## 부록 — 기존 코드에서 차용한 패턴 매핑

| API 클라이언트 요소 | 차용 출처 | 비고 |
|---|---|---|
| 독립 탭 store(items/tabIds) | `src/stores/browser.ts:55-80` | browser.openBrowser/closeBrowser 1:1 |
| localStorage 영속(즉시 저장, 마이그레이션) | `browser.ts:97/247`, `terminals.ts:144/355` | gp:apiclient 키, JSON.parse 실패 시 empty |
| 히스토리 cap+slice | `browser.ts:53/86`(HISTORY_CAP 120) | cap만 100 |
| 백엔드 async 커맨드 + State 주입 | `commands/sync.rs`, `commands/browser.rs` | "네트워크 I/O ⇒ async" |
| 취소 레지스트리(Mutex<HashMap>) | `BrowserReg`(browser.rs:40-43), `TerminalSession`(terminal.rs:16-29) | abortable + AbortHandle |
| RAII 정리(패닉 안전) | `OpGuard`(state.rs:69-78) | inflight remove |
| 에러 분류 | `classify_failure`(sync.rs:107) | reqwest 에러 → ErrorCode |
| scheme 게이트 | `navigation_gate`(browser.rs:96-97) | http/https만 |
| keyring 시크릿(Full) | `db.rs:176-198` | Windows Credential Manager |
| 사이드바 트리 | `DbSidebar.tsx`(ConnNode/MetaSection/depth*16) | FolderNode/RequestNode 치환 |
| 응답 그리드·셀 색 | `DbWorkspace.tsx`(measureColWidth/renderCell) | ResponseGrid 재사용 |
| 패널 폭 영속 | `use-panel-width.ts` | gp:apiclient-*-width |
| monaco lazy + 옵션 | `WorkspaceTabs.tsx:24-26`, `DbWorkspace.tsx:72-93`, `monaco-setup.ts` | Pretty/JSON 바디 공유 |
| 메서드/상태 색 배지 | `change-kind.ts` KIND_BADGE, `styles.css` 토큰 | method-color.ts 신규 |
| Key-Value 편집 | `InsertRowDialog`(DbWorkspace.tsx:465-491), DbConnection Field | KeyValueEditor 신규 |
| 모달 | `ConfirmDialog`/`SettingsDialog`(fixed inset-0 bg-black/50) | EnvDialog |
