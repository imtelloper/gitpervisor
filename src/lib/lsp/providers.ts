// LSP Monaco provider (태스크 17 M1) — completion/hover/definition을 언어 서버로. LSP↔Monaco
// 타입 변환은 여기 집중. 정의 점프는 기존 gitpervisor-def 미리보기+opener 재사용(goto-definition).
// LSP 실패/빈 결과면 per-request 휴리스틱 폴백(§3.6 — 인덱싱 중에도 최소 기능 보장).
import { defUri, ensurePreviewModel, lookup } from "../../components/diff/goto-definition";
import { monaco } from "../../components/diff/monaco-setup";

import { ipc } from "../ipc";
import { useUi } from "../../stores/ui";
import { docFor } from "./sync";

const COMPLETION_TIMEOUT = 3_000; // 늦은 완성은 무가치(§3.5)

let registered = false;

/** 등록 언어 — python·typescript/javascript·cpp/c(clangd). 1회 가드(goto-definition 관례). */
const LSP_LANGS = ["python", "typescript", "javascript", "cpp", "c", "rust", "lua", "go"];

export function registerLspProviders(): void {
  if (registered) return;
  registered = true;

  const completion: monaco.languages.CompletionItemProvider = {
    triggerCharacters: [".", "[", '"', "'", "(", ",", " "],
    async provideCompletionItems(model, position) {
      const doc = docFor(model);
      if (!doc) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      let res: unknown;
      try {
        res = await doc.session.request(
          "textDocument/completion",
          posParams(doc.uri, position),
          COMPLETION_TIMEOUT,
        );
      } catch {
        return { suggestions: [] };
      }
      const items = (Array.isArray(res) ? res : (res as { items?: unknown[] })?.items ?? []) as LspCompletion[];
      return { suggestions: items.map((i) => toCompletion(i, range)) };
    },
  };

  const hover: monaco.languages.HoverProvider = {
    async provideHover(model, position) {
      const doc = docFor(model);
      if (!doc) return null;
      let res: LspHover | null;
      try {
        res = (await doc.session.request("textDocument/hover", posParams(doc.uri, position))) as LspHover;
      } catch {
        return null;
      }
      if (!res || res.contents == null) return null;
      const value = hoverToMarkdown(res.contents);
      if (!value.trim()) return null;
      return {
        contents: [{ value }],
        range: res.range ? lspRangeToMonaco(res.range) : undefined,
      };
    },
  };

  const definition: monaco.languages.DefinitionProvider = {
    async provideDefinition(model, position) {
      const doc = docFor(model);
      if (!doc) return null;
      let res: unknown = null;
      try {
        res = await doc.session.request("textDocument/definition", posParams(doc.uri, position));
      } catch {
        res = null;
      }
      const loc = firstLocation(res);
      if (loc) {
        const rel = toRepoRel(doc.session.rootPath, loc.uri);
        if (rel) {
          await ensurePreviewModel(rel);
          const r = loc.range;
          return [
            {
              uri: defUri(rel),
              range: new monaco.Range(
                r.start.line + 1,
                r.start.character + 1,
                r.end.line + 1,
                r.end.character + 1,
              ),
            },
          ];
        }
      }
      // per-request 폴백 — LSP 실패/레포밖/빈 결과면 휴리스틱 정의로(§3.6).
      return heuristicDefinition(model, position);
    },
  };

  const references: monaco.languages.ReferenceProvider = {
    async provideReferences(model, position, context) {
      const doc = docFor(model);
      if (!doc) return [];
      let res: unknown;
      try {
        res = await doc.session.request("textDocument/references", {
          ...posParams(doc.uri, position),
          context: { includeDeclaration: context.includeDeclaration },
        });
      } catch {
        return [];
      }
      const locs = (Array.isArray(res) ? res : []) as LspLocation[];
      const rels = new Map<string, LspLocation[]>(); // relPath → locs
      for (const loc of locs) {
        const rel = toRepoRel(doc.session.rootPath, loc.uri);
        if (rel) (rels.get(rel) ?? rels.set(rel, []).get(rel)!).push(loc);
      }
      // peek 위젯 전에 미리보기 모델 선생성(standalone Monaco는 존재하는 모델만 해석).
      for (const rel of rels.keys()) await ensurePreviewModel(rel);
      const out: monaco.languages.Location[] = [];
      for (const [rel, ls] of rels) for (const loc of ls) {
        out.push({ uri: defUri(rel), range: lspRangeToMonaco(loc.range) });
      }
      return out;
    },
  };

  const signatureHelp: monaco.languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, position) {
      const doc = docFor(model);
      if (!doc) return null;
      let res: LspSignatureHelp | null;
      try {
        res = (await doc.session.request("textDocument/signatureHelp", posParams(doc.uri, position))) as LspSignatureHelp;
      } catch {
        return null;
      }
      if (!res || !res.signatures?.length) return null;
      return {
        value: {
          signatures: res.signatures.map((s) => ({
            label: s.label,
            documentation: docToMarkdown(s.documentation),
            parameters: (s.parameters ?? []).map((p) => ({
              label: p.label,
              documentation: docToMarkdown(p.documentation),
            })),
            activeParameter: s.activeParameter,
          })),
          activeSignature: res.activeSignature ?? 0,
          activeParameter: res.activeParameter ?? 0,
        },
        dispose: () => {},
      };
    },
  };

  const rename: monaco.languages.RenameProvider = {
    async resolveRenameLocation(model, position) {
      const doc = docFor(model);
      const word = model.getWordAtPosition(position);
      if (!doc || !word) {
        return { range: new monaco.Range(1, 1, 1, 1), text: "", rejectReason: "이름을 바꿀 심볼이 없습니다" };
      }
      // prepareRename으로 바꿀 수 있는 위치인지 + 범위 확인(실패해도 단어로 폴백).
      try {
        const res = (await doc.session.request("textDocument/prepareRename", posParams(doc.uri, position))) as
          | (LspRange & { placeholder?: undefined })
          | { range: LspRange; placeholder?: string }
          | { defaultBehavior: boolean }
          | null;
        if (res && "range" in res) {
          return { range: lspRangeToMonaco(res.range), text: res.placeholder ?? word.word };
        }
        if (res && "start" in res) {
          return { range: lspRangeToMonaco(res as LspRange), text: word.word };
        }
      } catch {
        /* prepareRename 미지원 — 단어 범위로 폴백 */
      }
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        text: word.word,
      };
    },
    async provideRenameEdits(model, position, newName) {
      const doc = docFor(model);
      if (!doc) return { edits: [] };
      let we: LspWorkspaceEdit | null;
      try {
        we = (await doc.session.request("textDocument/rename", {
          ...posParams(doc.uri, position),
          newName,
        })) as LspWorkspaceEdit;
      } catch {
        return { edits: [], rejectReason: "이름 변경 실패" };
      }
      if (!we) return { edits: [], rejectReason: "이름을 바꿀 수 없습니다" };

      const byUri = normalizeWorkspaceEdit(we);
      const currentEdits: monaco.languages.IWorkspaceTextEdit[] = [];
      let otherFiles = 0;
      for (const [uri, edits] of byUri) {
        if (canonEq(uri, doc.uri)) {
          // 현재 모델 — Monaco가 적용(라이브·undo 가능).
          for (const e of edits) {
            currentEdits.push({ resource: model.uri, textEdit: { range: lspRangeToMonaco(e.range), text: e.newText }, versionId: undefined });
          }
        } else {
          // 다른 파일 — 디스크에 적용(resolve_in_repo 가드는 writeFile 백엔드가). 실패는 건너뜀.
          const rel = toRepoRel(doc.session.rootPath, uri);
          if (!rel) continue;
          try {
            const cur = await ipc.getDiff(doc.session.projectId, { mode: "file", path: rel });
            const next = applyLspEdits(cur.newContent ?? "", edits);
            await ipc.writeFile(doc.session.projectId, rel, next);
            otherFiles += 1;
          } catch {
            /* 개별 파일 실패는 무시 — 나머지는 진행 */
          }
        }
      }
      if (otherFiles > 0) {
        useUi.getState().pushToast("success", `${otherFiles}개 파일에 이름 변경 적용됨 · 현재 파일은 Ctrl+S로 저장`);
      }
      return { edits: currentEdits };
    },
  };

  const inlayHints: monaco.languages.InlayHintsProvider = {
    async provideInlayHints(model, range) {
      const doc = docFor(model);
      if (!doc) return null;
      let res: LspInlayHint[] | null;
      try {
        res = (await doc.session.request("textDocument/inlayHint", {
          textDocument: { uri: doc.uri },
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
        })) as LspInlayHint[];
      } catch {
        return null;
      }
      if (!res?.length) return null;
      return {
        hints: res.map((h) => ({
          position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
          // LSP InlayHintKind(Type=1,Parameter=2)는 Monaco와 값 동일.
          kind: h.kind,
          label:
            typeof h.label === "string"
              ? h.label
              : h.label.map((p) => ({ label: p.value })),
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
          tooltip: mdTooltip(h.tooltip),
        })),
        dispose: () => {},
      };
    },
  };

  for (const lang of LSP_LANGS) {
    monaco.languages.registerCompletionItemProvider(lang, completion);
    monaco.languages.registerHoverProvider(lang, hover);
    monaco.languages.registerDefinitionProvider(lang, definition);
    monaco.languages.registerReferenceProvider(lang, references);
    monaco.languages.registerSignatureHelpProvider(lang, signatureHelp);
    monaco.languages.registerRenameProvider(lang, rename);
    monaco.languages.registerInlayHintsProvider(lang, inlayHints);
  }
}

