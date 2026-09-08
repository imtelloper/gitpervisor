// 태스크 60 — 작업 리포트: 날짜별 활동(git) · Claude 전사 프롬프트 · 잔디(히트맵) · 요약 카드.
//
// **공유 픽스처를 쓰지 않는다.** 잔디는 "그 날 몇 건"을 세는데, 공유 픽스처에는 앞선 스위트들이
// 오늘 날짜로 만든 커밋이 여럿 쌓여 있어 "오늘 = 1건" 같은 단언이 성립하지 않는다. 그래서 이
// 스위트만 쓰는 레포를 따로 만들고(커밋 4개: 오늘·3일 전·40일 전 + 다른 이메일 1개) 끝나면 지운다.
//
// 지키는 계약 여섯:
//   ① `git_activity` 가 **작성자 날짜**로 버킷하고, `mine=true` 는 다른 이메일 커밋을 뺀다.
//   ② `claude_prompts` 가 전사에서 사용자 프롬프트만 뽑는다(`tool_result` 줄 제외) + 날짜별 개수.
//   ③ 리포트 뷰의 잔디가 365칸이고 오늘 칸이 값·툴팁을 갖는다.
//   ④ 오늘 칸 클릭 → 그 날 카드가 같은 카운트를 보여준다. LLM 준비 시 요약이 스트리밍되고 저장된다.
//   ⑤ 커밋을 추가하면 `repo://changed` → `["activity"]` 무효화로 칸이 갱신된다.
//   ⑥ 파일을 열면(`selectDiff`) 리포트가 닫힌다(모아보기와 같은 규칙).
//
// **가짜 전사는 finally 에서 그 파일만 지운다** — 사용자의 실제 전사 디렉토리는 건드리지 않는다.
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "../lib/git-fixture.mjs";

export const name = "작업 리포트 (잔디 · 전사 프롬프트 · 기간 요약)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

/** Claude Code 전사 디렉토리 이름 규약(`claude_usage.rs encode_project_dir`). */
const encodeDir = (p) => p.replace(/[/\\:.]/g, "-");

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** 로컬 정오 기준의 날짜 — 시간대와 무관하게 "그 날"에 확실히 들어간다. */
function localNoon(offsetDays) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

/** 폴링 — fn 이 truthy 를 돌려줄 때까지(또는 시한까지). */
async function until(fn, timeoutMs, stepMs = 400) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(stepMs);
  }
}

