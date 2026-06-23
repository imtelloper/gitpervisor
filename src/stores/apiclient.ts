import { create } from "zustand";

import { ipc } from "../lib/ipc";
import { resolveRequest, mergeVars } from "../lib/apiclient";
import { useTerminals } from "./terminals";

// ============================================================================
// §5.1 TypeScript interface — API 클라이언트 데이터 모델
// 백엔드 commands/http.rs(§4.9)와의 정합은 PreparedRequest/PreparedBody(lib/ipc.ts)가
// 담당한다. store는 raw 템플릿({{var}} 미해석)만 보관한다(§3 데이터 흐름 원칙).
// ============================================================================

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/** BodyMode는 백엔드 BodyKind(§4.A.1)와 대응. "form"은 formType로 urlencoded↔multipart 분기. */
export type BodyMode = "none" | "json" | "form" | "raw" | "binary";

/** "form" 모드의 하위 구분 — 백엔드 FormUrlencoded vs FormData(multipart). */
export type FormType = "urlencoded" | "multipart";

/** 헤더/쿼리/env 변수 공용 행. enabled=체크박스(DB Key-Value 편집 UI 패턴). */
export interface KvRow {
  id: string; // crypto.randomUUID()
  enabled: boolean;
  key: string; // {{var}} 템플릿 허용
  value: string; // {{var}} 템플릿 허용
}

/** form 행 — KvRow 확장. multipart일 때만 파일 파트 필드를 채운다. 백엔드 MultipartPart와 1:1. */
export interface FormRow extends KvRow {
  partKind: "text" | "file"; // "text"=value 사용, "file"=filePath 사용
  filePath?: string;
  fileName?: string;
  contentType?: string;
}

/** 인증 프리셋(§7). 모든 입력값은 {{var}} 치환 대상. */
export type AuthConfig =
  | { kind: "none" }
  | { kind: "inherit" } // 상위 폴더(컬렉션)의 folderAuth 위임
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "apikey"; key: string; value: string; in: "header" | "query" };

/** 요청 바디(§5.1 ApiRequest.body). */
export interface ApiRequestBody {
  mode: BodyMode;
  rawType: string; // raw 모드의 Content-Type
  text: string; // json/raw 본문
  form: FormRow[]; // form 모드의 행
  formType: FormType; // "form" 모드를 urlencoded↔multipart로 분기(기본 "urlencoded")
  // binary 모드(§2 Standard) — 택1
  binaryPath?: string;
  binaryBase64?: string;
  binaryContentType?: string;
}

/** 요청별 전송 설정(§2 Standard). 모두 optional — undefined면 백엔드 기본값
 *  (TLS 검증 on / 30s 타임아웃 / 리다이렉트 추종, 최대 10). 구버전 저장 요청은 필드가
 *  없어도 그대로 동작한다(마이그레이션 불필요). */
export interface RequestSettings {
  timeoutMs?: number; // undefined=30000
  followRedirects?: boolean; // undefined=true
  maxRedirects?: number; // undefined=10
  verifyTls?: boolean; // undefined=true (false면 응답에 "검증 꺼짐" 배지)
}

/** 컬렉션 트리의 한 요청. */
export interface ApiRequest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string; // base URL, {{var}} 템플릿
  params: KvRow[]; // 쿼리 파라미터
  headers: KvRow[];
  body: ApiRequestBody;
  auth: AuthConfig;
  settings?: RequestSettings; // 요청별 TLS/타임아웃/리다이렉트 (undefined=기본값)
}

/** 트리 노드 — 폴더/요청 통합(browser.ts items 미러). */
export type ApiNode =
  | {
      kind: "folder";
      id: string;
      parentId: string | null; // null=루트(rootIds에 포함)
      name: string;
      childIds: string[]; // 자식 순서(폴더+요청 혼합)
      folderAuth: AuthConfig; // 컬렉션/폴더 스코프 인증 위임점(inherit 해석)
    }
  | {
      kind: "request";
      id: string;
      parentId: string | null;
      request: ApiRequest;
    };

/** 독립 API 클라이언트 탭 1개 (browser.BrowserItem 대응). */
export interface ApiClientItem {
  id: string; // 탭 id == activeTab 슬롯 키
  projectId: string;
  title: string; // 칩 라벨
  requestNodeId: string | null; // 빌더에 로드된 요청 노드. null=새 요청 초안
  view: "params" | "headers" | "body" | "auth" | "settings"; // 요청 하단 탭
  responseView: "body" | "headers" | "cookies"; // 응답 탭
  bodyFmt: "pretty" | "raw" | "preview";
}

