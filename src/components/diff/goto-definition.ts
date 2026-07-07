// Viewer Go-to-Definition — Ctrl+호버 시그니처 툴팁 + 밑줄(링크), Ctrl+클릭 시 정의 파일로 이동.
// LSP 없이 백엔드 find_definition(휴리스틱 git grep)으로 정의를 찾는다.
//
// 동작 구조:
//  - HoverProvider: 호버 시 정의 시그니처를 마크다운 코드블록으로 표시(스크린샷의 툴팁).
//  - DefinitionProvider: 심볼을 클릭 가능한 링크로(Ctrl+호버 밑줄). 정의 위치를 커스텀 URI로 반환.
//    반환 전에 대상 파일 내용으로 "미리보기 모델"을 만들어 둔다 — Monaco는 단일 정의 결과의
//    URI를 텍스트 모델로 해석해 미리보기를 만들 수 있어야만 밑줄/포인터 장식을 그린다
//    (해석 실패 시 장식 없이 조용히 끝나 Ctrl+호버가 무반응으로 보인다).
//  - registerEditorOpener: Ctrl+클릭 시 Monaco가 그 URI를 열려고 이 opener로 라우팅 → 앱 상태
//    (useUi.selectDiff)로 해당 파일을 뷰어에 열고 그 줄로 이동.
import { monaco } from "./monaco-setup";

import type { DefMatch } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { extToLang, lspActive } from "../../lib/lsp/client";
import { languageOf } from "../../lib/language-map";
import { useUi } from "../../stores/ui";

const SCHEME = "gitpervisor-def";

// 현재 뷰어가 보여주는 파일의 컨텍스트(검색 대상 프로젝트 + 언어 판정용 확장자).
// 모델 URI는 @monaco-editor/react가 자동 생성(inmemory)이라 파일 경로를 모르므로 모듈 변수로 전달.
let ctx: { projectId: string; ext: string } | null = null;

/** 현재 파일의 언어 서버가 활성이면 휴리스틱 provider는 물러난다(§3.6 상호배타 게이트). */
function gatedByLsp(): boolean {
  if (!ctx) return false;
  const lang = extToLang(ctx.ext);
  return lang != null && lspActive(ctx.projectId, lang);
}
export function setDefContext(projectId: string, ext: string) {
  ctx = { projectId, ext };
}
/** 현재 뷰어 컨텍스트(projectId·ext) — 참조 찾기 등 재사용용. */
export function getDefContext(): { projectId: string; ext: string } | null {
  return ctx;
}

// 심볼→결과 캐시(같은 심볼 반복 호버 시 백엔드 재호출 회피). 키에 projectId·ext 포함.
const cache = new Map<string, Promise<DefMatch[]>>();
export function lookup(
  symbol: string,
  lane: "interactive" | "background" = "interactive",
): Promise<DefMatch[]> {
  if (!ctx) return Promise.resolve([]);
  const key = `${ctx.projectId}:${ctx.ext}:${symbol}`;
  let p = cache.get(key);
  if (!p) {
    p = ipc.findDefinition(ctx.projectId, symbol, ctx.ext, lane).catch(() => []);
    cache.set(key, p);
    if (cache.size > 800) cache.clear();
  }
  return p;
}

/**
 * 파일이 뷰어에 열릴 때 import된 심볼들의 정의를 백그라운드로 미리 조회해 캐시를 데운다
 * — 가장 많이 Ctrl+클릭되는 심볼(임포트한 것들)의 첫 호버가 사실상 즉시 반응하게 된다.
 * `X as Y` 별칭은 실제 이름 X를 데운다(호버 시 X로 해석되므로 캐시 키가 일치).
 * 동시 2개 스태거 + 최대 20심볼 — 백엔드 git 프로세스/디스크를 점유하지 않게.
 */
export function warmDefinitionCache(text: string): void {
  if (!ctx) return;
  const syms = new Set<string>();
  const addName = (raw: string) => {
    const name = raw.trim().split(/\s+as\s+/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) syms.add(name);
  };
  for (const line of text.split("\n", 400)) {
    if (!/\b(?:import|from)\b/.test(line)) continue;
    // `Real as Alias` — 실제 이름을 데운다
    for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*/g))
      syms.add(m[1]);
    const py = /^\s*from\s+\S+\s+import\s+(.+)$/.exec(line);
    if (py) py[1].split(",").forEach(addName);
    const js = /import\s*\{([^}]*)\}/.exec(line);
    if (js) js[1].split(",").forEach(addName);
    const pyMod = /^\s*import\s+([\w.]+)\s+as\s+/.exec(line); // import a.b as c → b
    if (pyMod) syms.add(pyMod[1].split(".").pop() ?? "");
  }
  const list = [...syms].filter(Boolean).slice(0, 20);
  let i = 0;
  const next = () => {
    const s = list[i++];
    if (s) void lookup(s, "background").finally(next);
  };
  next();
  next();
}

