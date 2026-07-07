// 실전 린트 마커 (lint_file) — 러너 발견·침묵 스킵·경로 검증 + 마커 owner 배선.
// 실제 린트는 ruff/biome 설치 시에만(게이트). 미설치 환경에선 tool:null 침묵 경로를 단언.
export const name = "실전 린트 마커 (lint_file)";

export async function run({ cdp, report: r, fix }) {
  fix.writeFile("bad.py", "import os\nx=1\n"); // F401(unused import) 유발

  // 비대상 확장자 → tool:null
  const md = await cdp.invoke("lint_file", { projectId: fix.projectId, relPath: "README.md" });
  r.check("비대상 확장자 → tool:null(no-op)", md.tool === null && md.diags.length === 0, JSON.stringify(md));

  // 경로 탈출 거부
  const trav = await cdp.try("lint_file", { projectId: fix.projectId, relPath: "../x.py" });
  r.check("../ 경로 거부", !trav.ok, trav.code);

  // 없는 프로젝트
  const noProj = await cdp.try("lint_file", { projectId: "no-such", relPath: "a.py" });
  r.check("없는 프로젝트 → NOT_FOUND", !noProj.ok && noProj.code === "NOT_FOUND", noProj.code);

  // 대상(.py) — 설치 여부 이중 검증
  const py = await cdp.invoke("lint_file", { projectId: fix.projectId, relPath: "bad.py" });
  if (py.tool === "ruff") {
    r.check("ruff 설치됨: F401 진단(1-based 좌표)", py.diags.some((d) => d.code === "F401" && d.line >= 1 && d.column >= 1), JSON.stringify(py.diags[0]));

    // on-type(버퍼 stdin) 린트 — 저장 안 한 구문 오류가 error 심각도로 잡혀야 한다.
    const buf = "def f(url):\n    return url(x, y=307)f\n";
    const on = await cdp.invoke("lint_file", { projectId: fix.projectId, relPath: "buffer.py", content: buf });
    const syn = on.diags.find((d) => d.code === "invalid-syntax");
    r.check("ruff stdin(버퍼) 구문오류 검출", on.tool === "ruff" && !!syn, JSON.stringify(on.diags[0]));
    r.check("구문오류 severity=error(빨강)", syn?.severity === "error");
  } else {
    r.check("ruff 미설치: tool:null 침묵(오류 없음)", py.tool === null && py.diags.length === 0, JSON.stringify(py));
  }

  // ── 마커 배선(dev) — owner 분리 set/clear ──
  const hasMonaco = await cdp.eval(`!!window.__monaco`);
  if (!hasMonaco) {
    r.skip("린트 마커 배선", "window.__monaco 미노출 — 백엔드만 검증");
    return;
  }
  const wired = await cdp.eval(`(()=>{
    const m = window.__monaco;
    const model = m.editor.createModel('import os\\n', 'python');
    const uri = model.uri.toString();
    m.editor.setModelMarkers(model, 'ruff', [{ startLineNumber:1, startColumn:1, endLineNumber:1, endColumn:3, message:'x', severity: m.MarkerSeverity.Warning, code:'F401' }]);
    m.editor.setModelMarkers(model, 'biome', [{ startLineNumber:1, startColumn:1, endLineNumber:1, endColumn:3, message:'y', severity: m.MarkerSeverity.Error }]);
    const ruff = m.editor.getModelMarkers({ owner:'ruff' }).filter(x=>x.resource.toString()===uri).length;
    const biome = m.editor.getModelMarkers({ owner:'biome' }).filter(x=>x.resource.toString()===uri).length;
    m.editor.setModelMarkers(model, 'ruff', []);
    const ruffAfter = m.editor.getModelMarkers({ owner:'ruff' }).filter(x=>x.resource.toString()===uri).length;
    const biomeAfter = m.editor.getModelMarkers({ owner:'biome' }).filter(x=>x.resource.toString()===uri).length;
    model.dispose();
    return { ruff, biome, ruffAfter, biomeAfter };
  })()`);
  r.check("마커 owner 분리(ruff clear 후 biome 유지)", wired.ruff === 1 && wired.biome === 1 && wired.ruffAfter === 0 && wired.biomeAfter === 1, JSON.stringify(wired));
}