// ---- §6. 환경(Environment) ----

export interface EnvVar {
  key: string;
  value: string; // {{var}} 미허용(리터럴) — 1패스 치환이므로 중첩 무의미
  secret: boolean; // true=히스토리 마스킹(§6.4)
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

export interface HistoryEntry {
  id: string;
  requestNodeId: string | null; // 역참조(삭제됐으면 null)
  method: HttpMethod;
  url: string; // 해석본이되 시크릿 마스킹된 display 문자열(§6.4)
  status: number; // 0=네트워크 실패
  statusText: string;
  durationMs: number;
  sizeBytes: number;
  contentType: string | null;
  at: string; // ISO 8601
}

// ---- 전이 상태(비영속) ----

/** 응답 — store.responses[id]에 임시 보관, 영속 안 함. 백엔드 HttpResponse(§4.B)와 1:1 정합. */
export interface ApiResponse {
  status: number;
  statusText: string;
  httpVersion: string; // "HTTP/1.1" | "HTTP/2.0"
  headers: KvRow[];
  cookies: KvRow[]; // SetCookie 파싱본(UI 쿠키 탭)
  bodyText: string; // 텍스트/JSON 디코드본
  bodyBase64: string; // 원본 bytes — 이미지/바이너리 preview용
  contentType: string | null;
  sizeBytes: number; // 수신 바이트
  truncated: boolean; // maxBodyBytes 초과로 잘림 → 경고 배지
  timing: ApiTiming; // 워터폴 단계분해
  redirects: ApiRedirectHop[]; // §10.3 리다이렉트 경로 표시
  remoteAddr: string | null; // 실제 접속 IP:port
  verifyTls: boolean; // 실제 사용된 verifyTls echo — false면 "검증 꺼짐" 배지(§10.4)
  durationMs: number; // = timing.totalMs 편의 미러(StatusBar용)
  error: string | null;
}

/** 백엔드 HttpTiming(§4.B.1) 프론트 미러. */
export interface ApiTiming {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  downloadMs: number;
  totalMs: number;
  timingExact: boolean;
}

/** 백엔드 RedirectHop(§4.B.2) 프론트 미러. */
export interface ApiRedirectHop {
  status: number;
  url: string;
  location: string | null;
}

// ============================================================================
// Zustand store
// ============================================================================

export interface ApiClientState {
  // ---- 영속 필드(localStorage 'gp:apiclient') ----
  items: Record<string, ApiClientItem>; // 독립 탭(browser.items 미러)
  tabIds: string[]; // 독립 탭 순서(browser.tabIds 미러)
  nodes: Record<string, ApiNode>; // 컬렉션 트리(폴더+요청 통합)
  rootIds: string[]; // 최상위 노드 순서
  environments: Record<string, ApiEnvironment>;
  activeEnvId: string | null; // Global 스코프 활성
  activeEnvByCollection: Record<string, string>; // collectionId → envId
  history: HistoryEntry[]; // 상한 100, 최근 우선
  expandedFolders: string[]; // 트리 펼침(영속)

  // ---- 전이 상태(비영속 — subscribe 화이트리스트 제외) ----
  activeRequestId: string | null;
  responses: Record<string, ApiResponse>;
  sending: Record<string, boolean>;
  draftById: Record<string, ApiRequest>; // 미저장 폼 편집본 — 단일 진실(비영속)
  envDialogOpen: boolean;