/** 정의 대상의 커스텀 URI — line은 정의 range로 전달하므로 URI는 경로만(파일당 모델 1개). */
export function defUri(path: string): monaco.Uri {
  return monaco.Uri.from({ scheme: SCHEME, path: "/" + path });
}

// Ctrl+호버 밑줄·미리보기용 모델 사전 생성 — 파일 내용을 백엔드에서 받아 커스텀 URI 모델로
// 캐시한다(첫 호버당 1회). 실패해도 점프(opener)는 동작하고 장식만 빠진다.
const previewUris: monaco.Uri[] = [];
export async function ensurePreviewModel(path: string): Promise<void> {
  const uri = defUri(path);
  if (monaco.editor.getModel(uri) || !ctx) return;
  try {
    const diff = await ipc.getDiff(ctx.projectId, { mode: "file", path });
    if (monaco.editor.getModel(uri)) return; // 경합 — 그 사이 생겼으면 그대로 사용
    monaco.editor.createModel(diff.newContent ?? "", languageOf(path), uri);
    previewUris.push(uri);
    // 캐시 상한 — 오래된 미리보기 모델부터 정리(장기 세션 메모리 증식 방지)
    if (previewUris.length > 40) {
      const old = previewUris.shift();
      if (old) monaco.editor.getModel(old)?.dispose();
    }
  } catch {
    /* 미리보기 없이도 Ctrl+클릭 점프는 opener가 처리 */
  }
}

/**
 * 현재 파일의 import 별칭(`X as word`)을 실제 심볼로 되돌린다 — `from m import Real as Alias`
 * 류로 들여온 이름은 레포에 정의가 없어(별칭일 뿐) 검색이 비므로 원래 이름으로 찾는다.
 * `import a.b as X`(모듈 별칭)는 마지막 조각(b)을 반환해 모듈 파일 폴백으로 잇는다.
 * `with … as x`/`except … as e`는 import/from이 없는 줄이라 걸러진다.
 * modHint = import 원본 모듈의 마지막 조각 — 동명 정의가 여럿일 때 그 모듈 파일을 우선한다.
 */
function resolveImportAlias(
  model: monaco.editor.ITextModel,
  word: string,
): { symbol: string; modHint: string | null } {
  const w = word.replace(/\$/g, "\\$");
  const re = new RegExp(`(?:^|[\\s,{(])([A-Za-z_$][\\w$.]*)\\s+as\\s+${w}\\b`);
  const n = Math.min(model.getLineCount(), 500); // import는 사실상 상단에 있다
  for (let i = 1; i <= n; i++) {
    const line = model.getLineContent(i);
    if (!/\b(?:import|from)\b/.test(line)) continue;
    const m = re.exec(line);
    if (!m) continue;
    const from = /\bfrom\s+([\w.$/@-]+)\s+import\b/.exec(line);
    return {
      symbol: m[1].split(".").pop() ?? word,
      modHint: from ? (from[1].split(/[./]/).pop() ?? null) : null,
    };
  }
  return { symbol: word, modHint: null };
}

/** 별칭 해석 + 검색 + 모듈 힌트로 후보 축소 — hover/definition 공용 조회. */
async function lookupAt(
  model: monaco.editor.ITextModel,
  word: string,
): Promise<DefMatch[]> {
  const { symbol, modHint } = resolveImportAlias(model, word);
  const matches = await lookup(symbol);
  if (modHint && matches.length > 1) {
    const pref = matches.filter((m) => m.path.includes(modHint));
    if (pref.length) return pref;
  }
  return matches;
}

/** 마크다운 토큰 백슬래시 이스케이프 — 독스트링/JSDoc 원문을 렌더 그대로 보이게(htmlContent.js:108 미러). */
function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-!~]/g, "\\$&");
}

