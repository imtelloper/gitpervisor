// API 클라이언트 순수 엔진 + IPC 래퍼 (§6 치환 / §7 인증 / §9.2 IPC).
// 컴포넌트 밖 모듈에 두어 단위 테스트가 용이하게 한다. 치환은 전송 직전 1회.
//
// ⚠️ store와의 순환참조 회피: 여기서는 **타입만** import한다(type-only).
// stores/apiclient.ts가 이 모듈의 값(resolveRequest/mergeVars)을 import하므로,
// 역방향으로 값을 끌어오면 순환이 된다. 타입은 런타임 의존이 없어 안전하다.

import { ipc } from "./ipc";
import type { PreparedRequest, PreparedBody, HttpResponse } from "./ipc";
import type {
  ApiClientState,
  ApiNode,
  ApiRequest,
  AuthConfig,
  KvRow,
  FormRow,
} from "../stores/apiclient";

export type { PreparedRequest, PreparedBody, HttpResponse } from "./ipc";

// ============================================================================
// §6.2 치환 — 단일 1패스(비재귀) + 미정의 보존
// ============================================================================

/** 1패스 치환(재귀 금지). 미정의 토큰은 원문({{name}}) 그대로 보존, missing에 수집. */
export function substitute(
  template: string,
  vars: Record<string, string>,
): { out: string; missing: string[] } {
  const missing: string[] = [];
  const out = template.replace(/{{\s*([\w.-]+)\s*}}/g, (m, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
    missing.push(name);
    return m; // 미정의는 원문 보존
  });
  return { out, missing };
}

// ============================================================================
// §6.5 env 스코프 병합 — Global → Collection(높은 우선순위)
// ============================================================================

/** 활성 env vars 병합(Collection이 Global을 덮음). secret 값들의 실제 문자열도 반환(마스킹용). */
export function mergeVars(
  state: Pick<
    ApiClientState,
    "environments" | "activeEnvId" | "activeEnvByCollection" | "nodes"
  >,
  requestNodeId: string | null,
): { vars: Record<string, string>; secretValues: string[] } {
  const vars: Record<string, string> = {};
  const secretValues: string[] = [];

  const apply = (envId: string | null | undefined) => {
    if (!envId) return;
    const env = state.environments[envId];
    if (!env) return;
    for (const v of env.vars) {
      if (!v.key) continue;
      vars[v.key] = v.value;
      if (v.secret && v.value) secretValues.push(v.value);
    }
  };

  // 1) Global(낮은 우선순위)
  apply(state.activeEnvId);
  // 2) Collection(높은 우선순위) — 요청이 속한 최상위 폴더(컬렉션)의 활성 env
  const collId = topCollectionOf(state.nodes, requestNodeId);
  if (collId) apply(state.activeEnvByCollection[collId]);

  return { vars, secretValues };
}

/** 노드를 루트까지 거슬러 최상위 폴더(컬렉션) id 반환. */
function topCollectionOf(
  nodes: Record<string, ApiNode>,
  nodeId: string | null,
): string | null {
  let cur = nodeId;
  let top: string | null = null;
  while (cur) {
    const n: ApiNode | undefined = nodes[cur];
    if (!n) break;
    top = n.id;
    cur = n.parentId;
  }
  return top;
}

// ============================================================================
// §6.4 시크릿 마스킹
// ============================================================================

/** 문자열 내 secret 평문을 ••••로 치환(부분 문자열). 빈/1자 시크릿은 생략(오탐 방지). */
export function maskSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const sv of secretValues) {
    if (!sv || sv.length < 2) continue;
    out = out.split(sv).join("••••");
  }
  return out;
}

// ============================================================================
// §7 인증 주입 — applyAuth (치환 이후 호출)
// ============================================================================

interface MutableHeader {
  name: string;
  value: string;
}
interface MutableQuery {
  key: string;
  value: string;
}

/** UTF-8 안전 base64(btoa는 latin1만 — encodeURIComponent로 우회). */
function utf8Base64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