  // ---- 탭 생명주기 ----
  openTab: (projectId: string) => string;
  closeTab: (id: string) => void;
  // ---- 빌더 편집(비영속 draftById만) ----
  patchDraft: (id: string, patch: Partial<ApiRequest>) => void;
  setView: (id: string, view: ApiClientItem["view"]) => void;
  setResponseView: (id: string, v: ApiClientItem["responseView"]) => void;
  setBodyFmt: (id: string, f: ApiClientItem["bodyFmt"]) => void;
  // ---- 트리/저장 ----
  addFolder: (parentId: string | null, name: string) => string;
  addRequest: (parentId: string | null, init?: Partial<ApiRequest>) => string;
  updateRequest: (id: string, patch: Partial<ApiRequest>) => void;
  moveNode: (id: string, newParentId: string | null, index: number) => void;
  removeNode: (id: string) => void; // 폴더면 하위 재귀 삭제
  toggleFolder: (id: string) => void;
  selectRequest: (tabId: string, requestId: string) => void;
  saveDraft: (tabId: string, collectionId: string | null) => void;
  // ---- 환경 ----
  addEnvironment: (env: Omit<ApiEnvironment, "id">) => string;
  setEnvVar: (envId: string, index: number, patch: Partial<EnvVar>) => void;
  removeEnvironment: (envId: string) => void;
  setEnvironment: (envId: string | null, collectionId?: string) => void;
  openEnvDialog: () => void;
  closeEnvDialog: () => void;
  // ---- 전송 ----
  send: (tabId: string) => Promise<void>;
  abort: (tabId: string) => void;
  pushHistory: (e: HistoryEntry) => void;
  clearResponse: (id: string) => void;
}

// ============================================================================
// 영속 — gp:apiclient, 즉시 저장, loadPersisted 마이그레이션
// (browser.ts:97/247 골격 미러. JSON.parse 실패 시 empty 반환 — 손상 무시.)
// ============================================================================

const PERSIST_KEY = "gp:apiclient";
const HISTORY_CAP = 100; // browser.ts:53 패턴, 캡만 100

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
  // 구버전 마이그레이션 후보
  requests?: unknown[];
}

function loadPersisted(): Persisted {
  // tabIds·rootIds·expandedFolders는 배열, items·nodes·environments·
  // activeEnvByCollection은 Record. `as unknown as` 캐스팅 금지(타입 가드 무력화).
  const empty: Persisted = {
    items: {},
    tabIds: [],
    nodes: {},
    rootIds: [],
    environments: {},
    activeEnvId: null,
    activeEnvByCollection: {},
    history: [],
    expandedFolders: [],
  };
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<Persisted>;
    // 구버전(requests 배열) → nodes 맵 마이그레이션(browser.ts browsers[]→items 미러).
    if (Array.isArray(p.requests)) {
      const nodes: Record<string, ApiNode> = {};
      const rootIds: string[] = [];
      for (const r of p.requests) {
        const req = r as ApiRequest | undefined;
        if (!req || typeof req.id !== "string") continue;
        nodes[req.id] = { kind: "request", id: req.id, parentId: null, request: req };
        rootIds.push(req.id);
      }
      return {
        ...empty,
        nodes,
        rootIds,
        environments: p.environments ?? {},
        activeEnvId: p.activeEnvId ?? null,
        activeEnvByCollection: p.activeEnvByCollection ?? {},
        history: Array.isArray(p.history) ? p.history : [],
        expandedFolders: Array.isArray(p.expandedFolders) ? p.expandedFolders : [],
      };
    }
    return {
      items: p.items && typeof p.items === "object" ? p.items : {},
      tabIds: Array.isArray(p.tabIds) ? p.tabIds : [],
      nodes: p.nodes && typeof p.nodes === "object" ? p.nodes : {},
      rootIds: Array.isArray(p.rootIds) ? p.rootIds : [],
      environments:
        p.environments && typeof p.environments === "object" ? p.environments : {},
      activeEnvId: p.activeEnvId ?? null,
      activeEnvByCollection:
        p.activeEnvByCollection && typeof p.activeEnvByCollection === "object"
          ? p.activeEnvByCollection
          : {},
      history: Array.isArray(p.history) ? p.history : [],
      expandedFolders: Array.isArray(p.expandedFolders) ? p.expandedFolders : [],
    };
  } catch {
    return empty;
  }
}

// ---- 헬퍼 ----

function emptyBody(): ApiRequestBody {
  return {
    mode: "none",
    rawType: "text/plain",
    text: "",
    form: [],
    formType: "urlencoded",
  };
}

function newRequest(init?: Partial<ApiRequest>): ApiRequest {
  return {
    id: crypto.randomUUID(),
    name: "새 요청",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: emptyBody(),
    auth: { kind: "inherit" },
    ...init,
  };
}

function makeItem(id: string, projectId: string, title: string): ApiClientItem {
  return {
    id,
    projectId,
    title,
    requestNodeId: null,
    view: "params",
    responseView: "body",
    bodyFmt: "pretty",
  };
}