/** 코드블록 펜스 — 내용의 최장 백틱 런+1(최소 3)로 연장해 시그니처에 백틱이 있어도 안 깨지게(htmlContent.js:115 미러). */
function fencedBlock(lang: string, code: string): string {
  const longest = (code.match(/`+/g) ?? []).reduce((n, r) => Math.max(n, r.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${code}\n${fence}`;
}

function monacoLangId(ext: string): string {
  const e = ext.toLowerCase();
  if (["ts", "tsx"].includes(e)) return "typescript";
  if (["js", "jsx", "mjs", "cjs"].includes(e)) return "javascript";
  if (["py", "pyi"].includes(e)) return "python";
  if (e === "rs") return "rust";
  if (e === "go") return "go";
  if (["c", "h"].includes(e)) return "c";
  if (["cpp", "cc", "hpp", "cxx"].includes(e)) return "cpp";
  if (e === "rb") return "ruby";
  return e || "text";
}

// 호버/정의를 제공할 언어들(현재 뷰어 모델 언어에 따라 해당 provider가 발화).
const LANGS = [
  "python", "typescript", "javascript", "rust", "go", "java",
  "kotlin", "ruby", "cpp", "c", "csharp", "php", "scala", "swift",
];

let registered = false;
/** Go-to-Definition provider/opener를 1회 등록(HMR·재마운트 중복 방지). */
export function registerGotoDefinition() {
  if (registered) return;
  registered = true;

  const hover: monaco.languages.HoverProvider = {
    async provideHover(model, position) {
      if (gatedByLsp()) return null; // LSP 활성 시 물러남(§3.6 — 중복 호버 카드 방지)
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const matches = await lookupAt(model, word.word);
      if (!matches.length) return null;
      const m = matches[0];
      const lang = monacoLangId(ctx?.ext ?? "");
      const hint =
        matches.length > 1
          ? `_정의 후보 ${matches.length}개 · Ctrl+클릭으로 이동 → ${m.path}:${m.line}_`
          : `_Ctrl+클릭으로 이동 → ${m.path}:${m.line}_`;
      return {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
        contents: [
          { value: fencedBlock(lang, m.signature) },
          // 문서 블록(있을 때만) — 마크다운 토큰 이스케이프 + 하드 줄바꿈으로 원문 구조 보존
          ...(m.doc ? [{ value: escapeMd(m.doc).replace(/\n/g, "  \n") }] : []),
          { value: hint },
        ],
      };
    },
  };

  const def: monaco.languages.DefinitionProvider = {
    async provideDefinition(model, position) {
      if (gatedByLsp()) return null; // LSP 활성 시 물러남(정의 2건→peek 회귀 방지)
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const matches = await lookupAt(model, word.word);
      if (!matches.length) return null;
      // 최선 후보 1건만 — 다중 결과는 peek 위젯으로 빠져 단일 점프가 깨진다.
      const m = matches[0];
      // 밑줄/미리보기 장식은 대상 모델 해석이 선행돼야 한다 — 반환 전에 만들어 둔다.
      await ensurePreviewModel(m.path);
      return [
        {
          uri: defUri(m.path),
          range: new monaco.Range(m.line, m.column, m.line, m.column + word.word.length),
        },
      ];
    },
  };

  for (const lang of LANGS) {
    monaco.languages.registerHoverProvider(lang, hover);
    monaco.languages.registerDefinitionProvider(lang, def);
  }

  // Ctrl+클릭 → 다른 파일의 정의로 이동. Monaco가 커스텀 스킴 URI를 열 때 여기로 라우팅된다.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== SCHEME) return false;
      const path = resource.path.replace(/^\//, "");
      let line = 1;
      let column = 1;
      if (selectionOrPosition && "startLineNumber" in selectionOrPosition) {
        line = selectionOrPosition.startLineNumber;
        column = selectionOrPosition.startColumn;
      } else if (selectionOrPosition && "lineNumber" in selectionOrPosition) {
        line = selectionOrPosition.lineNumber;
        column = selectionOrPosition.column;
      } else {
        line = Number(new URLSearchParams(resource.query).get("l")) || 1;
      }
      // 정의 검색은 현재 파일의 저장소(ctx.projectId) 안에서 이뤄지고 반환 경로도 그 저장소
      // 기준 상대경로다 — 임베디드 저장소면 합성 id를 diff repo로 전달해야 엉뚱한(outer) 저장소의
      // 동일 상대경로 파일로 점프하지 않는다.
      useUi.getState().selectDiff({ mode: "file", path, line, column }, ctx?.projectId);
      return true;
    },
  });
}
