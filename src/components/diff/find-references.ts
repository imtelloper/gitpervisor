// 참조 찾기 (Find Usages) — ReferenceProvider. Shift+F12(Monaco 내장 바인딩)로 발동하며
// provider 등록만으로 키가 활성화된다. 백엔드 find_references(git grep -F -w)로 사용처를 찾고,
// peek 위젯이 열리기 전에 결과 파일들의 미리보기 모델을 선생성한다(standalone Monaco는 이미
// 존재하는 모델만 해석 — goto-definition.ts의 ensurePreviewModel 재사용).
import { monaco } from "./monaco-setup";
import {
  defUri,
  ensurePreviewModel,
  getDefContext,
  lookup,
} from "./goto-definition";

import { ipc } from "../../lib/ipc";
import { extToLang, lspActive } from "../../lib/lsp/client";
import { useUi } from "../../stores/ui";

// goto-definition의 LANGS와 동일 범위 — hover/definition과 같은 언어에 참조 provider 등록.
const LANGS = [
  "python", "typescript", "javascript", "rust", "go", "java",
  "kotlin", "ruby", "cpp", "c", "csharp", "php", "scala", "swift",
];

const MAX_PREVIEW_FILES = 30; // peek 미리보기 모델 선생성 상한(FIFO 40보다 작게 — 자기잠식 방지)

/** 동시 concurrency개씩 스태거로 미리보기 모델을 선생성. */
async function ensurePreviews(paths: string[]): Promise<void> {
  const uniq = [...new Set(paths)].slice(0, MAX_PREVIEW_FILES);
  const concurrency = 4;
  let i = 0;
  async function worker() {
    while (i < uniq.length) {
      const p = uniq[i++];
      await ensurePreviewModel(p);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

let registered = false;
/** ReferenceProvider 1회 등록(goto-definition registered 가드 미러). */
export function registerFindReferences(): void {
  if (registered) return;
  registered = true;

  const provider: monaco.languages.ReferenceProvider = {
    async provideReferences(model, position, context) {
      const word = model.getWordAtPosition(position);
      const ctx = getDefContext();
      if (!word || !ctx) return [];
      // LSP 활성 시 물러남 — LSP references와 병합되면 중복 그룹→peek 회귀(§3.6).
      const lang = extToLang(ctx.ext);
      if (lang && lspActive(ctx.projectId, lang)) return [];
      // 참조는 별칭 해석 없이 커서의 단어 그대로 검색(사용처 의미론).
      const [refs, defs] = await Promise.all([
        ipc.findReferences(ctx.projectId, word.word, ctx.ext).catch(() => ({
          matches: [],
          truncated: false,
        })),
        // includeDeclaration=false 재호출 대비 정의줄 대조(캐시가 이미 데워져 있으면 ~0ms)
        lookup(word.word).catch(() => []),
      ]);

      let matches = refs.matches;
      if (context.includeDeclaration === false) {
        const defSet = new Set(defs.map((d) => `${d.path}:${d.line}`));
        matches = matches.filter((m) => !defSet.has(`${m.path}:${m.line}`));
      }
      if (matches.length === 0) return [];

      if (refs.truncated) {
        useUi.getState().pushToast("info", "참조가 많아 일부만 표시합니다");
      }

      // peek 미리보기 모델을 표시 전에 선생성(지연 로딩 훅 부재 — §3.3)
      await ensurePreviews(matches.map((m) => m.path));

      return matches.map((m) => ({
        uri: defUri(m.path),
        range: new monaco.Range(
          m.line,
          m.column,
          m.line,
          m.column + word.word.length,
        ),
      }));
    },
  };

  for (const lang of LANGS) {
    monaco.languages.registerReferenceProvider(lang, provider);
  }
}