/** 컬렉션(최상위 폴더) id 해석 — 노드를 루트까지 거슬러 첫 부모(=최상위 폴더) id 반환. */
function collectionOf(
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

const persisted = loadPersisted();

export const useApiClient = create<ApiClientState>((set, get) => ({
  items: persisted.items,
  tabIds: persisted.tabIds,
  nodes: persisted.nodes,
  rootIds: persisted.rootIds,
  environments: persisted.environments,
  activeEnvId: persisted.activeEnvId,
  activeEnvByCollection: persisted.activeEnvByCollection,
  history: persisted.history,
  expandedFolders: persisted.expandedFolders,

  activeRequestId: null,
  responses: {},
  sending: {},
  draftById: {},
  envDialogOpen: false,

  // ---- 탭 생명주기(browser.openBrowser/closeBrowser 미러) ----
  openTab: (projectId) => {
    const id = crypto.randomUUID();
    const count =
      Object.values(get().items).filter((t) => t.projectId === projectId).length + 1;
    set((s) => ({
      items: { ...s.items, [id]: makeItem(id, projectId, `API ${count}`) },
      tabIds: [...s.tabIds, id],
      draftById: { ...s.draftById, [id]: newRequest() },
    }));
    useTerminals.getState().setActiveTab(projectId, id);
    return id;
  },

  closeTab: (id) => {
    const item = get().items[id];
    // 탭 닫기 시 해당 탭의 in-flight 요청 취소(§9.1.4).
    if (get().sending[id]) ipc.httpCancel(id);
    set((s) => {
      const items = { ...s.items };
      delete items[id];
      const sending = { ...s.sending };
      delete sending[id];
      const responses = { ...s.responses };
      delete responses[id];
      const draftById = { ...s.draftById };
      delete draftById[id];
      return {
        items,
        tabIds: s.tabIds.filter((t) => t !== id),
        sending,
        responses,
        draftById,
      };
    });
    if (item) {
      const ts = useTerminals.getState();
      if (ts.activeTab[item.projectId] === id) ts.setActiveTab(item.projectId, "viewer");
    }
  },

  // ---- 빌더 편집 ----
  // draftById(편집 버퍼)를 갱신하고, 이 탭이 컬렉션의 저장된 요청을 편집 중이면(requestNodeId)
  // 그 노드에도 즉시 반영한다 → 사이드바 메서드/이름 배지가 바로 따라온다(자동 저장 모델).
  // 매 키 입력마다 nodes가 바뀌므로 localStorage 폭주는 subscribe 디바운스(아래)가 흡수한다.
  patchDraft: (id, patch) =>
    set((s) => {
      const cur = s.draftById[id] ?? newRequest();
      const next = { ...cur, ...patch };
      const draftById = { ...s.draftById, [id]: next };
      const item = s.items[id];
      const nodeId = item?.requestNodeId;
      const node = nodeId ? s.nodes[nodeId] : undefined;
      if (item && nodeId && node && node.kind === "request") {
        return {
          draftById,
          nodes: { ...s.nodes, [nodeId]: { ...node, request: next } },
          items:
            next.name !== item.title
              ? { ...s.items, [id]: { ...item, title: next.name } }
              : s.items,
        };
      }
      return { draftById };
    }),

  setView: (id, view) =>
    set((s) =>
      s.items[id] ? { items: { ...s.items, [id]: { ...s.items[id], view } } } : s,
    ),
  setResponseView: (id, responseView) =>
    set((s) =>
      s.items[id]
        ? { items: { ...s.items, [id]: { ...s.items[id], responseView } } }
        : s,
    ),
  setBodyFmt: (id, bodyFmt) =>
    set((s) =>
      s.items[id] ? { items: { ...s.items, [id]: { ...s.items[id], bodyFmt } } } : s,
    ),

  // ---- 트리/저장 ----
  addFolder: (parentId, name) => {
    const id = crypto.randomUUID();
    set((s) => {
      const nodes: Record<string, ApiNode> = {
        ...s.nodes,
        [id]: {
          kind: "folder",
          id,
          parentId,
          name,
          childIds: [],
          folderAuth: { kind: "none" },
        },
      };
      if (parentId) {
        const parent = nodes[parentId];
        if (parent && parent.kind === "folder") {
          nodes[parentId] = { ...parent, childIds: [...parent.childIds, id] };
        }
        return { nodes };
      }
      return { nodes, rootIds: [...s.rootIds, id] };
    });
    return id;
  },

  addRequest: (parentId, init) => {
    const req = newRequest(init);
    const id = req.id;
    set((s) => {
      const nodes: Record<string, ApiNode> = {
        ...s.nodes,
        [id]: { kind: "request", id, parentId, request: req },
      };
      if (parentId) {
        const parent = nodes[parentId];
        if (parent && parent.kind === "folder") {
          nodes[parentId] = { ...parent, childIds: [...parent.childIds, id] };
        }
        return { nodes };
      }
      return { nodes, rootIds: [...s.rootIds, id] };
    });
    return id;
  },

  updateRequest: (id, patch) =>
    set((s) => {
      const node = s.nodes[id];
      if (!node || node.kind !== "request") return s;
      return {
        nodes: {
          ...s.nodes,
          [id]: { ...node, request: { ...node.request, ...patch } },
        },
      };
    }),

  moveNode: (id, newParentId, index) =>
    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;
      const nodes = { ...s.nodes };
      let rootIds = [...s.rootIds];
      // 기존 부모에서 제거
      if (node.parentId) {
        const oldParent = nodes[node.parentId];
        if (oldParent && oldParent.kind === "folder") {
          nodes[node.parentId] = {
            ...oldParent,
            childIds: oldParent.childIds.filter((c) => c !== id),
          };
        }
      } else {
        rootIds = rootIds.filter((r) => r !== id);
      }
      // 새 부모에 삽입
      if (newParentId) {
        const np = nodes[newParentId];
        if (np && np.kind === "folder") {
          const childIds = [...np.childIds];
          childIds.splice(Math.max(0, Math.min(index, childIds.length)), 0, id);
          nodes[newParentId] = { ...np, childIds };
        }
      } else {
        rootIds.splice(Math.max(0, Math.min(index, rootIds.length)), 0, id);
      }
      nodes[id] = { ...node, parentId: newParentId };
      return { nodes, rootIds };
    }),

  removeNode: (id) =>
    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;
      const nodes = { ...s.nodes };
      // 폴더면 하위 재귀 삭제
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop()!;
        const n = nodes[cur];
        if (n && n.kind === "folder") stack.push(...n.childIds);
        delete nodes[cur];
      }
      // 부모/루트에서 분리
      let rootIds = s.rootIds.filter((r) => r !== id);
      if (node.parentId) {
        const parent = nodes[node.parentId];
        if (parent && parent.kind === "folder") {
          nodes[node.parentId] = {
            ...parent,
            childIds: parent.childIds.filter((c) => c !== id),
          };
        }
      }
      return { nodes, rootIds };
    }),

  toggleFolder: (id) =>
    set((s) => ({
      expandedFolders: s.expandedFolders.includes(id)
        ? s.expandedFolders.filter((f) => f !== id)
        : [...s.expandedFolders, id],
    })),

  selectRequest: (tabId, requestId) =>
    set((s) => {
      const node = s.nodes[requestId];
      const item = s.items[tabId];
      if (!item || !node || node.kind !== "request") return s;
      return {
        items: {
          ...s.items,
          [tabId]: { ...item, requestNodeId: requestId, title: node.request.name },
        },
        // 선택 시 draft를 해당 요청의 복제로 채운다(편집 시작점).
        draftById: {
          ...s.draftById,
          [tabId]: structuredClone(node.request),
        },
      };
    }),

  saveDraft: (tabId, collectionId) =>
    set((s) => {
      const draft = s.draftById[tabId];
      const item = s.items[tabId];
      if (!draft || !item) return s;
      const existingId = item.requestNodeId;
      // 기존 노드면 갱신, 없으면 새 요청 노드 생성(collectionId 폴더 또는 루트).
      if (existingId && s.nodes[existingId]) {
        const node = s.nodes[existingId];
        if (node.kind !== "request") return s;
        return {
          nodes: {
            ...s.nodes,
            [existingId]: { ...node, request: structuredClone(draft) },
          },
          items: { ...s.items, [tabId]: { ...item, title: draft.name } },
        };
      }
      const newId = draft.id;
      const nodes: Record<string, ApiNode> = {
        ...s.nodes,
        [newId]: {
          kind: "request",
          id: newId,
          parentId: collectionId,
          request: structuredClone(draft),
        },
      };
      let rootIds = s.rootIds;
      if (collectionId) {
        const parent = nodes[collectionId];
        if (parent && parent.kind === "folder") {
          nodes[collectionId] = { ...parent, childIds: [...parent.childIds, newId] };
        }
      } else {
        rootIds = [...s.rootIds, newId];
      }
      return {
        nodes,
        rootIds,
        items: {
          ...s.items,
          [tabId]: { ...item, requestNodeId: newId, title: draft.name },
        },
      };
    }),

  // ---- 환경 ----
  addEnvironment: (env) => {
    const id = crypto.randomUUID();
    set((s) => ({ environments: { ...s.environments, [id]: { ...env, id } } }));
    return id;
  },

  setEnvVar: (envId, index, patch) =>
    set((s) => {
      const env = s.environments[envId];
      if (!env) return s;
      const vars = [...env.vars];
      if (index < 0 || index >= vars.length) return s;
      vars[index] = { ...vars[index], ...patch };
      return { environments: { ...s.environments, [envId]: { ...env, vars } } };
    }),

  removeEnvironment: (envId) =>
    set((s) => {
      const environments = { ...s.environments };
      delete environments[envId];
      // 활성 참조 정리
      const activeEnvId = s.activeEnvId === envId ? null : s.activeEnvId;
      const activeEnvByCollection = { ...s.activeEnvByCollection };
      for (const [collId, eId] of Object.entries(activeEnvByCollection)) {
        if (eId === envId) delete activeEnvByCollection[collId];
      }
      return { environments, activeEnvId, activeEnvByCollection };
    }),

  setEnvironment: (envId, collectionId) =>
    set((s) => {
      if (collectionId) {
        const activeEnvByCollection = { ...s.activeEnvByCollection };
        if (envId) activeEnvByCollection[collectionId] = envId;
        else delete activeEnvByCollection[collectionId];
        return { activeEnvByCollection };
      }
      return { activeEnvId: envId };
    }),

  openEnvDialog: () => set({ envDialogOpen: true }),
  closeEnvDialog: () => set({ envDialogOpen: false }),

  // ---- 전송(db.runQuery 패턴: sending 토글 + resolveRequest + ipc.httpRequest) ----
  send: async (tabId) => {
    const s = get();
    const item = s.items[tabId];
    const draft = s.draftById[tabId];
    if (!item || !draft) return;
    if (s.sending[tabId]) return; // 중복 전송 방지

    // 치환 변수 병합(Global + Collection) + inherit auth 해석.
    const collId = collectionOf(s.nodes, item.requestNodeId);
    const { vars, secretValues } = mergeVars(s, item.requestNodeId);
    const inheritedAuth = resolveInheritedAuth(s.nodes, item.requestNodeId);
    const { prepared, displayUrl } = resolveRequest(
      draft,
      vars,
      secretValues,
      inheritedAuth,
    );

    set((st) => ({ sending: { ...st.sending, [tabId]: true } }));
    const startedAt = Date.now();
    try {
      const res = await ipc.httpRequest(tabId, prepared);
      const mapped = mapResponse(res);
      set((st) => ({
        responses: { ...st.responses, [tabId]: mapped },
        sending: { ...st.sending, [tabId]: false },
      }));
      get().pushHistory({
        id: crypto.randomUUID(),
        requestNodeId: item.requestNodeId,
        method: draft.method,
        url: displayUrl,
        status: mapped.status,
        statusText: mapped.statusText,
        durationMs: mapped.durationMs,
        sizeBytes: mapped.sizeBytes,
        contentType: mapped.contentType,
        at: new Date().toISOString(),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failed: ApiResponse = errorResponse(message, Date.now() - startedAt);
      set((st) => ({
        responses: { ...st.responses, [tabId]: failed },
        sending: { ...st.sending, [tabId]: false },
      }));
      get().pushHistory({
        id: crypto.randomUUID(),
        requestNodeId: item.requestNodeId,
        method: draft.method,
        url: displayUrl,
        status: 0,
        statusText: message,
        durationMs: failed.durationMs,
        sizeBytes: 0,
        contentType: null,
        at: new Date().toISOString(),
      });
    }
    void collId;
  },

  abort: (tabId) => {
    if (!get().sending[tabId]) return;
    ipc.httpCancel(tabId);
    // 응답은 send()의 catch(Cancelled)가 정리하나, 즉시 토글로 UI 반응.
    set((s) => ({ sending: { ...s.sending, [tabId]: false } }));
  },

  pushHistory: (e) =>
    set((s) => ({ history: [e, ...s.history].slice(0, HISTORY_CAP) })),

  clearResponse: (id) =>
    set((s) => {
      const responses = { ...s.responses };
      delete responses[id];
      return { responses };
    }),
}));