// ── per-request 휴리스틱 폴백(정의) — goto-definition 재사용 ──
async function heuristicDefinition(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.Definition | null> {
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const matches = await lookup(word.word);
  if (!matches.length) return null;
  const m = matches[0];
  await ensurePreviewModel(m.path);
  return [
    {
      uri: defUri(m.path),
      range: new monaco.Range(m.line, m.column, m.line, m.column + word.word.length),
    },
  ];
}

// ── 타입 변환 ──
interface LspPos {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPos;
  end: LspPos;
}
interface LspHover {
  contents: unknown;
  range?: LspRange;
}
interface LspCompletion {
  label: string;
  kind?: number;
  detail?: string;
  labelDetails?: { detail?: string; description?: string };
  documentation?: unknown;
  insertText?: string;
  insertTextFormat?: number; // 1 plaintext, 2 snippet
  textEdit?: { newText: string; range?: LspRange; insert?: LspRange; replace?: LspRange };
  sortText?: string;
  filterText?: string;
  commitCharacters?: string[];
  preselect?: boolean;
}

function posParams(uri: string, position: monaco.Position) {
  return {
    textDocument: { uri },
    position: { line: position.lineNumber - 1, character: position.column - 1 },
  };
}

function lspRangeToMonaco(r: LspRange): monaco.Range {
  return new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
}

/** LSP CompletionItemKind(1-25) → Monaco CompletionItemKind. */
const K = monaco.languages.CompletionItemKind;
const LSP_TO_MONACO_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field,
  6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property,
  11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet,
  16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember,
  21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter,
};