/** case-insensitive 헤더명 존재 여부. */
function hasHeader(headers: MutableHeader[], name: string): boolean {
  const lower = name.toLowerCase();
  return headers.some((h) => h.name.toLowerCase() === lower);
}

/**
 * §7 인증 주입. 치환된 값을 받아 헤더/쿼리에 합성한다.
 * - 사용자가 동일 헤더명을 명시했으면 주입 스킵(사용자 명시값 우선).
 * - inherit는 호출 전에 inheritedAuth로 해석돼 전달된다.
 */
export function applyAuth(
  auth: AuthConfig,
  inheritedAuth: AuthConfig,
  vars: Record<string, string>,
  headers: MutableHeader[],
  query: MutableQuery[],
): void {
  const resolved: AuthConfig = auth.kind === "inherit" ? inheritedAuth : auth;
  const sub = (t: string) => substitute(t, vars).out;

  switch (resolved.kind) {
    case "none":
    case "inherit":
      return;
    case "bearer": {
      if (hasHeader(headers, "Authorization")) return;
      headers.push({ name: "Authorization", value: `Bearer ${sub(resolved.token)}` });
      return;
    }
    case "basic": {
      if (hasHeader(headers, "Authorization")) return;
      const user = sub(resolved.username);
      const pass = sub(resolved.password);
      headers.push({
        name: "Authorization",
        value: `Basic ${utf8Base64(`${user}:${pass}`)}`,
      });
      return;
    }
    case "apikey": {
      const key = sub(resolved.key);
      const value = sub(resolved.value);
      if (resolved.in === "header") {
        if (hasHeader(headers, key)) return; // 사용자 명시 우선
        headers.push({ name: key, value });
      } else {
        query.push({ key, value });
      }
      return;
    }
  }
}

// ============================================================================
// §6/§7 resolveRequest — 치환 → auth 주입 → 쿼리 병합 → 평문/마스킹 산출
// ============================================================================

export interface ResolveResult {
  prepared: PreparedRequest; // 평문 — 전송에만 사용
  displayUrl: string; // 마스킹 — 히스토리/표시
  unresolved: string[]; // vars에 없던 토큰명(§6.3)
}

/** 활성화된 행만 추출(disabled 제거). */
function enabledRows(rows: KvRow[]): KvRow[] {
  return rows.filter((r) => r.enabled && (r.key !== "" || r.value !== ""));
}

/** 바디 변환(ApiRequest.body → PreparedBody). value/text는 치환 적용. */
function resolveBody(
  body: ApiRequest["body"],
  vars: Record<string, string>,
  missing: string[],
): { body: PreparedBody; contentType: string | null } {
  const sub = (t: string) => {
    const r = substitute(t, vars);
    missing.push(...r.missing);
    return r.out;
  };

  switch (body.mode) {
    case "none":
      return { body: { kind: "none" }, contentType: null };
    case "json":
      return { body: { kind: "json", text: sub(body.text) }, contentType: "application/json" };
    case "raw":
      return {
        body: { kind: "raw", text: sub(body.text) },
        contentType: body.rawType ? sub(body.rawType) : null,
      };
    case "form": {
      if (body.formType === "multipart") {
        const parts = enabledRowsForm(body.form).map((row: FormRow) =>
          row.partKind === "file"
            ? {
                field: sub(row.key),
                filePath: row.filePath,
                fileName: row.fileName,
                contentType: row.contentType,
              }
            : { field: sub(row.key), value: sub(row.value) },
        );
        return { body: { kind: "formData", parts }, contentType: null };
      }
      const fields = enabledRowsForm(body.form).map((row) => ({
        key: sub(row.key),
        value: sub(row.value),
      }));
      return {
        body: { kind: "formUrlencoded", fields },
        contentType: "application/x-www-form-urlencoded",
      };
    }
    case "binary":
      return {
        body: {
          kind: "binary",
          base64: body.binaryBase64,
          filePath: body.binaryPath,
          contentType: body.binaryContentType ?? null,
        },
        contentType: body.binaryContentType ?? null,
      };
  }
}

