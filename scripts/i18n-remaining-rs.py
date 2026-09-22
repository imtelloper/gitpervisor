"""Rust 파일에 남은 사용자 노출 한국어를 줄 단위로 보여 준다(DOCS/i18n-design.md §4.4) — 이관 확인용.

주석·`#[cfg(test)]` 이후·로그 매크로(log::*!, eprintln!, println!)·줄 끝 `// i18n-ok: <이유>` 는 뺀다.
사용: PYTHONIOENCODING=utf-8 python scripts/i18n-remaining-rs.py src-tauri/src/db.rs src-tauri/src/commands/tree.rs
"""
import re
import sys

HANGUL = re.compile(r"[가-힣]")
LOG = re.compile(r"log::(info|warn|error|debug|trace)!|eprintln!|println!")


def strip_comments(src: str) -> str:
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", src[i:j]))
            i = j
        elif src.startswith("'\"'", i) or src.startswith("'\\\"'", i):
            # 문자 리터럴 '"'·'\"' — 문자열 시작으로 읽으면 이후 주석/문자열 판정이 통째로 뒤집힌다.
            j = src.index("'", i + 1) + 1
            out.append(src[i:j])
            i = j
        elif c == '"':
            j = i + 1
            while j < n and src[j] != '"':
                j += 2 if src[j] == "\\" else 1
            out.append(src[i : j + 1])
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def remaining(path: str) -> list[tuple[int, str]]:
    raw = open(path, encoding="utf-8").read()
    cut = raw.find("#[cfg(test)]")
    body = raw if cut < 0 else raw[:cut]
    raw_lines = body.splitlines()
    hits = []
    for idx, line in enumerate(strip_comments(body).splitlines()):
        if HANGUL.search(line) and not LOG.search(line) and "i18n-ok:" not in raw_lines[idx]:
            hits.append((idx + 1, raw_lines[idx].strip()))
    return hits


if __name__ == "__main__":
    total = 0
    for p in sys.argv[1:]:
        for n, text in remaining(p):
            print(f"{p}:{n}: {text}")
            total += 1
    print(f"남은 한국어 줄: {total}")