function toCompletion(item: LspCompletion, defaultRange: monaco.Range): monaco.languages.CompletionItem {
  let insertText = item.insertText ?? item.label;
  let range: monaco.Range | monaco.languages.CompletionItemRanges = defaultRange;
  const te = item.textEdit;
  if (te) {
    insertText = te.newText;
    const r = te.range ?? te.insert;
    if (r) range = lspRangeToMonaco(r);
  }
  return {
    label: item.labelDetails
      ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description }
      : item.label,
    kind: LSP_TO_MONACO_KIND[item.kind ?? 1] ?? K.Text,
    insertText,
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    range,
    detail: item.detail ?? item.labelDetails?.detail,
    documentation: docToMarkdown(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    commitCharacters: item.commitCharacters,
    preselect: item.preselect,
  };
}

function docToMarkdown(doc: unknown): string | monaco.IMarkdownString | undefined {
  if (doc == null) return undefined;
  if (typeof doc === "string") return doc;
  const d = doc as { kind?: string; value?: string };
  if (d.value == null) return undefined;
  return d.kind === "markdown" ? { value: d.value } : d.value;
}

function hoverToMarkdown(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markedString).join("\n\n---\n\n");
  const c = contents as { kind?: string; value?: string; language?: string };
  if (c.kind && c.value != null) return c.value; // MarkupContent
  return markedString(contents);
}
function markedString(m: unknown): string {
  if (typeof m === "string") return m;
  const s = m as { language?: string; value?: string };
  if (s.language && s.value != null) return "```" + s.language + "\n" + s.value + "\n```";
  return s.value ?? "";
}

