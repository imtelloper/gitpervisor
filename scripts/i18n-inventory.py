"""다국어 이행 인벤토리(DOCS/i18n-design.md §2) — 사용자에게 보이는 한글 문구가 어디에 몇 개 있는가(주석 제외, 근사치).

사용: PYTHONIOENCODING=utf-8 python scripts/i18n-inventory.py — 단계마다 다시 돌려 진척을 잰다.
"""
import os, re, sys, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HANGUL = re.compile(r"[\uac00-\ud7a3]")

def strip_ts_comments(src: str) -> str:
    # 문자열 안의 // 를 지우지 않도록 토큰 단위로 걷는다(근사: 정규식 리터럴은 무시).
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i); i = n if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2
        elif c in "'\"`":
            q, j = c, i + 1
            while j < n and src[j] != q:
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1]); i = j + 1
        else:
            out.append(c); i += 1
    return "".join(out)

def strip_rs_comments(src: str) -> str:
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i); i = n if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2
        elif c == '"':
            j = i + 1
            while j < n and src[j] != '"':
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1]); i = j + 1
        else:
            out.append(c); i += 1
    return "".join(out)

def walk(base, exts):
    for d, _, fs in os.walk(base):
        if "node_modules" in d or "target" in d:
            continue
        for f in fs:
            if f.endswith(exts):
                yield os.path.join(d, f)

# ── 프론트엔드 ──
fe_lines = collections.Counter()
fe_literals = set()
TS_STR = re.compile(r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`")
JSX_TEXT = re.compile(r">([^<>{}]*[\uac00-\ud7a3][^<>{}]*)<")
for p in walk(f"{ROOT}/src", (".ts", ".tsx")):
    code = strip_ts_comments(open(p, encoding="utf-8").read())
    rel = os.path.relpath(p, ROOT).replace("\\", "/")
    n = sum(1 for l in code.splitlines() if HANGUL.search(l))
    if n:
        fe_lines[rel] = n
    for m in TS_STR.finditer(code):
        if HANGUL.search(m.group()):
            fe_literals.add(m.group()[1:-1].strip())
    for m in JSX_TEXT.finditer(code):
        fe_literals.add(m.group(1).strip())

# ── Rust ──
rs_lines = collections.Counter()
rs_cat = collections.Counter()
RS_STR = re.compile(r'"(?:[^"\\]|\\.)*"')
for p in walk(f"{ROOT}/src-tauri/src", (".rs",)):
    raw = open(p, encoding="utf-8").read()
    # 테스트 모듈은 뺀다(근사: #[cfg(test)] 이후 전부)
    cut = raw.find("#[cfg(test)]")
    body = raw if cut < 0 else raw[:cut]
    code = strip_rs_comments(body)
    rel = os.path.relpath(p, ROOT).replace("\\", "/")
    for line in code.splitlines():
        if not HANGUL.search(line):
            continue
        rs_lines[rel] += 1
        if re.search(r"log::(info|warn|error|debug|trace)!|eprintln!|println!", line):
            rs_cat["로그(번역 대상 아님)"] += 1
        elif "IpcError" in line or re.search(r"\bio\(|\bio_err|\berr\(|map_err", line):
            rs_cat["IPC 오류 메시지"] += 1
        else:
            rs_cat["기타 사용자 노출 가능(사유 문구·알림·format!)"] += 1

# ── e2e ──
e2e_suites = collections.Counter()
E2E_ASSERT = re.compile(r"(includes|textContent|innerText|startsWith|endsWith|===|match)\s*\(?[^\n]{0,80}[\uac00-\ud7a3]")
for p in walk(f"{ROOT}/tests/e2e/suites", (".mjs",)):
    code = strip_ts_comments(open(p, encoding="utf-8").read())
    rel = os.path.basename(p)
    for line in code.splitlines():
        # r.check("…한글 설명…") 은 결과 라벨이라 제외 — UI 문구를 **기대**하는 줄만 센다
        if "r.check(" in line and line.count('"') <= 2:
            continue
        if E2E_ASSERT.search(line):
            e2e_suites[rel] += 1

print(f"프론트: 파일 {len(fe_lines)}개 / 한글 코드 줄 {sum(fe_lines.values())} / 고유 한글 문구 ~{len(fe_literals)}")
print("  상위:", ", ".join(f"{k}({v})" for k, v in fe_lines.most_common(15)))
by_dir = collections.Counter()
for k, v in fe_lines.items():
    parts = k.split("/")
    by_dir["/".join(parts[:3]) if parts[1] == "components" else "/".join(parts[:2])] += v
print("  디렉터리별:", ", ".join(f"{k}({v})" for k, v in by_dir.most_common(20)))
print(f"Rust(테스트 제외): 파일 {len(rs_lines)}개 / 한글 줄 {sum(rs_lines.values())}")
for k, v in rs_cat.most_common():
    print(f"  {k}: {v}")
print("  상위:", ", ".join(f"{k}({v})" for k, v in rs_lines.most_common(12)))
print(f"e2e: 한글 UI 문구를 기대하는 줄 {sum(e2e_suites.values())} / 스위트 {len(e2e_suites)}개")
print("  상위:", ", ".join(f"{k}({v})" for k, v in e2e_suites.most_common(10)))
