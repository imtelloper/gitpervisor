// pdf.js 정적 자산을 public/pdfjs로 복사한다(predev/prebuild 훅). 워커가 cMap·표준 폰트·
// nowasm 디코더를 URL로 fetch/import 하므로 번들이 아니라 정적 경로로 서빙해야 한다.
// .wasm·iccs는 복사하지 않는다 — getDocument를 useWasm:false로 부르므로 JS 폴백만 쓴다.
import { cpSync, mkdirSync, rmSync } from "node:fs";

const src = new URL("../node_modules/pdfjs-dist/", import.meta.url);
const dest = new URL("../public/pdfjs/", import.meta.url);

rmSync(dest, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts"]) {
  cpSync(new URL(`${dir}/`, src), new URL(`${dir}/`, dest), { recursive: true });
}
mkdirSync(new URL("wasm/", dest), { recursive: true });
for (const f of ["openjpeg_nowasm_fallback.js", "jbig2_nowasm_fallback.js"]) {
  cpSync(new URL(`wasm/${f}`, src), new URL(`wasm/${f}`, dest));
}