interface LspSignatureHelp {
  signatures: {
    label: string;
    documentation?: unknown;
    parameters?: { label: string | [number, number]; documentation?: unknown }[];
    activeParameter?: number;
  }[];
  activeSignature?: number;
  activeParameter?: number;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}
interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

function firstLocation(res: unknown): LspLocation | null {
  if (!res) return null;
  const arr = (Array.isArray(res) ? res : [res]) as (LspLocation | LspLocationLink)[];
  if (!arr.length) return null;
  const first = arr[0];
  if ("targetUri" in first) {
    return { uri: first.targetUri, range: first.targetSelectionRange ?? first.targetRange };
  }
  return { uri: first.uri, range: first.range };
}

/** LSP file URI → 레포 상대경로. 레포 밖(외부 라이브러리)이면 null(v1은 점프 안 함). */
function toRepoRel(rootPath: string, uri: string): string | null {
  const abs = uriToPath(uri).replace(/\\/g, "/");
  const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (abs.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return abs.slice(root.length + 1);
  }
  return null;
}

function uriToPath(uri: string): string {
  let p = uri.replace(/^file:\/\//, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    /* 잘못된 인코딩 — 원문 사용 */
  }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // /C:/... → C:/...
  return p;
}

function canonEq(a: string, b: string): boolean {
  return uriToPath(a).replace(/\\/g, "/").toLowerCase() === uriToPath(b).replace(/\\/g, "/").toLowerCase();
}

// ── rename ──
interface LspTextEdit {
  range: LspRange;
  newText: string;
}
interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: { textDocument?: { uri: string }; edits?: LspTextEdit[] }[];
}

/** WorkspaceEdit(changes 또는 documentChanges) → uri별 TextEdit[]. */
function normalizeWorkspaceEdit(we: LspWorkspaceEdit): Map<string, LspTextEdit[]> {
  const out = new Map<string, LspTextEdit[]>();
  if (we.changes) {
    for (const [uri, edits] of Object.entries(we.changes)) out.set(uri, edits);
  }
  for (const dc of we.documentChanges ?? []) {
    const uri = dc.textDocument?.uri;
    if (uri && dc.edits) out.set(uri, [...(out.get(uri) ?? []), ...dc.edits]);
  }
  return out;
}

/** 파일 내용에 LSP TextEdit들을 적용(오프셋 역순 — 앞 edit이 뒤 오프셋을 밀지 않게). */
function applyLspEdits(content: string, edits: LspTextEdit[]): string {
  const lineStart: number[] = [0];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) lineStart.push(lineStart[i] + lines[i].length + 1);
  const toOff = (p: LspPos) => Math.min((lineStart[p.line] ?? content.length) + p.character, content.length);
  const sorted = [...edits].sort((a, b) => toOff(b.range.start) - toOff(a.range.start));
  let out = content;
  for (const e of sorted) {
    out = out.slice(0, toOff(e.range.start)) + e.newText + out.slice(toOff(e.range.end));
  }
  return out;
}

// ── inlayHints ──
interface LspInlayHint {
  position: LspPos;
  label: string | { value: string }[];
  kind?: number; // 1 Type, 2 Parameter (Monaco와 값 동일)
  paddingLeft?: boolean;
  paddingRight?: boolean;
  tooltip?: string | { value: string };
}

function mdTooltip(t: string | { value: string } | undefined): string | monaco.IMarkdownString | undefined {
  if (t == null) return undefined;
  return typeof t === "string" ? t : { value: t.value };
}
