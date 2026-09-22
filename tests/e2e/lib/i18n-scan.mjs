// 소스에 남은 한국어 UI 문구 스캐너(DOCS/i18n-design.md §5.2) — e2e 66 과 기준 목록 생성이 같은 함수를 쓴다.
//
// 판정 단위는 **파일**이다: 주석을 걷어낸 코드에 한글이 한 글자라도 있으면 "아직 이행 안 된 파일".
// 문자열·템플릿·JSX 텍스트·속성 값을 따로 가르지 않는다 — 가르는 규칙이 틀리면 이행 끝난 파일이 정의상
// 0 으로 나온다(결함이 있어도 통과하는 단언). 정규식 리터럴 속 한글처럼 UI 가 아닌 줄은 그 줄 끝에
// `// i18n-ok: <이유>` 를 달아 뺀다.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const HANGUL = /[\uac00-\ud7a3]/;
const EXEMPT_MARK = "i18n-ok:";
/**
 * \ub85c\uadf8\ub294 \ubc88\uc5ed\ud558\uc9c0 \uc54a\ub294\ub2e4(\uc124\uacc4 \u00a71) \u2014 \ud55c \uc904\uc9dc\ub9ac \ub85c\uadf8 \ud638\ucd9c\uc740 \uc790\ub3d9\uc73c\ub85c \ube80\ub2e4. \uc5ec\ub7ec \uc904\uc5d0 \uac78\uce5c \ub85c\uadf8\ub294 \ud55c\uae00\uc774
 * \uc788\ub294 \uc904\uc5d0 `// i18n-ok: \ub85c\uadf8`\ub97c \ub2e8\ub2e4(\uc790\ub3d9 \ud310\uc815\uc744 \ub113\ud788\uba74 \uc0ac\uc6a9\uc790\uc5d0\uac8c \ubcf4\uc774\ub294 \ubb38\uad6c\uae4c\uc9c0 \ube60\uc9c8 \uc218 \uc788\ub2e4).
 */
const LOG_CALL = /\b(?:console\.(?:log|warn|error|info|debug)|log(?:Info|Warn|Error|Debug|Trace))\(/;

/** 카탈로그 자체 — 한국어 원문이 사는 곳이라 영구히 허용한다. */
export function isCatalogFile(rel) {
  return /^src\/i18n\/text-[a-z0-9-]+\.ts$/.test(rel);
}

/** 주석을 공백으로 바꾼다(줄 번호 보존). 문자열·템플릿 안의 `//`·`/*`는 건드리지 않는다. */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const j = src.indexOf("\n", i);
      const end = j < 0 ? n : j;
      out += blank(src.slice(i, end));
      i = end;
    } else if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? n : j + 2;
      out += blank(src.slice(i, end));
      i = end;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

/**
 * `src/` 전체를 훑어 한글이 남은 파일(카탈로그 제외)과 그 줄 번호를 돌려준다.
 * @returns {Map<string, number[]>} repo 상대경로(슬래시) → 한글 줄 번호(1부터)
 */
export function scanHangulFiles(repoRoot) {
  const found = new Map();
  for (const abs of walk(join(repoRoot, "src"))) {
    const rel = relative(repoRoot, abs).split("\\").join("/");
    if (isCatalogFile(rel)) continue;
    const raw = readFileSync(abs, "utf8");
    const rawLines = raw.split("\n");
    const code = stripComments(raw).split("\n");
    const lines = [];
    code.forEach((l, idx) => {
      if (HANGUL.test(l) && !rawLines[idx].includes(EXEMPT_MARK) && !LOG_CALL.test(l))
        lines.push(idx + 1);
    });
    if (lines.length) found.set(rel, lines);
  }
  return found;
}

/**
 * `msg[…]`·`useMessages()[…]`·`currentMessages()[…]` — 카탈로그를 조립한 키로 여는 곳(호출처가 검색에서
 * 사라진다). 이름을 `msg` 로 통일해 두었기에 잡을 수 있다 — `messages[…]`(채팅 배열 등)는 잡지 않는다.
 */
export function scanDynamicCatalogAccess(repoRoot) {
  const hits = [];
  const pattern = /\bmsg\[|\b(?:useMessages|currentMessages)\(\)\[/;
  for (const abs of walk(join(repoRoot, "src"))) {
    const rel = relative(repoRoot, abs).split("\\").join("/");
    stripComments(readFileSync(abs, "utf8"))
      .split("\n")
      .forEach((l, idx) => {
        if (pattern.test(l)) hits.push(`${rel}:${idx + 1}`);
      });
  }
  return hits;
}
