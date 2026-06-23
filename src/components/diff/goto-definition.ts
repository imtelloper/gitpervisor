// Viewer Go-to-Definition — Ctrl+호버 시그니처 툴팁 + 밑줄(링크), Ctrl+클릭 시 정의 파일로 이동.
// LSP 없이 백엔드 find_definition(휴리스틱 ripgrep)으로 정의를 찾는다.
//
// 동작 구조:
//  - HoverProvider: 호버 시 정의 시그니처를 마크다운 코드블록으로 표시(스크린샷의 툴팁).
//  - DefinitionProvider: 심볼을 클릭 가능한 링크로(Ctrl+호버 밑줄). 정의 위치를 커스텀 URI로 반환.
//  - registerEditorOpener: Ctrl+클릭 시 Monaco가 그 URI를 열려고 이 opener로 라우팅 → 앱 상태
//    (useUi.selectDiff)로 해당 파일을 뷰어에 열고 그 줄로 이동.
import { monaco } from "./monaco-setup";

import type { DefMatch } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useUi } from "../../stores/ui";

const SCHEME = "gitpervisor-def";

// 현재 뷰어가 보여주는 파일의 컨텍스트(검색 대상 프로젝트 + 언어 판정용 확장자).
// 모델 URI는 @monaco-editor/react가 자동 생성(inmemory)이라 파일 경로를 모르므로 모듈 변수로 전달.
let ctx: { projectId: string; ext: string } | null = null;
export function setDefContext(projectId: string, ext: string) {
  ctx = { projectId, ext };
}

// 심볼→결과 캐시(같은 심볼 반복 호버 시 백엔드 재호출 회피). 키에 projectId·ext 포함.
const cache = new Map<string, Promise<DefMatch[]>>();
function lookup(symbol: string): Promise<DefMatch[]> {
  if (!ctx) return Promise.resolve([]);
  const key = `${ctx.projectId}:${ctx.ext}:${symbol}`;
  let p = cache.get(key);
  if (!p) {
    p = ipc.findDefinition(ctx.projectId, symbol, ctx.ext).catch(() => []);
    cache.set(key, p);
    if (cache.size > 800) cache.clear();
  }
  return p;
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
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const matches = await lookup(word.word);
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
          { value: "```" + lang + "\n" + m.signature + "\n```" },
          { value: hint },
        ],
      };
    },
  };

  const def: monaco.languages.DefinitionProvider = {
    async provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const matches = await lookup(word.word);
      if (!matches.length) return null;
      // 최선 후보 1건만 — target 모델이 없어 다중 peek는 비므로 단일 점프를 보장한다.
      const m = matches[0];
      return [
        {
          uri: monaco.Uri.from({
            scheme: SCHEME,
            path: "/" + m.path,
            query: `l=${m.line}`,
          }),
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
      if (selectionOrPosition && "startLineNumber" in selectionOrPosition) {
        line = selectionOrPosition.startLineNumber;
      } else if (selectionOrPosition && "lineNumber" in selectionOrPosition) {
        line = selectionOrPosition.lineNumber;
      } else {
        line = Number(new URLSearchParams(resource.query).get("l")) || 1;
      }
      useUi.getState().selectDiff({ mode: "file", path, line });
      return true;
    },
  });
}
