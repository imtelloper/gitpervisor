// 코드 정의 점프 — find_definition (git grep -P 휴리스틱). 픽스처에 정의 파일을 만들어 검색.
export const name = "코드 정의 점프 (find_definition)";

export async function run({ cdp, report: r, fix }) {
  // 정의가 든 TS 파일 생성 — untracked 라도 git grep --untracked 가 잡는다.
  fix.writeFile(
    "defs.ts",
    [
      "export function gpvFunc(x) { return x; }",
      "export const gpvVar = 1;",
      "export interface GpvIface { n: number; }",
      "export class GpvClass {}",
      "",
    ].join("\n"),
  );

  // ── 함수 정의 ──
  const fn = await cdp.invoke("find_definition", { projectId: fix.projectId, symbol: "gpvFunc", ext: "ts" });
  r.check("find_definition: 함수 정의 발견(defs.ts)", Array.isArray(fn) && fn.some((m) => m.path === "defs.ts"), JSON.stringify(fn?.[0]));
  const fm = (fn || []).find((m) => m.path === "defs.ts");
  r.check("find_definition: line/column 1-based", (fm?.line || 0) >= 1 && (fm?.column || 0) >= 1, `${fm?.line}:${fm?.column}`);
  r.check("find_definition: signature 에 심볼 포함", /gpvFunc/.test(fm?.signature || ""), fm?.signature);

  // ── interface 정의 ──
  const iface = await cdp.invoke("find_definition", { projectId: fix.projectId, symbol: "GpvIface", ext: "ts" });
  r.check("find_definition: interface 정의 발견", Array.isArray(iface) && iface.some((m) => m.path === "defs.ts" && /GpvIface/.test(m.signature || "")));

  // ── 없는 심볼 → 빈 배열 ──
  const none = await cdp.invoke("find_definition", { projectId: fix.projectId, symbol: "noSuchSymbolXyz123", ext: "ts" });
  r.check("find_definition: 없는 심볼 → 빈 결과", Array.isArray(none) && none.length === 0, `len=${none?.length}`);

  // ── 잘못된 심볼(특수문자) → 빈 배열(패턴 인젝션 방지) ──
  const invalid = await cdp.invoke("find_definition", { projectId: fix.projectId, symbol: "bad-symbol!", ext: "ts" });
  r.check("find_definition: 잘못된 심볼 거부 → 빈 결과", Array.isArray(invalid) && invalid.length === 0);

  // ── 없는 프로젝트 → NOT_FOUND ──
  const bad = await cdp.try("find_definition", { projectId: "no-such-project-id", symbol: "x", ext: "ts" });
  r.check("find_definition: 없는 프로젝트 → NOT_FOUND", !bad.ok && bad.code === "NOT_FOUND", bad.code || "(ok?)");

  // ── 문서 추출 (독스트링/JSDoc/`///`) — 태스크 14 ──
  const find = (sym, ext) => cdp.invoke("find_definition", { projectId: fix.projectId, symbol: sym, ext });
  const docOf = (arr, path) => (arr || []).find((m) => m.path === path)?.doc;

  // 파이썬: 여러 줄 독스트링 / 한 줄 / 없음
  fix.writeFile("docs.py", [
    "def documented(a, b):",
    '    """Adds a and b together.',
    "",
    "    Returns the sum.",
    '    """',
    "    return a + b",
    "",
    "def oneliner():",
    '    """One line doc."""',
    "    return 1",
    "",
    "def plain():",
    "    return 1",
    "",
  ].join("\n"));
  const pyDoc = docOf(await find("documented", "py"), "docs.py");
  r.check("doc(py): 독스트링 본문 포함", /Adds a and b together/.test(pyDoc || "") && /Returns the sum/.test(pyDoc || ""), pyDoc);
  r.check("doc(py): 삼중따옴표 마커 제거", !!pyDoc && !/"""/.test(pyDoc), pyDoc);
  r.check("doc(py): 한 줄 독스트링", /One line doc/.test(docOf(await find("oneliner", "py"), "docs.py") || ""));
  r.check("doc(py): 독스트링 없으면 doc 부재", docOf(await find("plain", "py"), "docs.py") === undefined);

  // TS: JSDoc 있음/없음
  fix.writeFile("docs2.ts", [
    "/**",
    " * Formats a name nicely.",
    " * @param name the input",
    " */",
    "export function formatName(name) { return name; }",
    "",
    "export function noDoc(x) { return x; }",
    "",
  ].join("\n"));
  const tsDoc = docOf(await find("formatName", "ts"), "docs2.ts");
  r.check("doc(ts): JSDoc 본문 포함", /Formats a name nicely/.test(tsDoc || "") && /@param name/.test(tsDoc || ""), tsDoc);
  r.check("doc(ts): JSDoc 마커 제거", !!tsDoc && !/\/\*\*|\*\//.test(tsDoc) && !/^\s*\*/m.test(tsDoc), tsDoc);
  r.check("doc(ts): JSDoc 없으면 doc 부재", docOf(await find("noDoc", "ts"), "docs2.ts") === undefined);

  // Rust: `///` 연속 + 속성(#[derive]) 사이
  fix.writeFile("docs.rs", [
    "/// A widget that does things.",
    "/// Second line.",
    "#[derive(Debug)]",
    "pub struct Widget { pub n: u32 }",
    "",
  ].join("\n"));
  const rsDoc = docOf(await find("Widget", "rs"), "docs.rs");
  r.check("doc(rs): /// 본문 포함(속성 건너뜀)", /A widget that does things/.test(rsDoc || "") && /Second line/.test(rsDoc || ""), rsDoc);
  r.check("doc(rs): /// 마커 제거", !!rsDoc && !/\/\/\//.test(rsDoc), rsDoc);

  // 장문 독스트링 → 12줄/800자 캡 + …
  fix.writeFile("long.py", [
    "def big():", '    """',
    ...Array.from({ length: 30 }, (_, i) => `    line number ${i}`),
    '    """', "    return 1", "",
  ].join("\n"));
  const longDoc = docOf(await find("big", "py"), "long.py");
  r.check("doc(py): 장문 12줄 캡 + …", (longDoc || "").split("\n").length <= 13 && /…$/.test(longDoc || ""), (longDoc || "").slice(-24));
}
