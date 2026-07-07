// 포매터 provider (태스크 15) — DocumentFormattingEditProvider. Shift+Alt+F(Monaco 내장 키)로
// 발동하며 provider 등록만으로 활성화된다. 백엔드 format_source(ruff/biome)로 포맷하고 전체범위
// edit 1건을 반환하면 최소 edit·undo·스크롤 보존은 Monaco가 처리한다(computeMoreMinimalEdits).
import { monaco } from "./monaco-setup";

import { isIpcError, errorMessage, ipc } from "../../lib/ipc";
import { useUi } from "../../stores/ui";

// 파일뷰 Editor 모델은 경로 없는 자동 URI라 URI에서 역산 불가 — 모듈 컨텍스트로 주입(setDefContext 관례).
let ctx: { projectId: string; relPath: string } | null = null;
export function setFormatContext(projectId: string, relPath: string): void {
  ctx = { projectId, relPath };
}

// document 포맷 provider를 등록할 언어(tsx/jsx는 typescript/javascript에 포함).
const FORMAT_LANGS = ["python", "typescript", "javascript", "json", "css"];

let registered = false;
export function registerFormatProviders(): void {
  if (registered) return;
  registered = true;

  const provider: monaco.languages.DocumentFormattingEditProvider = {
    displayName: "gitpervisor-format",
    async provideDocumentFormattingEdits(model) {
      if (!ctx) return [];
      const content = model.getValue();
      try {
        const res = await ipc.formatSource(ctx.projectId, ctx.relPath, content);
        if (!res.changed || res.formatted == null) return [];
        return [{ range: model.getFullModelRange(), text: res.formatted }];
      } catch (e) {
        if (isIpcError(e) && e.code === "TOOL_NOT_FOUND") {
          useUi.getState().pushToast("error", errorMessage(e), {
            label: "설정 열기",
            run: () => useUi.getState().setSettingsOpen(true),
          });
        } else {
          useUi.getState().pushToast("error", `포맷 실패: ${errorMessage(e)}`);
        }
        return [];
      }
    },
  };

  for (const lang of FORMAT_LANGS) {
    monaco.languages.registerDocumentFormattingEditProvider(lang, provider);
  }
}
