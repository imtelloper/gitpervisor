// 영어 화면 순회 — DOCS/i18n-design.md §5.3.
//
// UI 언어를 영어로 바꾸고 주요 화면을 돌며 **보이는** 텍스트 노드와 title·placeholder·aria-label 을 모아,
// 한글이 남아 있으면 빨갛다. 소스 가드(e2e 66)가 "코드에 남은 한글"을 본다면 이건 "화면에 새는 한글" —
// Rust 오류·조립된 문구·카탈로그 등록 누락처럼 소스 스캔이 못 보는 것을 잡는다.
//
// 사용자 데이터가 한글이면 오탐이다 — 그래서 픽스처 레포(이름·파일·커밋)를 전부 ASCII 로 만들고, 터미널(xterm)·
// 편집기(Monaco) 안쪽은 뺀다(셸 출력·파일 내용은 UI 문구가 아니다).
//
// 아직 이관하지 않은 화면(설정 대화상자·AI 설정·동영상 편집기 — 태스크 72 와 겹쳐 리베이스 뒤로 미룸)은 돌지 않는다.
// 이관이 끝나면 SCREENS 에 더한다.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "../lib/git-fixture.mjs";

export const name = "UI 언어 — 영어 화면 순회(보이는 한글 0)";

const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs, stepMs = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(stepMs);
  }
}

/** 페이지에서 보이는 한글을 모은다 — 텍스트 노드 + 사람이 읽는 속성. xterm·Monaco 안쪽은 뺀다. */
const COLLECT = `(()=>{
  const H = /[\\uac00-\\ud7a3]/;
  const SKIP = ".xterm, .monaco-editor, .monaco-diff-editor, [data-user-content]";
  const visible = (el) => {
    if (!el || el.closest(SKIP)) return false;
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const where = (el) => {
    const g = el.closest("[data-gpv]");
    const tag = el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 2).join(".") : "");
    return (g ? "[data-gpv=" + g.getAttribute("data-gpv") + "] " : "") + tag;
  };
  const out = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode()); ) {
    const t = (n.nodeValue || "").trim();
    if (t && H.test(t) && visible(n.parentElement)) out.push(where(n.parentElement) + " :: " + t.slice(0, 60));
  }
  for (const el of document.querySelectorAll("[title],[placeholder],[aria-label]")) {
    for (const a of ["title", "placeholder", "aria-label"]) {
      const v = el.getAttribute(a);
      if (v && H.test(v) && visible(el)) out.push(where(el) + " @" + a + " :: " + v.slice(0, 60));
    }
  }
  return [...new Set(out)];
})()`;

export async function run({ cdp, report: r }) {
  const root = mkdtempSync(join(tmpdir(), "gpv-e2e-i18n-sweep-"));
  const repo = join(root, "sweep-repo");
  let projectId = null;
  const orig = await cdp.invoke("get_settings");
  const ui = (expr) => cdp.eval(`(()=>{ const s=window.__gpv.ui.getState(); return ${expr}; })()`);

  try {
    // ── ASCII 픽스처: 커밋 2개 + 수정 1 + 추적 안 됨 1 ──
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "sweep@gitpervisor.test"]);
    git(repo, ["config", "user.name", "sweep"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "readme.txt"), "hello\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "initial commit"]);
    writeFileSync(join(repo, "notes.txt"), "notes\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "add notes"]);
    writeFileSync(join(repo, "readme.txt"), "hello world\n");
    writeFileSync(join(repo, "draft.txt"), "draft\n");

    projectId = (await cdp.invoke("add_project", { path: repo }, { timeoutMs: 30000 })).id;
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`).catch(() => {});
    await until(
      async () =>
        (await cdp.eval(`((window.__gpv.queryClient.getQueryData(["projects"])||[]).some(p=>p.id===${J(projectId)}))`)) || null,
      8000,
    );

    // ── 영어로 ──
    await cdp.invoke("set_settings", { settings: { ...orig, uiLanguage: "en" } });
    const en = await until(async () => ((await cdp.eval(`document.documentElement.lang`)) === "en" ? true : null), 5000);
    r.check("영어로 전환(<html lang=en>)", en === true);

    const SCREENS = [
      {
        name: "메인 — 프로젝트 선택(사이드바·툴바·변경·파일 트리·상태바)",
        enter: async () => {
          await ui(`(s.closeReport(), s.setAggregateOpen(false), s.selectProject(${J(projectId)}), true)`);
          await sleep(2500); // status·트리 쿼리가 채워질 시간
        },
      },
      {
        name: "리포트",
        enter: async () => {
          await ui(`(s.reportOpen || s.toggleReport(), true)`);
          await sleep(2000);
        },
        leave: () => ui(`(s.closeReport(), true)`),
      },
      {
        name: "모아보기",
        enter: async () => {
          await ui(`(s.setAggregateOpen(true), true)`);
          await sleep(2000);
        },
        leave: () => ui(`(s.setAggregateOpen(false), true)`),
      },
    ];

    for (const s of SCREENS) {
      await s.enter();
      const found = await cdp.eval(COLLECT);
      r.check(
        `영어 화면에 보이는 한글 0 — ${s.name}`,
        Array.isArray(found) && found.length === 0,
        Array.isArray(found) && found.length ? `${found.length}건: ${found.slice(0, 6).join(" | ")}` : "0건",
      );
      if (s.leave) await s.leave();
    }

    // ── Rust 가 만드는 오류 문구도 영어인가(없는 프로젝트 id) ──
    const bad = await cdp.try("remove_project", { id: "no-such-project-i18n-sweep" });
    r.check(
      "영어 모드에서 Rust 오류 메시지에 한글이 없다",
      !bad.ok && !!bad.message && !/[가-힣]/.test(bad.message),
      J({ ok: bad.ok, message: bad.message }),
    );
  } finally {
    await cdp.invoke("set_settings", { settings: orig }).catch(() => {});
    await ui(`(s.closeReport(), s.setAggregateOpen(false), true)`).catch(() => {});
    if (projectId) await cdp.try("remove_project", { id: projectId });
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.error("i18n 스윕 픽스처 정리 경고:", e.message);
    }
  }
}
