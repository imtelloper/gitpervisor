// LSP 통합 (태스크 17 M1) — basedpyright 세션·타입 인지 자동완성·정의·수명주기.
// 언어 서버가 관리 디렉토리에 없으면(=npm run fetch-lsp 미실행) skip(러너 의존 명시).
export const name = "LSP 통합 (basedpyright M1)";

export async function run({ cdp, report: r, fix }) {
  // 파이썬 픽스처 — 로컬 심볼 정의 + 타입 인지 자동완성 확인용
  const py = [
    "import os",
    "",
    "def make_greeting(name: str) -> str:",
    "    return 'hi ' + name",
    "",
    "msg = make_greeting('world')",
    "os.",
    "",
  ].join("\n");
  fix.writeFile("lsp_probe.py", py);
  const osLine0 = 6; // 'os.'가 있는 줄(0-based)

  // 서버 설치 여부 확인 — lsp_start를 시도해 ToolNotFound면 skip.
  await cdp.eval(`window.__LT = ${JSON.stringify({ pid: fix.projectId })}`);
  const started = await cdp.eval(`(async () => {
    if (!window.__gpvLsp) return { noExpose: true };
    const s = await window.__gpvLsp.ensureSession(window.__LT.pid, 'py');
    if (!s) return { noServer: true };
    window.__LS = s;
    return { ready: s.ready, root: s.rootPath };
  })()`);

  if (started.noExpose) {
    r.skip("LSP", "window.__gpvLsp 미노출(비-dev 빌드)");
    return;
  }
  if (started.noServer || !started.ready) {
    r.skip("LSP 세션", "언어 서버 미설치 — `npm run fetch-lsp` 후 재실행");
    return;
  }
  r.check("ensureSession + initialize", started.ready === true, JSON.stringify(started).slice(0, 60));

  // didOpen + 인덱싱
  await cdp.eval(`(() => {
    const s = window.__LS;
    window.__URI = window.__gpvLsp.pathToUri(s.rootPath + '/lsp_probe.py');
    s.didOpen(window.__URI, 'python', ${JSON.stringify(py)});
  })()`);
  await new Promise((res) => setTimeout(res, 3000));

  // 타입 인지 자동완성 — os.
  const comp = await cdp.eval(`(async () => {
    const res = await window.__LS.request('textDocument/completion', {
      textDocument: { uri: window.__URI }, position: { line: ${osLine0}, character: 3 },
    }, 8000).catch(() => null);
    const items = Array.isArray(res) ? res : (res && res.items) || [];
    return { count: items.length, labels: items.slice(0, 500).map(i => i.label) };
  })()`);
  const osMembers = ["getcwd", "environ", "path", "getenv"].filter((x) => comp.labels?.includes(x));
  r.check("타입 인지 자동완성(os 멤버 ≥3)", osMembers.length >= 3, `${comp.count}개 → ${osMembers.join(",")}`);

  // 로컬 정의 점프 — make_greeting 사용처(5행) → 정의(3행)
  const def = await cdp.eval(`(async () => {
    const res = await window.__LS.request('textDocument/definition', {
      textDocument: { uri: window.__URI }, position: { line: 5, character: 8 },
    }, 8000).catch(() => null);
    const arr = Array.isArray(res) ? res : (res ? [res] : []);
    const first = arr[0];
    const rng = first ? (first.range || first.targetSelectionRange) : null;
    return { count: arr.length, defLine: rng ? rng.start.line + 1 : null };
  })()`);
  r.check("로컬 심볼 정의 점프(정확한 줄)", def.count > 0 && def.defLine === 3, JSON.stringify(def));

  // 수명주기 — dispose(lsp_stop) 후 세션 해제
  await cdp.eval(`window.__LS.dispose(true)`);
  await new Promise((res) => setTimeout(res, 800));
  const gone = await cdp.eval(`!window.__gpvLsp.lspActive(window.__LT.pid, 'py')`);
  r.check("lsp_stop 후 세션 비활성", gone === true);

  // ── TypeScript(M3) ── typescript-language-server 미설치면 skip.
  const tsCode = [
    "const greeting: string = 'hi'",
    "greeting.",
    "function combine(a: number, b: string): string { return b + a }",
    "const out = combine(1, 'x')",
    "",
  ].join("\n");
  fix.writeFile("lsp_probe.ts", tsCode);
  const ts = await cdp.eval(`(async () => {
    const s = await window.__gpvLsp.ensureSession(window.__LT.pid, 'ts');
    if (!s) return { noServer: true };
    window.__TS = s;
    window.__TURI = window.__gpvLsp.pathToUri(s.rootPath + '/lsp_probe.ts');
    s.didOpen(window.__TURI, 'typescript', ${JSON.stringify(tsCode)});
    return { ready: s.ready };
  })()`);
  if (ts.noServer || !ts.ready) {
    r.skip("LSP TypeScript", "typescript-language-server 미설치 — `npm run fetch-lsp`");
    return;
  }
  await new Promise((res) => setTimeout(res, 4000));
  const tc = await cdp.eval(`(async () => {
    const res = await window.__TS.request('textDocument/completion', {
      textDocument: { uri: window.__TURI }, position: { line: 1, character: 9 },
    }, 8000).catch(() => null);
    const items = Array.isArray(res) ? res : (res && res.items) || [];
    return items.slice(0, 600).map(i => i.label);
  })()`);
  const strM = ["charAt", "toUpperCase", "substring", "trim"].filter((x) => tc?.includes(x));
  r.check("TS 타입 인지 자동완성(string 메서드)", strM.length >= 3, strM.join(","));
  const tsig = await cdp.eval(`(async () => {
    const res = await window.__TS.request('textDocument/signatureHelp', {
      textDocument: { uri: window.__TURI }, position: { line: 4, character: 8 },
    }, 8000).catch(() => null);
    return res && res.signatures && res.signatures.length > 0;
  })()`);
  r.check("TS 시그니처 힌트", tsig === true);

  // rename(M4) — combine → 정의+사용처 WorkspaceEdit
  const ren = await cdp.eval(`(async () => {
    const res = await window.__TS.request('textDocument/rename', {
      textDocument: { uri: window.__TURI }, position: { line: 2, character: 10 }, newName: 'joinValues',
    }, 8000).catch(() => null);
    if (!res) return 0;
    let n = 0;
    if (res.changes) for (const u of Object.keys(res.changes)) n += res.changes[u].length;
    if (res.documentChanges) for (const dc of res.documentChanges) n += (dc.edits || []).length;
    return n;
  })()`);
  r.check("TS rename WorkspaceEdit(정의+사용처 ≥2)", ren >= 2, `${ren} edits`);

  // inlayHint(M4) — 파라미터명/타입 힌트(tsserver preferences로 활성)
  const inlay = await cdp.eval(`(async () => {
    const res = await window.__TS.request('textDocument/inlayHint', {
      textDocument: { uri: window.__TURI },
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
    }, 8000).catch(() => null);
    return Array.isArray(res) ? res.length : 0;
  })()`);
  r.check("TS inlayHint(≥1)", inlay >= 1, `${inlay} hints`);

  await cdp.eval(`window.__TS.dispose(true)`);

  // ── C/C++(clangd) ── 미설치면 skip.
  const cppCode = [
    "struct Widget {",
    "  int width;",
    "  int height;",
    "  int area() const { return width * height; }",
    "};",
    "int main() { Widget w; w.\n  return 0; }",
  ].join("\n");
  fix.writeFile("lsp_probe.cpp", cppCode);
  const cpp = await cdp.eval(`(async () => {
    const s = await window.__gpvLsp.ensureSession(window.__LT.pid, 'cpp');
    if (!s) return { noServer: true };
    window.__CS = s;
    window.__CURI = window.__gpvLsp.pathToUri(s.rootPath + '/lsp_probe.cpp');
    s.didOpen(window.__CURI, 'cpp', ${JSON.stringify(cppCode)});
    return { ready: s.ready };
  })()`);
  if (cpp.noServer || !cpp.ready) {
    r.skip("LSP C/C++", "clangd 미설치 — `npm run fetch-lsp`");
    return;
  }
  await new Promise((res) => setTimeout(res, 4000));
  const cc = await cdp.eval(`(async () => {
    const res = await window.__CS.request('textDocument/completion', {
      textDocument: { uri: window.__CURI }, position: { line: 5, character: 25 },
    }, 8000).catch(() => null);
    const items = Array.isArray(res) ? res : (res && res.items) || [];
    return items.slice(0, 400).map(i => (i.label || '').trim().replace(/[()].*/, ''));
  })()`);
  const cm = ["width", "height", "area"].filter((m) => cc?.includes(m));
  r.check("C++ 타입 인지 자동완성(Widget 멤버)", cm.length >= 3, cm.join(","));
  await cdp.eval(`window.__CS.dispose(true)`);
}