// ---- inherit auth 해석(§7): nodes[parentId].folderAuth를 루트까지 거슬러 첫 non-none/inherit ----
function resolveInheritedAuth(
  nodes: Record<string, ApiNode>,
  requestNodeId: string | null,
): AuthConfig {
  if (!requestNodeId) return { kind: "none" };
  const node = nodes[requestNodeId];
  let cur = node?.parentId ?? null;
  while (cur) {
    const n = nodes[cur];
    if (!n) break;
    if (n.kind === "folder") {
      const a = n.folderAuth;
      if (a.kind !== "none" && a.kind !== "inherit") return a;
    }
    cur = n.parentId;
  }
  return { kind: "none" };
}

// ---- 백엔드 HttpResponse → 프론트 ApiResponse 매핑 ----
function mapResponse(res: import("../lib/ipc").HttpResponse): ApiResponse {
  const headers: KvRow[] = res.headers.map((h) => ({
    id: crypto.randomUUID(),
    enabled: true,
    key: h.name,
    value: h.value,
  }));
  const cookies: KvRow[] = res.cookies.map((c) => ({
    id: crypto.randomUUID(),
    enabled: true,
    key: c.name,
    value: c.value,
  }));
  return {
    status: res.status,
    statusText: res.statusText,
    httpVersion: res.httpVersion,
    headers,
    cookies,
    bodyText: decodeBodyText(res.body.base64, res.body.contentType),
    bodyBase64: res.body.base64,
    contentType: res.body.contentType,
    sizeBytes: res.body.size,
    truncated: res.body.truncated,
    timing: res.timing,
    redirects: res.redirects,
    remoteAddr: res.remoteAddr,
    verifyTls: res.verifyTls,
    durationMs: res.timing.totalMs,
    error: null,
  };
}

