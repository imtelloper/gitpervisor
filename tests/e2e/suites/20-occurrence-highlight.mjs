// 같은 심볼 하이라이트 (occurrence highlight) — 파이썬 음영은 monaco 0.55 내장 텍스트 폴백
// provider('*')가 제공한다. 이 스위트는 그 동작을 회귀 고정한다: 내장 폴백이 monaco 업그레이드로
// 사라지거나(파이썬 음영 소실) 테마 색이 기본 회색으로 되돌아가면 즉시 실패한다.
// dev 노출 window.__monaco(monaco-setup.ts)로 오프스크린 에디터를 만들어 데코레이션을 판독한다.
export const name = "같은 심볼 하이라이트 (occurrence highlight)";

export async function run({ cdp, report: r }) {
  const has = await cdp.eval(`!!window.__monaco`);
  if (!has) {
    r.skip("occurrence highlight", "window.__monaco 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  // 오프스크린 파이썬 에디터에서 'foo'(4회 등장) 위에 커서를 놓고 wordHighlight 데코의
  // 서로 다른 range 개수를 센다. 데코 총개수(내부 이중 데코로 ×2)가 아니라 range 수로 판정.
  const probe = (readOnly) =>
    cdp.eval(`(async ()=>{
      const m = window.__monaco;
      const src = ['def foo(x):','    y = foo(x)','    z = foo(y)','    return foo(z)',''].join('\\n');
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-9999px;top:0;width:800px;height:400px';
      document.body.appendChild(host);
      const model = m.editor.createModel(src, 'python');
      const ed = m.editor.create(host, { model, readOnly: ${readOnly} });
      ed.focus();
      ed.setPosition({ lineNumber: 1, column: 6 }); // 'foo'의 f 근처
      let ranges = [];
      for (let i = 0; i < 25; i++) {
        await new Promise((res) => setTimeout(res, 100));
        const decos = model.getAllDecorations().filter((d) => /wordHighlight/.test(d.options.className || ''));
        ranges = [...new Set(decos.map((d) => d.range.startLineNumber + ':' + d.range.startColumn))];
        if (ranges.length >= 4) break;
      }
      const node = ed.getDomNode();
      const color = node
        ? getComputedStyle(node).getPropertyValue('--vscode-editor-wordHighlightTextBackground').trim()
        : null;
      ed.dispose(); model.dispose(); host.remove();
      return { ranges, color };
    })()`);

  const file = await probe(false);
  r.check(
    "파일뷰: 파이썬 'foo' 4곳 음영(내장 텍스트 폴백)",
    Array.isArray(file?.ranges) && file.ranges.length >= 4,
    `ranges=${JSON.stringify(file?.ranges)}`,
  );

  const diff = await probe(true);
  r.check(
    "diff뷰(readOnly): 파이썬 'foo' 4곳 음영",
    Array.isArray(diff?.ranges) && diff.ranges.length >= 4,
    `ranges=${JSON.stringify(diff?.ranges)}`,
  );

  // 테마 색 정의 회귀 — 기본 회색 rgba(87,87,87,…)이 아니라 우리 테마의 저알파 색이어야 한다.
  r.check(
    "테마 wordHighlight 색 정의됨(기본 회색 아님)",
    !!file?.color && !/\b87,\s*87,\s*87\b/.test(file.color),
    `css=${file?.color}`,
  );
}