export async function run({ cdp, report: r }) {
  const root = mkdtempSync(join(tmpdir(), "gpv-e2e-report-"));
  const repo = join(root, "repo");
  const transcriptDir = join(homedir(), ".claude", "projects", encodeDir(repo));
  const transcript = join(transcriptDir, "e2e.jsonl");
  const MY_EMAIL = "e2e@gitpervisor.test";
  const today = ymd(localNoon(0));
  const d3 = ymd(localNoon(-3));
  const d40 = ymd(localNoon(-40));
  const yearAgo = ymd(localNoon(-364));

  let projectId = null;
  let generatedKey = null;

  try {
    // ── 픽스처 레포: 날짜를 조작한 커밋 4개 ──
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", MY_EMAIL]);
    git(repo, ["config", "user.name", "gitpervisor-e2e"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    const commit = (rel, msg, day, email) => {
      writeFileSync(join(repo, rel), `${msg}\n`);
      git(repo, ["add", "-A"]);
      const args = email ? ["-c", `user.email=${email}`] : [];
      git(repo, [...args, "commit", "-m", msg, "--date", `${day}T12:00:00`]);
    };
    commit("old.txt", "40일 전 커밋", d40);
    commit("mid.txt", "3일 전 커밋", d3);
    commit("new.txt", "오늘 커밋", today);
    commit("other.txt", "남의 커밋", today, "someone-else@example.test");

    // ── 가짜 전사(오늘 2 · 어제 1 · tool_result 1) ──
    mkdirSync(transcriptDir, { recursive: true });
    const at = (d) => d.toISOString();
    const lines = [
      { type: "user", isSidechain: false, message: { role: "user", content: "오늘 첫 프롬프트" }, timestamp: at(localNoon(0)), cwd: repo },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "오늘 둘째 프롬프트" }] }, timestamp: at(new Date(localNoon(0).getTime() + 60_000)) },
      { type: "user", message: { role: "user", content: "어제 프롬프트" }, timestamp: at(localNoon(-1)) },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "이 줄은 제외돼야 한다" }] }, timestamp: at(localNoon(0)) },
    ];
    writeFileSync(transcript, `${lines.map((l) => J(l)).join("\n")}\n`);

    const project = await cdp.invoke("add_project", { path: repo }, { timeoutMs: 30000 });
    projectId = project.id;
    // **원시 invoke로 추가한 프로젝트는 UI 캐시에 없다.** ReportView는 `useProjects()`의 목록에서
    // 스코프를 고르므로, 이걸 안 하면 그 프로젝트가 `scoped`에 없어 activity/prompts 쿼리 자체가
    // 안 나가고 잔디·카드가 전부 0으로 보인다(44가 같은 이유로 같은 줄을 갖고 있다).
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await until(
      async () =>
        (await cdp.eval(
          `((window.__gpv.queryClient.getQueryData(["projects"])||[]).some(p=>p.id===${J(projectId)}))`,
        )) || null,
      8000,
    );

    // ── ① git_activity ──
    const allDays = await cdp.invoke(
      "git_activity",
      { projectId, since: yearAgo, until: today, mine: false },
      { timeoutMs: 20000 },
    );
    const byDay = Object.fromEntries((allDays ?? []).map((d) => [d.date, d.count]));
    r.check(
      "① 날짜별 커밋 — 3일에 걸쳐 4건(오늘 2)",
      allDays?.length === 3 && byDay[today] === 2 && byDay[d3] === 1 && byDay[d40] === 1,
      J(byDay),
    );

    const mineDays = await cdp.invoke(
      "git_activity",
      { projectId, since: yearAgo, until: today, mine: true },
      { timeoutMs: 20000 },
    );
    const mineBy = Object.fromEntries((mineDays ?? []).map((d) => [d.date, d.count]));
    r.check(
      "① mine=true — 다른 이메일 커밋 제외(각 1건)",
      mineDays?.length === 3 && mineBy[today] === 1 && mineBy[d3] === 1 && mineBy[d40] === 1,
      J(mineBy),
    );

    // 마지막 날(오늘)이 `--until` 에서 잘리지 않는지 — 날짜만 넘기면 git 은 00:00 으로 읽는다.
    const oneDay = await cdp.invoke(
      "git_activity",
      { projectId, since: today, until: today, mine: true },
      { timeoutMs: 20000 },
    );
    r.check("① since==until 이어도 그 날 커밋이 잡힌다", oneDay?.[0]?.count === 1, J(oneDay));

    const bad = await cdp.try("git_activity", { projectId, since: "2026-9-7 --all", until: today, mine: false });
    r.check("① 잘못된 날짜 형식 거절", bad.ok === false, `${bad.code || ""} ${bad.message || ""}`);

    // ── ② claude_prompts ──
    const dump = await cdp.invoke(
      "claude_prompts",
      { projectPath: repo, since: yearAgo, until: today },
      { timeoutMs: 30000 },
    );
    const promptDays = Object.fromEntries((dump?.days ?? []).map((d) => [d.date, d.count]));
    r.check(
      "② 사용자 프롬프트 3건(tool_result 제외)",
      dump?.items?.length === 3 && !J(dump.items).includes("제외돼야"),
      J(dump?.items?.map((i) => i.text)),
    );
    r.check(
      "② 날짜별 개수 2일(오늘 2)",
      dump?.days?.length === 2 && promptDays[today] === 2,
      J(promptDays),
    );

    // ── ③ 잔디 ──
    await cdp.eval(`(()=>{ try{ localStorage.setItem("gp:report-mine","1"); }catch(_){} return true; })()`);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(projectId)})`);
    await cdp.eval(`(()=>{ const s=window.__gpv.ui.getState(); if(!s.reportOpen) s.toggleReport(); return true; })()`);
    const cells = await until(
      async () => {
        const n = await cdp.eval(`document.querySelectorAll('[data-day]').length`);
        return n === 365 ? n : null;
      },
      15000,
    );
    r.check("③ 잔디 셀 365개(오늘 포함 1년)", cells === 365, `${cells}`);

    const cellOf = (day) =>
      cdp.eval(
        `(()=>{ const b=document.querySelector('[data-day="${day}"]'); return b?{level:b.dataset.level,title:b.title}:null; })()`,
      );
    // 두 시리즈(커밋·프롬프트)가 **각각 다른 쿼리**로 도착한다 — 프롬프트만 기다리고 커밋을
    // 단언하면 activity가 아직 로딩 중인 회차에서 "커밋 0"으로 떨어진다.
    const todayCell = await until(async () => {
      const c = await cellOf(today);
      return c && c.title.includes("커밋 1 · 프롬프트 2") ? c : null;
    }, 30000);
    r.check(
      "③ 오늘 칸 — data-level ≥ 1 · 툴팁에 커밋 1 · 프롬프트 2",
      !!todayCell && Number(todayCell.level) >= 1 && todayCell.title.includes("커밋 1 · 프롬프트 2"),
      J(todayCell),
    );
    const oldCell = await cellOf(d40);
    r.check("③ 40일 전 칸도 값이 있다", !!oldCell && Number(oldCell.level) >= 1, J(oldCell));

    // ── ④ 카드 ──
    const clicked = await cdp.eval(
      `(()=>{ const b=document.querySelector('[data-day="${today}"]'); if(!b) return false; b.click(); return true; })()`,
    );
    r.check("④ 오늘 칸 클릭", clicked === true);
    // 카드의 개수 줄을 **직접** 읽는다 — body.innerText 포함 검사는 실패했을 때 실제 값이 안 남아
    // 원인을 못 좁힌다(히트맵은 맞는데 카드만 틀린 경우가 실제로 있었다).
    const cardCount = () =>
      cdp.eval(`(()=>{ const s=[...document.querySelectorAll('span')]
          .find(x=>/^커밋 \\d+ · 프롬프트 \\d+$/.test((x.textContent||'').trim()));
        return s ? s.textContent.trim() : null; })()`);
    const carded = await until(
      async () => ((await cardCount()) === "커밋 1 · 프롬프트 2" ? true : null),
      20000,
    );
    r.check("④ 오늘 카드 — 커밋 1 · 프롬프트 2", carded === true, `card=${J(await cardCount())}`);

    const gen = await cdp.eval(
      `(()=>{ const b=[...document.querySelectorAll('button')].find(x=>/요약 생성|다시 생성/.test(x.textContent)); return b?{disabled:!!b.disabled,reason:b.title||null}:null; })()`,
    );
    if (!gen || gen.disabled) {
      const hasReason = await cdp.eval(`document.body.innerText.includes("설정 열기")`);
      r.check("④ LLM 미준비 — 이유 + 설정 열기 안내", hasReason === true, J(gen));
      r.skip("④ 요약 생성", `LLM 미준비: ${gen?.reason ?? "버튼 없음"}`);
    } else {
      await cdp.eval(
        `(()=>{ const b=[...document.querySelectorAll('button')].find(x=>/요약 생성|다시 생성/.test(x.textContent)); b.click(); return true; })()`,
      );
      const wrote = await until(
        async () => (await cdp.eval(`document.body.innerText.includes("한 줄 요약")`)) || null,
        120000,
        1000,
      );
      r.check("④ 요약이 스트리밍돼 본문에 '## 한 줄 요약' 등장", wrote === true);
      const saved = await until(async () => {
        const map = await cdp.invoke("report_get_all", {}, { timeoutMs: 10000 });
        const key = Object.keys(map || {}).find((k) => k.startsWith(`${projectId}|day|`));
        return key ? { key, rec: map[key] } : null;
      }, 20000);
      generatedKey = saved?.key ?? null;
      r.check("④ reports.json 에 저장(키·해시·모델)", !!saved?.rec?.text && !!saved.rec.inputHash, J(saved?.key));
    }

    // ── ⑤ 커밋 추가 → 무효화 ──
    commit("more.txt", "방금 커밋", today);
    const bumped = await until(async () => {
      const c = await cellOf(today);
      return c && c.title.includes("커밋 2") ? c : null;
    }, 20000);
    r.check("⑤ repo://changed → ['activity'] 무효화로 칸 갱신(커밋 2)", !!bumped, J(bumped));
    if (generatedKey) {
      const badge = await until(
        async () => (await cdp.eval(`document.body.innerText.includes("입력이 바뀜")`)) || null,
        15000,
      );
      r.check("⑤ 입력 해시 불일치 뱃지", badge === true);
    } else {
      r.skip("⑤ 입력이 바뀜 뱃지", "요약을 생성하지 않아 비교할 저장본이 없다");
    }

    // ── ⑥ 파일을 열면 리포트가 닫힌다 ──
    await cdp.eval(
      `window.__gpv.ui.getState().selectDiff({ mode: "file", path: "new.txt" })`,
    );
    await sleep(300);
    const stillOpen = await cdp.eval(`window.__gpv.ui.getState().reportOpen`);
    r.check("⑥ selectDiff → reportOpen === false", stillOpen === false, `${stillOpen}`);
  } finally {
    // 가짜 전사 **파일만** 지운다(디렉토리는 남긴다 — 사용자 전사 보호).
    try {
      if (existsSync(transcript)) unlinkSync(transcript);
    } catch (e) {
      console.error("전사 정리 경고:", e.message);
    }
    if (generatedKey) await cdp.try("report_delete", { key: generatedKey });
    if (projectId) {
      await cdp
        .eval(`window.__gpv?.ui?.getState().closeProjectViewerTabs(${J(projectId)})`)
        .catch(() => {});
      await cdp.try("remove_project", { id: projectId });
    }
    await cdp
      .eval(`(()=>{ const s=window.__gpv.ui.getState(); if(s.reportOpen) s.toggleReport(); return true; })()`)
      .catch(() => {});
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.error("리포트 픽스처 정리 경고:", e.message);
    }
  }
}