/** base64 본문 → 텍스트 디코드(텍스트류 contentType일 때만 의미). UTF-8 안전. */
function decodeBodyText(base64: string, contentType: string | null): string {
  if (!base64) return "";
  const isText =
    !contentType ||
    /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|application\/.*\+(json|xml))/i.test(
      contentType,
    );
  if (!isText) return "";
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function errorResponse(message: string, durationMs: number): ApiResponse {
  return {
    status: 0,
    statusText: message,
    httpVersion: "",
    headers: [],
    cookies: [],
    bodyText: "",
    bodyBase64: "",
    contentType: null,
    sizeBytes: 0,
    truncated: false,
    timing: {
      dnsMs: 0,
      connectMs: 0,
      tlsMs: 0,
      ttfbMs: 0,
      downloadMs: 0,
      totalMs: durationMs,
      timingExact: false,
    },
    redirects: [],
    remoteAddr: null,
    verifyTls: true,
    durationMs,
    error: message,
  };
}

// ============================================================================
// §5.4 subscribe 즉시 저장 — 영속 필드만(화이트리스트, §5.2).
// responses/sending/draftById/envDialogOpen/activeRequestId 제외.
// (browser.ts:247 / terminals.ts:355와 1:1, 디바운스 없음.)
// ============================================================================
function persistNow() {
  const s = useApiClient.getState();
  try {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        items: s.items,
        tabIds: s.tabIds,
        nodes: s.nodes,
        rootIds: s.rootIds,
        environments: s.environments,
        activeEnvId: s.activeEnvId,
        activeEnvByCollection: s.activeEnvByCollection,
        history: s.history,
        expandedFolders: s.expandedFolders,
      } satisfies Persisted),
    );
  } catch {
    /* 무시 */
  }
}

// patchDraft가 이제 매 키 입력마다 nodes를 바꾸므로, 즉시 저장 대신 디바운스로 묶어
// localStorage write 폭주를 막는다(거대 컬렉션도 stringify 부담 완화).
let persistTimer: ReturnType<typeof setTimeout> | null = null;
useApiClient.subscribe(() => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 250);
});
// 창 닫힘/숨김 시 디바운스 대기분을 즉시 비운다(마지막 편집 유실 방지).
if (typeof window !== "undefined") {
  const flush = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistNow();
  };
  window.addEventListener("beforeunload", flush);
  window.addEventListener("pagehide", flush);
}
