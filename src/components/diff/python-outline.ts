// 파이썬 아웃라인 — DocumentSymbolProvider. 정규식+들여쓰기 라인 스캐너로 def/class 트리를
// 만든다(파이썬은 오프사이드 규칙이라 스코프=들여쓰기, 끝줄 계산에 들여쓰기 분석이 필수).
// provider 하나 등록으로 스티키 스크롤 정확도·구조 팝업(mod+Shift+O)·diff 접힘 브레드크럼이
// 코드 추가 없이 살아난다(TS/JS는 워커가 이미 제공 — 파이썬만 공백이었다). 백엔드 0.
import { monaco } from "./monaco-setup";

const SK = monaco.languages.SymbolKind;

export interface PySymbol {
  name: string;
  kind: monaco.languages.SymbolKind; // Class(4)|Method(5)|Constructor(8)|Function(11)
  startLine: number; // 1-based, def/class 줄
  nameColumn: number; // selectionRange용 이름 시작 열(1-based)
  endLine: number; // 스코프 마지막 줄(트레일링 빈 줄 제외)
  children: PySymbol[];
}

interface Frame {
  indent: number;
  sym: PySymbol;
  isClass: boolean;
}

const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)/;

/**
 * 한 줄을 스캔해 (줄 끝 삼중따옴표 상태, 괄호 깊이 변화)를 돌려준다.
 * 문자열(단·삼중)·주석 안의 괄호/키워드는 제외 — 다중행 시그니처·문자열 속 def 오탐 방지.
 */
function scanLine(
  line: string,
  triple: string | null,
): { triple: string | null; depthDelta: number } {
  let i = 0;
  let depthDelta = 0;
  let q: string | null = null; // 단일행 따옴표 상태
  const n = line.length;
  while (i < n) {
    if (triple) {
      if (line.startsWith(triple, i)) {
        triple = null;
        i += 3;
      } else i++;
      continue;
    }
    if (q) {
      if (line[i] === "\\") {
        i += 2;
        continue;
      }
      if (line[i] === q) q = null;
      i++;
      continue;
    }
    const c = line[i];
    if (c === "#") break; // 줄 끝까지 주석
    if (line.startsWith('"""', i)) {
      triple = '"""';
      i += 3;
      continue;
    }
    if (line.startsWith("'''", i)) {
      triple = "'''";
      i += 3;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depthDelta++;
    else if (c === ")" || c === "]" || c === "}") depthDelta--;
    i++;
  }
  return { triple, depthDelta };
}

/** 파이썬 소스에서 def/class 심볼 트리를 뽑는다(순수 함수 — E2E가 직접 단언). */
export function parsePythonSymbols(text: string): PySymbol[] {
  const lines = text.split(/\r?\n/);
  const roots: PySymbol[] = [];
  const stack: Frame[] = [];
  let triple: string | null = null;
  let depth = 0; // 다중행 시그니처 감지용 괄호 깊이(줄 경계 넘어 누적)
  let prevCode = 0; // 1-based 마지막 구조/내용 줄(트레일링 빈 줄 제외)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startInTriple = triple !== null;
    const startDepth = depth;
    const res = scanLine(line, triple);
    triple = res.triple;

    if (startInTriple) {
      // 삼중따옴표 문자열 내용 — 감싸는 블록의 일부라 endLine을 늘린다(구조 판정엔 불참).
      prevCode = i + 1;
      depth += res.depthDelta;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      depth += res.depthDelta;
      continue; // 빈 줄·주석은 prevCode 미갱신(트레일링 배제)
    }

    if (startDepth === 0) {
      const indent = line.length - line.trimStart().length;
      // 들여쓰기가 같거나 얕아진 심볼들은 여기서 끝났다 — pop하며 endLine 확정
      while (stack.length && indent <= stack[stack.length - 1].indent) {
        stack.pop()!.sym.endLine = prevCode;
      }
      const md = DEF_RE.exec(line);
      const mc = md ? null : CLASS_RE.exec(line);
      const m = md ?? mc;
      if (m) {
        const isClass = !!mc;
        const name = m[2];
        const parent = stack.length ? stack[stack.length - 1] : null;
        const kind = isClass
          ? SK.Class
          : parent?.isClass
            ? name === "__init__"
              ? SK.Constructor
              : SK.Method
            : SK.Function;
        const nameColumn = line.indexOf(name, m[1].length) + 1;
        const sym: PySymbol = {
          name,
          kind,
          startLine: i + 1,
          nameColumn,
          endLine: i + 1,
          children: [],
        };
        if (parent) parent.sym.children.push(sym);
        else roots.push(sym);
        stack.push({ indent, sym, isClass });
      }
    }
    prevCode = i + 1;
    depth += res.depthDelta;
    if (depth < 0) depth = 0;
  }
  while (stack.length) stack.pop()!.sym.endLine = prevCode;
  return roots;
}

function toDocSymbol(
  model: monaco.editor.ITextModel,
  s: PySymbol,
): monaco.languages.DocumentSymbol {
  const endLine = Math.min(s.endLine, model.getLineCount());
  return {
    name: s.name,
    detail: "",
    kind: s.kind,
    tags: [],
    range: new monaco.Range(s.startLine, 1, endLine, model.getLineMaxColumn(endLine)),
    selectionRange: new monaco.Range(
      s.startLine,
      s.nameColumn,
      s.startLine,
      s.nameColumn + s.name.length,
    ),
    children: s.children.map((c) => toDocSymbol(model, c)),
  };
}

let registered = false;
/** DocumentSymbolProvider 1회 등록(goto-definition.ts registered 가드 미러). "python"에만. */
export function registerPythonOutline(): void {
  if (registered) return;
  registered = true;
  // versionId 캐시 — 소비자(sticky 300ms·breadcrumb 100ms·quickOutline)가 같은 버전을
  // 다른 타이밍에 조회할 때의 중복 파싱만 막는다(자체 디바운스는 소비자가 이미 함).
  let cache: { key: string; symbols: PySymbol[] } = { key: "", symbols: [] };
  monaco.languages.registerDocumentSymbolProvider("python", {
    displayName: "gitpervisor-python",
    provideDocumentSymbols(model) {
      const key = model.uri.toString() + ":" + model.getVersionId();
      if (cache.key !== key) cache = { key, symbols: parsePythonSymbols(model.getValue()) };
      return cache.symbols.map((s) => toDocSymbol(model, s));
    },
  });
}

// dev 전용 노출(E2E) — monaco-setup.ts __monaco 패턴 미러. release 미포함.
if (import.meta.env.DEV)
  (window as unknown as { __gpvPyOutline?: typeof parsePythonSymbols }).__gpvPyOutline =
    parsePythonSymbols;
