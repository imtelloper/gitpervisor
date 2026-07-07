// 린트 마커 (태스크 16) — lint_file 결과를 Monaco 마커로. TS 워커 가짜 진단(150개, monaco-setup
// 에서 OFF)과 달리 ruff/biome은 규칙 기반이라 단일 파일 뷰어에서도 유효하다. owner 'ruff'/'biome'
// 분리로 서로·향후 다른 진단원과 독립 교체. 도구 미설치·실패는 tool:null → no-op.
import { monaco } from "./monaco-setup";

import { ipc, type LintDiag } from "../../lib/ipc";

const OWNERS = ["ruff", "biome"];

function toSeverity(s: LintDiag["severity"]): monaco.MarkerSeverity {
  switch (s) {
    case "error":
      return monaco.MarkerSeverity.Error;
    case "warning":
      return monaco.MarkerSeverity.Warning;
    case "info":
      return monaco.MarkerSeverity.Info;
    case "hint":
      return monaco.MarkerSeverity.Hint;
  }
}

function toMarker(d: LintDiag): monaco.editor.IMarkerData {
  return {
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: d.endLine,
    endColumn: d.endColumn,
    message: d.message,
    severity: toSeverity(d.severity),
    // 규칙 코드 + 문서 링크(있으면 마커 호버에 규칙 링크 노출)
    code:
      d.code == null
        ? undefined
        : d.url
          ? { value: d.code, target: monaco.Uri.parse(d.url) }
          : d.code,
    source: undefined,
  };
}

/** lint_file → setModelMarkers(owner=tool). 적용 직전 isDisposed 가드. tool null이면 no-op.
 *  content(에디터 버퍼)를 넘기면 ruff는 저장 전 버퍼를 실시간 린트한다. */
export async function refreshLintMarkers(
  model: monaco.editor.ITextModel,
  projectId: string,
  relPath: string,
  content?: string,
): Promise<void> {
  let report;
  try {
    report = await ipc.lintFile(projectId, relPath, content);
  } catch {
    return; // 실패는 조용히 — 다음 트리거가 재시도
  }
  if (!report.tool || model.isDisposed()) return;
  monaco.editor.setModelMarkers(model, report.tool, report.diags.map(toMarker));
}

/** owner 마커 클리어 — 언마운트 이중 방어(모델 dispose가 원 방어). */
export function clearLintMarkers(model: monaco.editor.ITextModel): void {
  if (model.isDisposed()) return;
  for (const owner of OWNERS) monaco.editor.setModelMarkers(model, owner, []);
}