function enabledRowsForm(rows: FormRow[]): FormRow[] {
  return rows.filter((r) => r.enabled && (r.key !== "" || r.value !== ""));
}

/**
 * §6/§7: 치환 + auth 주입 + 쿼리 병합 → 평문 PreparedRequest + 마스킹 displayUrl.
 * body 분기는 resolveBody가 백엔드 BodyKind와 동형의 PreparedBody로 산출한다.
 */
export function resolveRequest(
  req: ApiRequest,
  vars: Record<string, string>,
  secretValues: string[],
  inheritedAuth: AuthConfig,
): ResolveResult {
  const missing: string[] = [];
  const sub = (t: string) => {
    const r = substitute(t, vars);
    missing.push(...r.missing);
    return r.out;
  };

  // URL(인라인 쿼리 포함) 치환
  const url = sub(req.url);

  // 쿼리 파라미터 치환(key·value 양쪽, §6.1) — 활성 행만
  const query: MutableQuery[] = enabledRows(req.params).map((p) => ({
    key: sub(p.key),
    value: sub(p.value),
  }));

  // 헤더 치환(value만 — 헤더명은 고정 토큰, §6.1) — 활성 행만
  const headers: MutableHeader[] = enabledRows(req.headers).map((h) => ({
    name: h.key,
    value: sub(h.value),
  }));

  // 바디 치환/변환. body.contentType은 백엔드(§4.A.1)가 headers에 없을 때만 보충하므로
  // 프론트는 헤더 강제 주입하지 않는다(중복/충돌 방지). 단 raw/binary의 사용자 지정
  // Content-Type은 headers에 없을 때 보충해 의도를 보존한다.
  const { body, contentType } = resolveBody(req.body, vars, missing);
  if (
    contentType &&
    (req.body.mode === "raw" || req.body.mode === "binary") &&
    !hasHeader(headers, "Content-Type")
  ) {
    headers.push({ name: "Content-Type", value: contentType });
  }

  // 인증 주입(치환 이후, §7) — 헤더/쿼리에 합성
  applyAuth(req.auth, inheritedAuth, vars, headers, query);

  // 요청별 설정(§2 Standard) — undefined면 백엔드 기본값(TLS on/30s/추종, max 10).
  const st = req.settings ?? {};
  const prepared: PreparedRequest = {
    method: req.method,
    url,
    query,
    headers,
    body,
    timeoutMs: st.timeoutMs,
    followRedirects: st.followRedirects,
    maxRedirects: st.maxRedirects,
    verifyTls: st.verifyTls,
    maxBodyBytes: undefined,
  };

  // displayUrl — 쿼리 병합한 표시용 URL을 시크릿 마스킹(§6.4)
  const display = buildDisplayUrl(url, query);
  const displayUrl = maskSecrets(display, secretValues);

  // 미정의 토큰 중복 제거
  const unresolved = Array.from(new Set(missing));

  return { prepared, displayUrl, unresolved };
}

/** 표시용 URL — base URL에 query 행을 ?k=v&… 로 합쳐 시각화(전송 인코딩과 별개, 표시 전용). */
function buildDisplayUrl(url: string, query: MutableQuery[]): string {
  if (query.length === 0) return url;
  const qs = query
    .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`)
    .join("&");
  return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
}

// ============================================================================
// §9.2 IPC 래퍼 — sendRequest / abortRequest
// ============================================================================

/**
 * http_request 호출. prepared.body는 PreparedBody 태그드 유니온이라 camelCase 그대로
 * 백엔드 BodyKind로 역직렬화된다(multipart filePath·binary base64/filePath 포함).
 * 재시도 금지(ipc.httpRequest = callMutating).
 */
export async function sendRequest(
  reqId: string,
  prepared: PreparedRequest,
): Promise<HttpResponse> {
  return ipc.httpRequest(reqId, prepared);
}

/** http_cancel 호출(멱등 — 없으면 백엔드 no-op). */
export function abortRequest(reqId: string): void {
  void ipc.httpCancel(reqId);
}
