// 포매터 (format_source / format_tool_status) — 러너 발견·미설치 UX·경로 검증 + Monaco 배선.
// 실제 포맷은 ruff/biome 설치 시에만 검증(게이트). 미설치 환경에선 TOOL_NOT_FOUND 경로를 단언.
export const name = "포매터 (format_source / 러너 계약)";

export async function run({ cdp, report: r, fix }) {
  const status = await cdp.invoke("format_tool_status", { projectId: fix.projectId });
  r.check("format_tool_status: ruff+biome 상태 반환", Array.isArray(status) && status.length === 2 && status.every((s) => typeof s.found === "boolean"), JSON.stringify(status.map((s) => `${s.tool}=${s.found}`)));

  // 미지원 확장자 → changed:false
  const md = await cdp.invoke("format_source", { projectId: fix.projectId, relPath: "README.md", content: "# hi\n" });
  r.check("미지원 확장자 → changed:false", md.changed === false && md.formatted === null, JSON.stringify(md));

  // 경로 traversal 거부
  const trav = await cdp.try("format_source", { projectId: fix.projectId, relPath: "../outside.py", content: "x=1\n" });
  r.check("../ 경로 거부", !trav.ok, trav.code);

  // 없는 프로젝트
  const noProj = await cdp.try("format_source", { projectId: "no-such", relPath: "a.py", content: "x=1\n" });
  r.check("없는 프로젝트 → NOT_FOUND", !noProj.ok && noProj.code === "NOT_FOUND", noProj.code);

  const ruff = status.find((s) => s.tool === "ruff");
  const biome = status.find((s) => s.tool === "biome");

  if (!ruff.found && !biome.found) {
    // 미설치 환경 — TOOL_NOT_FOUND 경로 단언 후 실제 포맷은 스킵
    const py = await cdp.try("format_source", { projectId: fix.projectId, relPath: "a.py", content: "x=1\n" });
    r.check(".py(ruff 미설치) → TOOL_NOT_FOUND", !py.ok && py.code === "TOOL_NOT_FOUND", py.code);
    r.skip("실제 포맷 변환", "ruff/biome 미설치 — 설치 시 멱등성·정규형 검증");
  } else {
    // ruff 설치 시 — 어질러진 py를 정규형으로, 멱등성
    if (ruff.found) {
      const messy = "def  f( a,b ):\n  return  a+b\n";
      const f1 = await cdp.invoke("format_source", { projectId: fix.projectId, relPath: "a.py", content: messy });
      r.check("ruff: 어질러진 py 포맷됨(changed)", f1.changed === true && typeof f1.formatted === "string", JSON.stringify(f1).slice(0, 60));
      if (f1.formatted != null) {
        const f2 = await cdp.invoke("format_source", { projectId: fix.projectId, relPath: "a.py", content: f1.formatted });
        r.check("ruff: 멱등성(2회째 changed:false)", f2.changed === false, JSON.stringify(f2));
      }
    }
    if (biome.found) {
      const messy = "const   x={a:1,b:2}\n";
      const f1 = await cdp.invoke("format_source", { projectId: fix.projectId, relPath: "a.ts", content: messy });
      r.check("biome: 어질러진 ts 포맷됨", f1.changed === true, JSON.stringify(f1).slice(0, 60));
    }
  }

  // ── Monaco provider 배선(dev) ──
  const hasMonaco = await cdp.eval(`!!window.__gpv && !!window.__monaco`);
  if (!hasMonaco) {
    r.skip("포맷 provider 배선", "window.__monaco 미노출 — 백엔드만 검증");
    return;
  }
  // provider가 python/typescript/json/css에 등록됐는지 — formatDocument 액션 활성(오프스크린 에디터)
  const wired = await cdp.eval(`(()=>{
    const m=window.__monaco;
    const host=document.createElement('div'); host.style.cssText='position:absolute;left:-9999px;width:400px;height:200px';
    document.body.appendChild(host);
    const model=m.editor.createModel('x=1\\n','python');
    const ed=m.editor.create(host,{model});
    const has=!!ed.getAction('editor.action.formatDocument');
    ed.dispose(); model.dispose(); host.remove();
    return has;
  })()`);
  r.check("DocumentFormattingProvider 등록(python formatDocument 활성)", wired === true);
}
