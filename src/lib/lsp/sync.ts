// LSP 문서 동기화 (태스크 17 M1) — 파일뷰 열람/편집/저장/닫기를 didOpen/didChange/didSave/
// didClose로 서버에 반영하고, publishDiagnostics를 Monaco 마커로 표시(owner "lsp:{key}").
// 모델↔{세션,uri} 바인딩의 단일 진실 — providers.ts가 여기서 현재 문서를 조회한다.
import { monaco } from "../../components/diff/monaco-setup";

import { ipc } from "../ipc";
import {
  ensureSession,
  extToLang,
  lspActive,
  pathToUri,
  sessionFor,
  uriToPath,
  type LspSession,
} from "./client";

export interface BoundDoc {
  session: LspSession;
  uri: string;
  model: monaco.editor.ITextModel;
}

const byModel = new WeakMap<monaco.editor.ITextModel, BoundDoc>();

/** providers.ts가 현재 모델의 LSP 문서(세션+uri)를 조회. 바인딩 안 됐으면 undefined. */
export function docFor(model: monaco.editor.ITextModel): BoundDoc | undefined {
  return byModel.get(model);
}

/** 파일뷰 마운트/열람 시 — 세션 보장 + didOpen + 진단 라우팅 등록. 옵트인 판정은 호출부(DiffViewer). */
export async function lspOpenDoc(
  projectId: string,
  ext: string,
  relPath: string,
  model: monaco.editor.ITextModel,
): Promise<void> {
  const lang = extToLang(ext);
  if (!lang) return;
  const session = await ensureSession(projectId, lang);
  if (!session || model.isDisposed()) return;

  const uri = pathToUri(joinRepo(session.rootPath, relPath));
  const languageId = lang === "py" ? "python" : model.getLanguageId();
  session.didOpen(uri, languageId, model.getValue());
  byModel.set(model, { session, uri, model });

  // 진단 라우팅 — 세션당 1회 설정. uri로 바인딩된 모델을 찾아 마커 갱신.
  if (!session.onDiagnostics) {
    session.onDiagnostics = (u, diags) => applyDiagnostics(session, u, diags);
  }
}

/** onDidChangeModelContent 시 — 디바운스는 호출부에서. full sync(§3.5). */
export function lspChangeDoc(model: monaco.editor.ITextModel): void {
  const b = byModel.get(model);
  if (b) b.session.didChange(b.uri, model.getValue());
}

export function lspSaveDoc(model: monaco.editor.ITextModel): void {
  const b = byModel.get(model);
  if (b) b.session.didSave(b.uri, model.getValue());
}

/** 파일뷰 언마운트/전환 시 — didClose + 마커·바인딩 정리. */
export function lspCloseDoc(model: monaco.editor.ITextModel): void {
  const b = byModel.get(model);
  if (!b) return;
  byModel.delete(model);
  b.session.didClose(b.uri);
  if (!model.isDisposed()) monaco.editor.setModelMarkers(model, `lsp:${b.session.key}`, []);
}

// ── 진단 → Monaco 마커 ──
function applyDiagnostics(session: LspSession, uri: string, diags: unknown[]): void {
  // 그 uri로 didOpen한 모델을 찾는다(세션 스코프 owner — 다른 세션 마커를 덮지 않음, §3.7).
  const model = findModelByUri(session, uri);
  if (!model || model.isDisposed()) return;
  const markers = (diags as LspDiagnostic[]).map((d) => toMarker(d));
  monaco.editor.setModelMarkers(model, `lsp:${session.key}`, markers);
}

function findModelByUri(session: LspSession, uri: string): monaco.editor.ITextModel | null {
  // 서버가 echo하는 uri는 대소문자·퍼센트 인코딩이 우리가 보낸 것과 다를 수 있다
  // (basedpyright: file:///c%3A/… vs 우리 file:///C:/…) → 경로로 환원해 비교.
  const target = canonUri(uri);
  for (const m of monaco.editor.getModels()) {
    const b = byModel.get(m);
    if (b && b.session === session && canonUri(b.uri) === target) return m;
  }
  return null;
}

function canonUri(uri: string): string {
  return uriToPath(uri).replace(/\\/g, "/").toLowerCase();
}

interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number; // 1 Error, 2 Warning, 3 Info, 4 Hint
  code?: string | number;
  message: string;
  source?: string;
}

function toMarker(d: LspDiagnostic): monaco.editor.IMarkerData {
  const sevMap: Record<number, monaco.MarkerSeverity> = {
    1: monaco.MarkerSeverity.Error,
    2: monaco.MarkerSeverity.Warning,
    3: monaco.MarkerSeverity.Info,
    4: monaco.MarkerSeverity.Hint,
  };
  return {
    // LSP 0-based → Monaco 1-based
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    message: d.message,
    severity: sevMap[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
    code: d.code != null ? String(d.code) : undefined,
    source: d.source,
  };
}

function joinRepo(root: string, rel: string): string {
  const r = root.replace(/[\\/]+$/, "");
  return `${r}/${rel.replace(/\\/g, "/")}`;
}

// dev 노출 — E2E/CDP가 세션·현재 문서를 직접 구동(window.__monaco 전례).
if (typeof window !== "undefined") {
  (window as unknown as { __gpvLsp?: unknown }).__gpvLsp = {
    docFor,
    sessionFor,
    lspActive,
    ensureSession,
    lspOpenDoc,
    pathToUri,
    lspEnsure: ipc.lspEnsure,
  };
}
