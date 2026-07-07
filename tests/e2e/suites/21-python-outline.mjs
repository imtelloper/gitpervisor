// 파이썬 아웃라인 (DocumentSymbolProvider) — 파서 단위 단언 + 구조 팝업(quickOutline) 통합.
// 파서는 dev 노출 window.__gpvPyOutline(python-outline.ts), 팝업은 window.__monaco로 검증한다.
export const name = "파이썬 아웃라인 (구조 팝업 / DocumentSymbol)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ cdp, report: r }) {
  const has = await cdp.eval(`!!window.__gpvPyOutline && !!window.__monaco`);
  if (!has) {
    r.skip("파이썬 아웃라인", "window.__gpvPyOutline/__monaco 미노출(dev 아님) — 스킵");
    return;
  }

  // ── 파서 단위: 중첩·kind·독스트링 가짜 def 미검출·다중행 시그니처 endLine ──
  const parse = await cdp.eval(`(()=>{
    const src = [
      'import os','',
      '@decorator','class Foo:',
      '    """docstring with fake:','    def not_a_method(): pass','    """',
      '    def __init__(self):','        self.x = 1',
      '    async def run(self, a,','                  b):','        return a + b','',
      'def top_level():','    return 1',''
    ].join('\\n');
    return window.__gpvPyOutline(src).map(s => ({ name:s.name, kind:s.kind, start:s.startLine, end:s.endLine,
      children: s.children.map(c => ({ name:c.name, kind:c.kind, start:c.startLine, end:c.endLine })) }));
  })()`);
  const foo = parse.find((s) => s.name === "Foo");
  const top = parse.find((s) => s.name === "top_level");
  r.check("파서: class → Class(4) + 중첩 자식 2", foo?.kind === 4 && foo?.children.length === 2, JSON.stringify(foo));
  r.check("파서: __init__ → Constructor(8), 메서드 → Method(5)",
    foo?.children[0]?.name === "__init__" && foo.children[0].kind === 8 &&
    foo?.children[1]?.name === "run" && foo.children[1].kind === 5);
  r.check("파서: 독스트링 속 가짜 def 미검출",
    !parse.some((s) => s.name === "not_a_method") && !foo?.children.some((c) => c.name === "not_a_method"));
  r.check("파서: 최상위 함수 → Function(11)", top?.kind === 11);
  r.check("파서: 다중행 시그니처 endLine 포함(run.end≥12)", (foo?.children.find((c) => c.name === "run")?.end || 0) >= 12);

  // ── 구조 팝업(quickOutline) 통합 — 파이썬 모델 오프스크린 에디터로 격리 검증 ──
  const popup = await cdp.eval(`(async ()=>{
    const m = window.__monaco;
    const src = ['class Alpha:','    def method_one(self):','        return 1','','def beta_func():','    return 2',''].join('\\n');
    const host = document.createElement('div');
    host.style.cssText='position:absolute;left:0;top:0;width:700px;height:400px;z-index:99999';
    document.body.appendChild(host);
    const model = m.editor.createModel(src, 'python');
    const ed = m.editor.create(host, { model });
    ed.focus();
    const act = ed.getAction('editor.action.quickOutline');
    const hasAction = !!act;
    let visible = false, rows = [];
    if (act) {
      await act.run();
      await new Promise(r=>setTimeout(r,600));
      const w = document.querySelector('.quick-input-widget');
      visible = !!(w && w.getBoundingClientRect().width > 0 && getComputedStyle(w).display !== 'none');
      rows = w ? [...w.querySelectorAll('.monaco-list-row')].map(x=>x.textContent.trim()).slice(0,10) : [];
      // 닫기
      ed.focus();
      const ta = host.querySelector('textarea');
      if (ta) ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,bubbles:true}));
    }
    ed.dispose(); model.dispose(); host.remove();
    return { hasAction, visible, rows };
  })()`);
  r.check("quickOutline 액션 활성(provider precondition 통과)", popup.hasAction === true);
  r.check("구조 팝업 표시 + 심볼 나열", popup.visible === true && popup.rows.some((t) => /Alpha/.test(t)) && popup.rows.some((t) => /method_one/.test(t)) && popup.rows.some((t) => /beta_func/.test(t)), JSON.stringify(popup.rows));

  // 팝업 잔재 정리(다른 스위트 오염 방지)
  await cdp.eval(`(()=>{ const w=document.querySelector('.quick-input-widget'); if(w){ document.body.click(); } })()`).catch(() => {});
  await sleep(100);
}
