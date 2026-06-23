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
}
