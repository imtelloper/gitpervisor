// 지정한 파일에 남은 한국어 UI 문구를 줄 단위로 보여 준다(e2e 66 과 같은 스캐너) — 이관 작업 중 확인용.
// 사용: node scripts/i18n-remaining.mjs src/components/a.tsx src/components/b.tsx
import { readFileSync } from "node:fs";

import { scanHangulFiles } from "../tests/e2e/lib/i18n-scan.mjs";

const want = process.argv.slice(2).map((p) => p.split("\\").join("/"));
const found = scanHangulFiles(process.cwd());
let total = 0;
for (const file of want) {
  const lines = found.get(file);
  if (!lines) continue;
  const src = readFileSync(file, "utf8").split("\n");
  for (const n of lines) console.log(`${file}:${n}: ${src[n - 1].trim()}`);
  total += lines.length;
}
console.log(`남은 한국어 줄: ${total}`);
