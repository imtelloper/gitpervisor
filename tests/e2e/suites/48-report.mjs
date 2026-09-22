// 태스크 60 — 작업 리포트: 날짜별 활동(git) · Claude 전사 프롬프트 · 잔디(히트맵) · 요약 카드.
//
// **공유 픽스처를 쓰지 않는다.** 잔디는 "그 날 몇 건"을 세는데, 공유 픽스처에는 앞선 스위트들이
// 오늘 날짜로 만든 커밋이 여럿 쌓여 있어 "오늘 = 1건" 같은 단언이 성립하지 않는다. 그래서 이
// 스위트만 쓰는 레포를 따로 만들고(커밋 4개: 오늘·3일 전·40일 전 + 다른 이메일 1개) 끝나면 지운다.
//
// 지키는 계약 열둘(⑦~⑪ 은 태스크 67 — 다중 프로젝트 종합 · AI 채팅 · 별도 창):
//   ① `git_activity` 가 **작성자 날짜**로 버킷하고, `mine=true` 는 다른 이메일 커밋을 뺀다.
//   ② `claude_prompts` 가 전사에서 사용자 프롬프트만 뽑는다(`tool_result` 줄 제외) + 날짜별 개수.
//   ③ 리포트 뷰의 잔디가 365칸이고 오늘 칸이 값·툴팁을 갖는다.
//   ④ 오늘 칸 클릭 → 그 날 카드가 같은 카운트를 보여준다. LLM 준비 시 요약이 스트리밍되고 저장된다.
//   ⑤ 커밋을 추가하면 `repo://changed` → `["activity"]` 무효화로 칸이 갱신된다.
//   ⑤b 같은 신호의 `diff` 무효화는 **바뀐 프로젝트로 한정**되고 히스토리 계열은 전역으로 남는다
//      (태스크 69 §4) — `queryKeyTouchesProject` 진리표를 직접 잰다. 빗나가는 쪽(합성 id `outer::rel`
//      을 놓침 · 접두만 같은 id 를 같은 것으로 봄 · 히스토리를 한정해 워크트리가 낡음)은 화면에
//      안 드러나 ⑤ 만으로는 초록이다.
//   ⑥ 파일을 열면(`selectDiff`) 리포트가 닫힌다(모아보기와 같은 규칙).
//   ⑦ 스코프를 2개 체크하면 종합 카드 1 + 개별 2 = 3장, 종합 카운트는 **합**, 키는 `multi:<해시>`.
//   ⑧ `buildMessages` 가 날짜 섹션(`### YYYY-MM-DD (요일)`)으로 조립하고 예산 바닥(1,500자)을 지킨다.
//   ⑧b 요약 생성 프롬프트(설정 `reportPrompt`) — 자리표시자 치환·비면 기본값·긴 프롬프트면 근거 예산 축소·
//      채팅도 같은 지침, 그리고 [프롬프트] 편집 패널 왕복(저장 → 설정 반영, 기본값으로 저장 → null).
//   ⑨ 종합 카드 [AI에게 묻기] → 우측 채팅. [요약으로 저장] 게이트가 `## ` 유무와 일치하고,
//      저장하면 **카드 본문이 그 답변으로 바뀐다**(스트리밍 잔여가 가리지 않는다).
//   ⑩ [리포트] 우클릭 → "새 창으로 열기" → `doc-report` 싱글턴, 메인 뷰는 닫힌다.
//   ⑪ 원시 `report_set`/`report_delete` → `report://changed` 로 메인 창 캐시가 따라 움직인다.
//   ⑫ 모아보기 중 [리포트] → 헤더에 리포트 탭 + 리포트가 그리드를 덮는다. 탭 클릭·버튼은 앞/뒤 전환, X 는 닫기.
//
// **가짜 전사는 finally 에서 그 파일만 지운다** — 사용자의 실제 전사 디렉토리는 건드리지 않는다.
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "../lib/git-fixture.mjs";

export const name = "작업 리포트 (잔디 · 전사 프롬프트 · 기간 요약)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";
/** `lib/report.ts` 의 요일 표기와 같아야 한다 — ⑧ 이 조립 결과를 글자 그대로 맞춘다. */
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

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

/**
 * `git log %aI` 와 같은 모양 — 오프셋을 달고 있는 로컬 시각. **커밋의 날짜 버킷은 이 오프셋의
 * 날짜**다(`report.rs` 의 `date_naive()` 와 같은 기준). 프롬프트 `at` 은 UTC 라 그쪽은
 * `toISOString()` 을 그대로 쓴다 — 두 갈래의 기준이 다른 것이 계약이다.
 */
function localIso(offsetDays) {
  const d = localNoon(offsetDays);
  const tz = -d.getTimezoneOffset();
  const p = (n) => String(n).padStart(2, "0");
  return `${ymd(d)}T12:00:00${tz < 0 ? "-" : "+"}${p(Math.floor(Math.abs(tz) / 60))}:${p(Math.abs(tz) % 60)}`;
}

/**
 * 오류·안내 문구는 assistant 자리에 그대로 앉는다(`ReportChat` 의 `notice()`) — 그걸 "답변"으로
 * 세면 전송 경로가 통째로 고장 나 있어도 ⑨ 가 초록이다.
 */
const NOT_AN_ANSWER =
  /^(다른 생성이 진행 중입니다|취소됨|AI 요청|AI 서버 오류|AI 응답 시간 초과|응답 수신 실패|IPC 응답 시간 초과)/;

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
  /** ⑦ 의 둘째 레포 — 같은 임시 루트 안이라 finally 의 `rmSync(root)` 가 함께 거둔다. */
  const repo2 = join(root, "repo2");
  const transcriptDir = join(homedir(), ".claude", "projects", encodeDir(repo));
  const transcript = join(transcriptDir, "e2e.jsonl");
  const MY_EMAIL = "e2e@gitpervisor.test";
  const today = ymd(localNoon(0));
  const d3 = ymd(localNoon(-3));
  const d40 = ymd(localNoon(-40));
  const yearAgo = ymd(localNoon(-364));

  let projectId = null;
  let projectId2 = null;
  let generatedKey = null;
  /** ⑨ 가 채팅에서 저장한 종합 카드 키 · ⑪ 이 쓴 합성 키 — finally 에서 지운다. */
  let combinedKey = null;
  let syncKey = null;
  /** 사용자가 골라 둔 스코프·채팅 열림 — 이 스위트가 덮기 전 값. finally 에서 **되돌린다**. */
  let prevScope;
  let prevChat;
  /** ⑧b 가 덮기 전의 설정 `reportPrompt` — undefined 면 아직 안 건드린 것. finally 에서 되돌린다. */
  let prevReportPrompt;

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
    // 스코프·채팅 열림은 창 간 공유라 **지난 회차가 남긴 값**이 이 스위트의 전제를 깬다:
    // "전체"로 남아 있으면 ③④ 가 보는 첫 카드가 종합 카드(다른 카운트)가 된다. 지워서
    // 기본값(지금 고른 프로젝트 1개)으로 시작시킨다. 다만 **지우기만 하면 원복이 아니라
    // 소거**다 — 사용자가 골라 둔 값을 먼저 받아 두었다가 finally 에서 되돌린다
    // (14 의 `gp:project-colors`, 40 의 `gp:ie:toggles` 와 같은 처리).
    prevScope = await cdp.eval(`localStorage.getItem("gp:report-scope")`);
    prevChat = await cdp.eval(`localStorage.getItem("gp:report-chat-open")`);
    await cdp.eval(
      `(()=>{ try{ localStorage.setItem("gp:report-mine","1");
        localStorage.removeItem("gp:report-scope"); localStorage.removeItem("gp:report-chat-open");
      }catch(_){} return true; })()`,
    );
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

    // ── ⑤b 워처 한정 무효화 진리표(태스크 69 §4) ──
    const scoped = await cdp.eval(`(()=>{
      const f = window.__gpvRepoEvents && window.__gpvRepoEvents.queryKeyTouchesProject;
      if (!f) return null;
      return {
        same:       f(["diff", "abc", "w:a.txt"], ["abc"]),
        other:      f(["diff", "zzz", "w:a.txt"], ["abc"]),
        prefixOnly: f(["diff", "abcd", "w:a.txt"], ["abc"]),
        nested:     f(["diff", "abc::sub", "w:a.txt"], ["abc"]),
        outer:      f(["diff", "abc", "w:a.txt"], ["abc::sub"]),
        // 히스토리 계열은 **남의 프로젝트여도 전역**이다 — .git 을 공유하는 linked worktree 의
        // 커밋은 본 저장소 id 로만 신호가 온다(events.ts WATCHER_SCOPED_KINDS 주석).
        // (이 주석은 템플릿 리터럴 안이다 — 백틱을 쓰면 문자열이 거기서 끊긴다.)
        logOther:      f(["log", "zzz"], ["abc"]),
        branchesOther: f(["branches", "zzz"], ["abc"]),
        activityOther: f(["activity", "zzz", "2026-01-01", true], ["abc"]),
        betweenOther:  f(["commits-between", "zzz", "2026-01-01", "2026-01-02", false], ["abc"]),
        filesHit:   f(["repo-files", "zzz", "abc::sub"], ["abc"]),
        filesMiss:  f(["repo-files", "zzz"], ["abc"]),
        unknownKind: f(["statuses", ["abc"]], ["abc"]),
      };
    })()`);
    if (!scoped) {
      r.skip("⑤b 한정 무효화 진리표", "window.__gpvRepoEvents 미노출(dev 빌드 아님)");
    } else {
      // `prefixOnly`(맨 startsWith 함정)·`*Other`(히스토리는 전역)·`unknownKind`(모르는 모양은 전역)
      // 가 이 표의 핵심이다.
      const want = {
        same: true, other: false, prefixOnly: false, nested: true, outer: true,
        logOther: true, branchesOther: true, activityOther: true, betweenOther: true,
        filesHit: true, filesMiss: false, unknownKind: true,
      };
      const wrong = Object.keys(want).filter((k) => scoped[k] !== want[k]);
      r.check(
        "⑤b queryKeyTouchesProject 진리표(diff 만 한정 · 합성 id 양방향 · 접두 함정 · 히스토리/모르는 키는 전역)",
        wrong.length === 0,
        J({ wrong, got: scoped }),
      );
    }

    // ── ⑥ 파일을 열면 리포트가 닫힌다 ──
    await cdp.eval(
      `window.__gpv.ui.getState().selectDiff({ mode: "file", path: "new.txt" })`,
    );
    await sleep(300);
    const stillOpen = await cdp.eval(`window.__gpv.ui.getState().reportOpen`);
    r.check("⑥ selectDiff → reportOpen === false", stillOpen === false, `${stillOpen}`);

    // ── ⑦ 다중 선택 → 종합 카드(태스크 67 §3.1) ──
    // ⑥ 이 뷰를 닫았다 — 아래 단언이 전부 이 뷰 안에 있으므로 다시 연다.
    await cdp.eval(
      `(()=>{ const s=window.__gpv.ui.getState(); if(!s.reportOpen) s.toggleReport(); return true; })()`,
    );

    mkdirSync(repo2, { recursive: true });
    git(repo2, ["init", "-b", "main"]);
    git(repo2, ["config", "user.email", MY_EMAIL]);
    git(repo2, ["config", "user.name", "gitpervisor-e2e"]);
    git(repo2, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo2, "two.txt"), "둘째 레포\n");
    git(repo2, ["add", "-A"]);
    git(repo2, ["commit", "-m", "둘째 레포 오늘 커밋", "--date", `${today}T12:00:00`]);

    const project2 = await cdp.invoke("add_project", { path: repo2 }, { timeoutMs: 30000 });
    projectId2 = project2.id;
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    const listed2 = await until(
      async () =>
        (await cdp.eval(
          `((window.__gpv.queryClient.getQueryData(["projects"])||[]).some(p=>p.id===${J(projectId2)}))`,
        )) || null,
      8000,
    );
    r.check("⑦ 둘째 레포(오늘 커밋 1) 등록", listed2 === true);

    // 체크가 **전부** 켜지면 ScopePicker 는 "전체"로 접는다 — 그러면 선택이 2개가 아니게 되므로
    // 셋 이상 등록돼 있어야 이 검사가 성립한다(러너 픽스처 1 + 이 스위트 2).
    const nProjects = await cdp.eval(
      `(window.__gpv.queryClient.getQueryData(["projects"])||[]).length`,
    );
    r.check("⑦ 사전 조건 — 등록 프로젝트 3개 이상", nProjects >= 3, `${nProjects}`);

    await cdp.eval(
      `(()=>{ const b=document.querySelector('[data-gpv="report-scope"]'); if(!b) return false; b.click(); return true; })()`,
    );
    // **`input` 을 붙여야 한다** — 사이드바의 프로젝트 행(ProjectItem)도 `data-project-id` 를
    // 달고 있어 그냥 찾으면 그 `div` 가 먼저 잡히고, 클릭해도 체크는 아무 일도 일어나지 않는다.
    const box2 = `input[data-project-id=${J(projectId2)}]`;
    await until(
      async () => (await cdp.eval(`!!document.querySelector(${J(box2)})`)) || null,
      5000,
    );
    const checked = await cdp.eval(
      `(()=>{ const el=document.querySelector(${J(box2)});
        if(!el) return 'no-checkbox'; if(el.checked) return 'already-checked'; el.click(); return true; })()`,
    );
    r.check("⑦ 스코프 드롭다운에서 둘째 프로젝트 체크", checked === true, J(checked));
    // 드롭다운은 카드 위를 덮는다 — 닫고 본다(Esc, ScopePicker 의 키 핸들러).
    await cdp.eval(
      `(()=>{ window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return true; })()`,
    );

    // eval 안에서 그대로 정규식 리터럴이 되어야 한다(템플릿이 아니라 일반 문자열이라 `\\d`).
    const cardCountRe = "/^커밋 \\d+ · 프롬프트 \\d+$/";
    // 두 프로젝트의 커밋·프롬프트 쿼리가 **따로** 도착한다 — 한쪽만 온 회차의 합을 읽으면
    // "커밋 2"로 떨어진다(③ 이 같은 이유로 두 시리즈를 함께 기다린다). 합이 맞을 때까지 본다.
    const SUM = "커밋 3 · 프롬프트 2";
    let cards = null;
    await until(async () => {
      const v = await cdp.eval(`(()=>{
        const one=[...document.querySelectorAll('[data-gpv="report-card"]')];
        const comb=document.querySelector('[data-gpv="report-card-combined"]');
        if(!comb) return null;
        const pick=(el)=>{ const s=[...el.querySelectorAll('span')]
          .find(x=>${cardCountRe}.test((x.textContent||'').trim())); return s? s.textContent.trim():null; };
        return { one: one.length, head: comb.innerText.split('\\n').slice(0,3).join(' | '),
                 count: pick(comb), scopeKey: comb.dataset.scopeKey || null }; })()`);
      if (v && v.count) cards = v; // 마지막 관측값 — 시한을 넘겨도 실패 메시지에 남는다
      return v && v.count === SUM ? v : null;
    }, 30000);
    r.check("⑦ 카드 3장 — 종합 1 + 개별 2", !!cards && cards.one === 2, J(cards));
    r.check(
      "⑦ 종합 헤더 '종합 · 2개 프로젝트'",
      !!cards && cards.head.includes("종합 · 2개 프로젝트"),
      J(cards && cards.head),
    );
    // 합: 레포1 오늘 내 커밋 2("오늘 커밋"+⑤"방금 커밋", 남의 커밋은 mine=true 로 제외) + 레포2 1,
    // 프롬프트는 레포1 전사 2 + 레포2 0.
    r.check(
      `⑦ 종합 카운트 = 두 레포의 합(${SUM})`,
      !!cards && cards.count === SUM,
      J(cards && cards.count),
    );
    r.check(
      "⑦ 종합 저장 키가 조합 해시(multi:<16hex>)",
      !!cards && /^multi:[0-9a-f]{16}$/.test(cards.scopeKey || ""),
      J(cards && cards.scopeKey),
    );
    if (cards?.scopeKey) combinedKey = `${cards.scopeKey}|day|${today}`;

    const savedScope = await cdp.eval(`localStorage.getItem("gp:report-scope")`);
    let scopeOk = false;
    try {
      const v = JSON.parse(savedScope);
      scopeOk =
        Array.isArray(v) && v.length === 2 && v.includes(projectId) && v.includes(projectId2);
    } catch (_) {
      scopeOk = false;
    }
    r.check("⑦ gp:report-scope 에 두 프로젝트 id", scopeOk, String(savedScope));

    // ── ⑧ 프롬프트 조립(LLM 없이 — 순수 함수) ──
    const noonIso = localNoon(0).toISOString();
    const wd = WEEKDAY[localNoon(0).getDay()];
    const yday = ymd(localNoon(-1));
    const wdY = WEEKDAY[localNoon(-1).getDay()];
    /** 예산 상한 검사용 — 활동 10일(오늘 ~ 9일 전). 커밋은 오프셋 ISO, 프롬프트는 UTC. */
    const spreadC = Array.from({ length: 10 }, (_, i) => localIso(-i));
    const spreadP = Array.from({ length: 10 }, (_, i) => localNoon(-i).toISOString());
    const asm = await cdp.eval(`(()=>{
      const R = window.__gpv && window.__gpv.report;
      if (!R || !R.buildMessages) return 'no-hook';
      const AT = ${J(noonIso)};          // 프롬프트 — 전사 timestamp 는 UTC 다
      const CAT = ${J(localIso(0))};     // 커밋 — %aI 는 오프셋을 달고 온다(버킷은 그 날짜)
      const YAT = ${J(localIso(-1))};
      const c = (sha, subject, at) => ({ sha, parents: [], subject, body: "",
        authorName: "e2e", authorEmail: "e2e@x", authoredAt: at || CAT, refs: [] });
      const mk = (id, name, commits, prompts) => ({ project: { id, name, path: "/"+id }, commits, prompts });
      const two = [
        mk("p1", "알파", [c("aaaaaaa1111", "알파 커밋")], [{ at: AT, text: "알파 프롬프트" }]),
        mk("p2", "베타", [c("bbbbbbb2222", "베타 커밋")], []),
      ];
      const base = { period: "week", since: ${J(today)}, until: ${J(today)}, language: "ko" };
      const m2 = R.buildMessages({ ...base, sources: two });
      const m1 = R.buildMessages({ ...base, sources: [two[0]] });
      // 예산 바닥 — ctx 2048·월간이면 (2048-2048-400)*1.5 < 0 이라 max(1500, …) 가 걸려야 한다.
      const bulk = (n, prefix, at) => Array.from({ length: n },
        (_, i) => c(prefix + String(i).padStart(6,"0"), "커밋 제목 " + i + " " + "가".repeat(60), at));
      const many = [mk("p1", "알파", bulk(40, "a", CAT), [])];
      const mb = R.buildMessages({ ...base, period: "month", sources: many, ctx: 2048 });
      // 날짜별 균등 분배(§3.1 의 핵심 변경) — 두 날짜에 20건씩. 분배가 없으면 두 섹션이 각각
      // 예산 전부를 써 합이 두 배가 되고, 날짜 정렬이 없으면 최신 날짜가 먼저 나온다.
      const twoDays = [mk("p1", "알파", [...bulk(20, "b", CAT), ...bulk(20, "y", YAT)], [])];
      const m2d = R.buildMessages({ ...base, period: "month", sources: twoDays, ctx: 2048 });
      // 예산 상한 — 활동 10일 × (커밋 1 · 300자 프롬프트 1). 날짜마다 "최소 1줄"을 남기면
      // 그 바닥이 날짜 수 × 2회로 곱해져 예산을 통째로 넘긴다.
      const wide = [mk("p1", "알파",
        ${J(spreadC)}.map((t, i) => c("c" + String(i).padStart(6,"0"), "커밋 " + i, t)),
        ${J(spreadP)}.map((t, i) => ({ at: t, text: "프롬프트 " + i + " " + "가".repeat(300) })))];
      const mw = R.buildMessages({ ...base, period: "month", sources: wide, ctx: 2048 });
      return { sys2: m2[0].content, user2: m2[1].content, user1: m1[1].content,
               budget: mb[1].content, twoDays: m2d[1].content, wide: mw[1].content };
    })()`);
    if (asm === "no-hook") {
      r.check("⑧ __gpv.report.buildMessages 노출(dev 빌드)", false, "훅 없음");
    } else {
      r.check(
        `⑧ 날짜 섹션 '### ${today} (${wd})' + 날짜별 머리글(커밋 2건)`,
        asm.user2.includes(`### ${today} (${wd})`) && asm.user2.includes("커밋 2건"),
        J(asm.user2.slice(0, 200)),
      );
      r.check(
        "⑧ 여러 프로젝트면 줄머리에 [프로젝트명] · 프롬프트는 HH:MM",
        asm.user2.includes("- [알파] 알파 커밋") &&
          asm.user2.includes("- [베타] 베타 커밋") &&
          asm.user2.includes("- [알파] [12:00] 알파 프롬프트"),
        J(asm.user2.slice(0, 400)),
      );
      r.check(
        "⑧ 1개면 접두 없음",
        !asm.user1.includes("[알파]") && asm.user1.includes("- 알파 커밋"),
        J(asm.user1.slice(0, 200)),
      );
      // 근거에 해시가 있으면 모델이 불릿 끝에 `, c1f4034`처럼 베껴 붙인다(사용자 요청 2026-09-22로 금지).
      r.check(
        "⑧ 근거에 커밋 해시를 싣지 않는다 · system 이 해시 금지와 줄 길이 하한(100자)을 지시",
        !asm.user2.includes("aaaaaaa") && !asm.user2.includes("bbbbbbb") &&
          asm.sys2.includes("커밋 해시는 쓰지 마라") && asm.sys2.includes("100자 이상"),
        J(asm.user2.slice(0, 200)),
      );
      r.check(
        "⑧ system 에 '정확히 3개'(날짜당 3줄 지시)",
        asm.sys2.includes("정확히 3개") && asm.sys2.includes("### YYYY-MM-DD (요일)"),
        J(asm.sys2.slice(0, 200)),
      );
      // 바닥이 없으면 `(2048-2048-400)*1.5 < 0` 이라 날짜마다 **1줄만** 남는다.
      // 바닥 1,500 → 커밋 몫 750자 → 80자짜리 줄이 아홉쯤 실린다.
      const keptLines = (asm.budget.match(/^- /gm) || []).length;
      r.check(
        "⑧ ctx 2048 이어도 예산 바닥이 걸린다 — 여러 줄이 남고 '…외 N건' 으로 잘림을 알린다",
        keptLines >= 5 && keptLines < 40 && /…외 \d+건/.test(asm.budget) && asm.budget.includes("커밋 40건"),
        `kept=${keptLines} len=${asm.budget.length}`,
      );

      // 날짜별 분배(§3.1) — 두 날짜가 **둘 다** 남고, 각각 자기 몫만큼만 싣는다.
      const iY = asm.twoDays.indexOf(`### ${yday} (${wdY})`);
      const iT = asm.twoDays.indexOf(`### ${today} (${wd})`);
      r.check(
        "⑧ 두 날짜가 모두 남고 오래된 날짜가 먼저 — 예산이 날짜 수로 나뉜다",
        iY >= 0 && iT > iY && (asm.twoDays.match(/…외 \d+건/g) || []).length === 2,
        `yday@${iY} today@${iT} len=${asm.twoDays.length}`,
      );
      // 예산은 "컨텍스트에 들어간다"는 보장이다 — 활동 날짜가 많아도 그 보장이 깨지면 안 된다
      // (날짜마다 최소 1줄 바닥이 있으면 여기서 4,000자쯤 나온다). 머리글 몫 10% 여유.
      const sections = (asm.wide.match(/^### /gm) || []).length;
      r.check(
        "⑧ 활동 10일이어도 예산(1,500자) 안 · 날짜 섹션은 하나도 사라지지 않는다",
        asm.wide.length <= 1500 * 1.1 && sections === 10,
        `len=${asm.wide.length} sections=${sections}`,
      );
    }

    // ── ⑧b 요약 생성 프롬프트 편집(설정 `reportPrompt`) ──
    // 순수 조립 먼저: 자리표시자 치환 · 비었으면 기본값 · 긴 프롬프트면 근거 예산이 준다 · 채팅도 같은 지침.
    const pe = await cdp.eval(`(()=>{
      const R = window.__gpv && window.__gpv.report;
      if (!R || !R.buildMessages || !R.chatMessages) return 'no-hook';
      const c = (sha, subject) => ({ sha, parents: [], subject, body: "", authorName: "e2e",
        authorEmail: "e2e@x", authoredAt: ${J(localIso(0))}, refs: [] });
      const mk = (id, name, commits) => ({ project: { id, name, path: "/"+id }, commits, prompts: [] });
      const one = [mk("p1", "알파", [c("a1", "알파 커밋")])];
      const two = [...one, mk("p2", "베타", [c("b1", "베타 커밋")])];
      const base = { period: "week", since: ${J(today)}, until: ${J(today)}, language: "ko" };
      const T = "지침 {언어} {기간} {프로젝트접두}끝 {모름}";
      const bulk = [mk("p1", "알파", Array.from({ length: 60 },
        (_, i) => c("x" + i, "커밋 제목 " + i + " " + "가".repeat(60))))];
      const lines = (m) => (m[1].content.match(/^- /gm) || []).length;
      const ctx = { key: "k", title: "t", sources: one, period: "week", since: ${J(today)},
        until: ${J(today)}, body: "요약", hash: null };
      return {
        multi: R.buildMessages({ ...base, sources: two, prompt: T })[0].content,
        single: R.buildMessages({ ...base, sources: one, prompt: T })[0].content,
        blank: R.buildMessages({ ...base, sources: one, prompt: "   " })[0].content,
        nul: R.buildMessages({ ...base, sources: one, prompt: null })[0].content,
        keptDefault: lines(R.buildMessages({ ...base, sources: bulk, ctx: 8192 })),
        keptLong: lines(R.buildMessages({ ...base, sources: bulk, ctx: 8192, prompt: "가".repeat(6000) })),
        chat: R.chatMessages(ctx, [], "질문", "ko", 8192, "대화 지침 {기간}")[0].content,
      };
    })()`);
    if (pe === "no-hook") {
      r.check("⑧b __gpv.report.buildMessages·chatMessages 노출(dev 빌드)", false, "훅 없음");
    } else {
      r.check(
        "⑧b 자리표시자 치환 — 여러 프로젝트면 {프로젝트접두}=\"[프로젝트명] \", 모르는 {…}는 그대로",
        pe.multi === "지침 한국어 주간 [프로젝트명] 끝 {모름}" && pe.single === "지침 한국어 주간 끝 {모름}",
        J({ multi: pe.multi, single: pe.single }),
      );
      r.check(
        "⑧b 프롬프트가 null·공백뿐이면 기본 프롬프트(자리표시자가 남지 않는다)",
        pe.blank === pe.nul && pe.nul.includes("정확히 3개") && !pe.nul.includes("{언어}"),
        J(pe.nul.slice(0, 80)),
      );
      // 예산이 system 길이를 안 보면 긴 프롬프트가 컨텍스트를 넘긴다 — 고정값이면 두 수가 같다.
      r.check(
        "⑧b 긴 프롬프트면 근거로 싣는 줄이 준다(컨텍스트 예산에 system 길이 반영)",
        pe.keptLong < pe.keptDefault,
        `기본=${pe.keptDefault}줄 긴 프롬프트=${pe.keptLong}줄`,
      );
      r.check(
        "⑧b 채팅 system 에 같은 지침이 '### 요약 지침'으로 실린다",
        pe.chat.includes("### 요약 지침\n대화 지침 주간"),
        J(pe.chat.slice(0, 160)),
      );
    }

    // 편집 패널 왕복: 열기 → 고쳐 저장 → 설정에 반영 → 기본값으로 저장하면 null(기본값을 복사해 두지 않는다).
    prevReportPrompt = (await cdp.invoke("get_settings")).reportPrompt ?? null;
    const promptSetting = async () => (await cdp.invoke("get_settings")).reportPrompt ?? null;
    const editorText = () =>
      cdp.eval(`(()=>{ const t=document.querySelector('[data-gpv="report-prompt-text"]'); return t? t.value : null; })()`);
    const clickWhenEnabled = (sel) =>
      until(
        () =>
          cdp.eval(`(()=>{ const b=document.querySelector('${sel}'); if(!b||b.disabled) return null; b.click(); return true; })()`),
        5000,
      );
    await cdp.eval(`(()=>{ const b=document.querySelector('[data-gpv="report-prompt-toggle"]'); if(b) b.click(); return !!b; })()`);
    const promptOpened = await until(editorText, 5000);
    r.check(
      "⑧b [프롬프트] → 편집 패널이 열리고 지금 쓰는 프롬프트가 보인다",
      typeof promptOpened === "string" &&
        (prevReportPrompt === null ? promptOpened.startsWith("너는 개발자의 작업 일지") : promptOpened === prevReportPrompt),
      J((promptOpened || "").slice(0, 40)),
    );
    await cdp.eval(`(()=>{ const t=document.querySelector('[data-gpv="report-prompt-text"]'); if(!t) return false;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(t, "e2e 프롬프트 {기간}");
      t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
    const promptSaved = await clickWhenEnabled('[data-gpv="report-prompt-save"]');
    const promptCustom = await until(async () => ((await promptSetting()) === "e2e 프롬프트 {기간}" ? true : null), 5000);
    const promptBadge = await until(
      () =>
        cdp.eval(`(()=>{ const b=document.querySelector('[data-gpv="report-prompt-toggle"]');
          return b && b.textContent.includes("사용자 지정") ? true : null; })()`),
      5000,
    );
    r.check(
      "⑧b 고쳐서 [저장] → 설정 reportPrompt 에 그대로 저장되고 버튼에 '사용자 지정' 표시",
      promptSaved === true && promptCustom === true && promptBadge === true,
      J({ promptSaved, promptCustom, promptBadge, now: await promptSetting() }),
    );
    const promptResetOk = await clickWhenEnabled('[data-gpv="report-prompt-reset"]');
    const promptResetText = await editorText();
    const promptResaved = await clickWhenEnabled('[data-gpv="report-prompt-save"]');
    const promptCleared = await until(async () => ((await promptSetting()) === null ? true : null), 5000);
    r.check(
      "⑧b [기본값으로]+[저장] → 기본 프롬프트가 보이고 설정은 null(기본값을 복사해 저장하지 않는다)",
      promptResetOk === true && (promptResetText || "").startsWith("너는 개발자의 작업 일지") && promptResaved === true && promptCleared === true,
      J({ promptResetOk, promptResaved, promptCleared, now: await promptSetting() }),
    );
    await cdp.eval(`(()=>{ const b=document.querySelector('[data-gpv="report-prompt-toggle"]'); if(b) b.click(); return true; })()`);

    // ── ⑨ 우측 AI 채팅(태스크 67 §3.2) ──
    const asked = await cdp.eval(
      `(()=>{ const b=document.querySelector('[data-gpv="report-card-combined"] [data-gpv="report-ask"]');
        if(!b) return 'no-ask'; b.click(); return true; })()`,
    );
    r.check("⑨ 종합 카드 [AI에게 묻기]", asked === true, J(asked));
    const chip = await until(
      async () =>
        (await cdp.eval(
          `(()=>{ const c=document.querySelector('[data-gpv="report-chat-ctx"]'); return c? c.textContent.trim():null; })()`,
        )) || null,
      8000,
    );
    r.check(
      "⑨ 우측 채팅 패널 등장 · 컨텍스트 칩(종합 · 기간)",
      !!chip && chip.includes("종합 · 2개 프로젝트") && chip.includes(today),
      J(chip),
    );

    const gate = await cdp.eval(`(()=>{
      const t=document.querySelector('[data-gpv="report-chat-input"]');
      const a=document.querySelector('[data-gpv="report-chat"]');
      return { disabled: !t || !!t.disabled, text: a ? a.innerText.trim() : "" }; })()`);
    if (gate.disabled) {
      r.check(
        "⑨ LLM 미준비 — 이유 문구 + [설정 열기](메인 창 분기)",
        gate.text.length > 0 && gate.text.includes("설정 열기"),
        J(gate.text.slice(0, 120)),
      );
      r.skip("⑨ 채팅 전송 · [요약으로 저장]", "LLM 미준비");
    } else {
      // 저장이 카드의 **스트리밍 잔여 텍스트**에 가려지는 회귀(§6)를 잡으려면 카드에 로컬
      // text 가 남아 있어야 한다 — 그래서 종합 요약을 먼저 한 번 만든다.
      const genStarted = await cdp.eval(
        `(()=>{ const b=[...document.querySelectorAll('[data-gpv="report-card-combined"] button')]
          .find(x=>/요약 생성|다시 생성/.test(x.textContent)); if(!b||b.disabled) return false; b.click(); return true; })()`,
      );
      r.check("⑨ 종합 카드 요약 생성 시작", genStarted === true);
      const genText = await until(
        async () =>
          (await cdp.eval(
            `(()=>{ const c=document.querySelector('[data-gpv="report-card-combined"]');
              if(!c || c.querySelector('.animate-spin')) return null;
              const b=c.querySelector('.md-body'); return b && b.innerText.trim() ? b.innerText.trim() : null; })()`,
          )) || null,
        180000,
        1000,
      );
      r.check("⑨ 종합 요약이 카드 본문에 남는다", !!genText, J((genText || "").slice(0, 80)));

      await cdp.eval(`(()=>{
        const t=document.querySelector('[data-gpv="report-chat-input"]'); if(!t) return false;
        const d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');
        d.set.call(t, "한 줄로 요약해");
        t.dispatchEvent(new Event('input',{bubbles:true}));
        t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
        return true; })()`);
      const answer = await until(
        async () => {
          const v = await cdp.eval(`(()=>{
            const p=document.querySelector('[data-gpv="report-chat"]'); if(!p) return null;
            if(p.querySelector('.animate-spin')) return null;   // 아직 쓰는 중
            const a=[...p.querySelectorAll('[data-role="assistant"]')].pop(); if(!a) return null;
            const btn=a.querySelector('[data-gpv="report-chat-save"]'); if(!btn) return null;
            const md=a.querySelector('.md-body');
            return { text: md ? md.innerText.trim() : "", h2: !!a.querySelector('h2'),
                     saveDisabled: !!btn.disabled }; })()`);
          return v && v.text.length > 0 ? v : null;
        },
        120000,
        1000,
      );
      // 오류·BUSY·취소 문구도 assistant 자리에 앉고 저장 버튼까지 달고 나온다 — 그걸 답변으로
      // 세면 전송 경로가 통째로 고장 나도 여기가 초록이다(아래 게이트 단언도 `true === true` 로
      // 통과하고 skip 으로 끝난다).
      r.check(
        "⑨ assistant 답변이 스트리밍돼 패널에 남는다 — 오류·BUSY 안내 문구가 아니다",
        !!answer && !NOT_AN_ANSWER.test(answer.text),
        J((answer?.text || "").slice(0, 120)),
      );
      // 게이트는 `/^## /m` — 렌더 결과에서 그것이 곧 h2 다(### 는 h3 라 걸리지 않는다).
      r.check(
        "⑨ [요약으로 저장] 활성 = 답변이 요약 형식(## 머리글)일 때만",
        !!answer && answer.saveDisabled === !answer.h2,
        J(answer && { h2: answer.h2, saveDisabled: answer.saveDisabled }),
      );

      if (answer && !answer.saveDisabled) {
        await cdp.eval(
          `(()=>{ const a=[...document.querySelectorAll('[data-gpv="report-chat"] [data-role="assistant"]')].pop();
            a.querySelector('[data-gpv="report-chat-save"]').click(); return true; })()`,
        );
        const swapped = await until(
          async () =>
            (await cdp.eval(
              `(()=>{ const c=document.querySelector('[data-gpv="report-card-combined"] .md-body');
                const a=[...document.querySelectorAll('[data-gpv="report-chat"] [data-role="assistant"] .md-body')].pop();
                if(!c||!a) return null;
                return c.innerText.trim() === a.innerText.trim() ? true : null; })()`,
            )) || null,
          15000,
        );
        r.check(
          "⑨ [요약으로 저장] → 카드 본문이 그 답변으로 바뀐다(스트리밍 잔여가 가리지 않는다)",
          swapped === true && genText !== answer.text,
          `생성본=${J((genText || "").slice(0, 40))} 답변=${J(answer.text.slice(0, 40))}`,
        );
      } else {
        // 실패 원인을 skip 사유에 남긴다 — 오류 문구가 답변 자리에 앉아 있으면 여기서 드러난다.
        r.skip(
          "⑨ [요약으로 저장] → 카드 본문 교체",
          `답변이 요약 형식이 아니라 저장 버튼이 잠겨 있다: ${J((answer?.text || "(답변 없음)").slice(0, 80))}`,
        );
      }
    }

    // ── ⑩ 우클릭 → 새 창으로 열기(태스크 67 §3.3) ──
    const arr = (v) => (Array.isArray(v) ? v : []);
    const labels = () =>
      cdp.eval(
        `(async()=>{ try{ const m=await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); }catch(e){ return ['ERR:'+String(e.message||e)]; } })()`,
      );
    // "닫힌다"가 뜻을 가지려면 지금은 열려 있어야 한다.
    const openBefore = await cdp.eval(`window.__gpv.ui.getState().reportOpen`);
    r.check("⑩ 사전 조건 — 메인 리포트 뷰가 열려 있다", openBefore === true, `${openBefore}`);
    const rightClicked = await cdp.eval(`(()=>{
      const b=[...document.querySelectorAll('button')].find(x=>/^작업 리포트/.test(x.title||''));
      if(!b) return 'no-report-button';
      b.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:24}));
      return true; })()`);
    const menuShown = await until(
      async () => (await cdp.eval(`!!document.querySelector('[data-gpv="report-open-window"]')`)) || null,
      5000,
    );
    r.check(
      "⑩ [리포트] 우클릭 메뉴 — '새 창으로 열기' 1항목",
      rightClicked === true && menuShown === true,
      J(rightClicked),
    );
    await cdp.eval(`document.querySelector('[data-gpv="report-open-window"]').click()`);
    const opened = await until(
      async () => (arr(await labels()).includes("doc-report") ? true : null),
      20000,
    );
    r.check("⑩ doc-report OS 창 생성", opened === true, J(arr(await labels())));
    const mainClosed = await until(
      async () => ((await cdp.eval(`window.__gpv.ui.getState().reportOpen`)) === false ? true : null),
      5000,
    );
    r.check("⑩ 메인 리포트 뷰는 닫힌다(공간 회수)", mainClosed === true);
    // 싱글턴 — 라벨이 고정이라 Rust 가 포커스만 준다.
    await cdp.eval(`window.__gpv.openReportWindow()`);
    await sleep(2000);
    const dupes = arr(await labels()).filter((l) => l === "doc-report").length;
    r.check("⑩ 한 번 더 열어도 doc-report 는 1개(싱글턴)", dupes === 1, `${dupes}`);
    await cdp
      .eval(
        `(async()=>{ try{ const m=await import(${J(WIN_API)}); for(const w of await m.getAllWebviewWindows()){ if(w.label==="doc-report") await w.close(); } return true; }catch(e){ return false; } })()`,
      )
      .catch(() => {});

    // ── ⑪ 창 간 요약 동기화(report://changed) ──
    // 리스너는 `useReports` 훅 안에 있다 — 리포트 뷰가 없는 창은 듣지 않는다(⑩ 이 닫았다).
    await cdp.eval(
      `(()=>{ const s=window.__gpv.ui.getState(); if(!s.reportOpen) s.toggleReport(); return true; })()`,
    );
    const cacheReady = await until(
      async () => (await cdp.eval(`!!window.__gpv.queryClient.getQueryData(["reports"])`)) || null,
      15000,
    );
    r.check("⑪ 사전 조건 — 메인 ['reports'] 캐시 존재", cacheReady === true);
    syncKey = `e2e-sync|day|${today}`;
    const has = () =>
      cdp.eval(`!!(window.__gpv.queryClient.getQueryData(["reports"])||{})[${J(syncKey)}]`);
    // 이 키는 어느 UI 도 쓰지 않는다 — 캐시에 나타나는 경로는 이벤트뿐이다
    // (`["reports"]` 는 staleTime Infinity 라 스스로 다시 읽지 않는다).
    r.check("⑪ 사전 조건 — 합성 키가 아직 캐시에 없다", (await has()) === false);
    await cdp.invoke(
      "report_set",
      {
        key: syncKey,
        record: {
          text: "## 한 줄 요약\n창 간 동기화 확인",
          generatedAt: new Date().toISOString(),
          inputHash: "e2e",
          model: "e2e",
        },
      },
      { timeoutMs: 10000 },
    );
    const appeared = await until(async () => (await has()) || null, 5000, 250);
    r.check("⑪ report_set → report://changed 로 메인 캐시에 등장", appeared === true);
    await cdp.invoke("report_delete", { key: syncKey }, { timeoutMs: 10000 });
    const gone = await until(async () => ((await has()) === false ? true : null), 5000, 250);
    r.check("⑪ report_delete → 메인 캐시에서 사라짐", gone === true);
    if (gone === true) syncKey = null;

    // ── ⑫ 모아보기 안의 리포트 = 헤더 탭(2026-09-17 사용자 지적) ──
    // 예전엔 모아보기 중 [리포트]를 눌러도 reportOpen 만 뒤집혀 화면이 그대로였다(App 이 모아보기를
    // 먼저 그린다). 실제 타이틀바 버튼과 헤더 탭을 DOM 클릭으로 누른다 — 스토어 직접 호출로는
    // 버튼 배선이 빠져도 초록이다.
    const ui = (expr) => cdp.eval(`(()=>{ const s=window.__gpv.ui.getState(); return ${expr}; })()`);
    const clickReportButton = () =>
      cdp.eval(`(()=>{ const b=[...document.querySelectorAll('button')].find(x=>/^작업 리포트/.test(x.title||'')); if(!b) return 'no-report-button'; b.click(); return true; })()`);
    const tabState = () =>
      cdp.eval(`(()=>{
        const tab=document.querySelector('[data-aggregate-report-tab]');
        const ov=document.querySelector('[data-aggregate-report]');
        const h=ov ? Math.round(ov.getBoundingClientRect().height) : 0;
        return { tab: !!tab, overlay: !!ov, overlayH: h };
      })()`);
    await ui(`(s.closeReport(), s.setAggregateOpen(true), true)`);
    const aggReady = await until(async () => ((await ui(`s.aggregateOpen`)) === true ? true : null), 5000);
    const before = await tabState();
    r.check(
      "⑫ 사전 조건 — 모아보기 열림 · 리포트 탭 없음",
      aggReady === true && before.tab === false && before.overlay === false,
      J(before),
    );
    const clicked1 = await clickReportButton();
    const shown = await until(async () => {
      const st = await tabState();
      return st.tab && st.overlay && st.overlayH > 100 ? st : null;
    }, 5000);
    r.check(
      "⑫ 모아보기 중 [리포트] → 헤더에 리포트 탭 + 리포트 한 페이지가 그리드를 덮는다(모아보기는 열린 채)",
      clicked1 === true && !!shown && (await ui(`s.aggregateOpen && s.reportOpen && s.aggregateReportActive`)) === true,
      J({ clicked1, shown }),
    );
    await cdp.eval(`document.querySelector('[data-aggregate-report-tab] button').click()`);
    const toGrid = await until(async () => {
      const st = await tabState();
      return st.tab && !st.overlay ? st : null;
    }, 5000);
    r.check("⑫ 리포트 탭 클릭 → 터미널로 돌아간다(탭은 남는다)", !!toGrid, J(toGrid ?? (await tabState())));
    await clickReportButton();
    const again = await until(async () => ((await tabState()).overlay ? true : null), 5000);
    await clickReportButton();
    const againGrid = await until(async () => {
      const st = await tabState();
      return st.tab && !st.overlay ? true : null;
    }, 5000);
    r.check(
      "⑫ [리포트] 버튼: 탭이 뒤에 있으면 앞으로, 이미 앞이면 터미널로(탭은 유지)",
      again === true && againGrid === true,
      J({ again, againGrid }),
    );
    await cdp.eval(`document.querySelector('[data-aggregate-report-tab] button[aria-label="리포트 탭 닫기"]').click()`);
    const closed = await until(async () => {
      const st = await tabState();
      return !st.tab && !st.overlay && (await ui(`s.reportOpen`)) === false ? true : null;
    }, 5000);
    r.check("⑫ 탭의 X → 리포트 탭이 사라지고 reportOpen=false", closed === true, J(await tabState()));
    await ui(`(s.setAggregateOpen(false), true)`);
  } finally {
    // 가짜 전사 **파일만** 지운다(디렉토리는 남긴다 — 사용자 전사 보호).
    try {
      if (existsSync(transcript)) unlinkSync(transcript);
    } catch (e) {
      console.error("전사 정리 경고:", e.message);
    }
    // ⑩ 의 별도 창이 남아 있으면 다음 스위트의 창 열거가 어긋난다.
    await cdp
      .eval(
        `(async()=>{ try{ const m=await import(${J(WIN_API)}); for(const w of await m.getAllWebviewWindows()){ if(w.label==="doc-report") await w.close(); } return true; }catch(e){ return false; } })()`,
      )
      .catch(() => {});
    for (const k of [generatedKey, combinedKey, syncKey]) {
      if (k) await cdp.try("report_delete", { key: k });
    }
    // ⑧b 가 중간에 던졌으면 설정 reportPrompt 가 e2e 값으로 남는다 — 원래 값으로 되돌린다.
    if (prevReportPrompt !== undefined) {
      const cur = await cdp.try("get_settings", {});
      if (cur.ok && (cur.r.reportPrompt ?? null) !== prevReportPrompt)
        await cdp.try("set_settings", { settings: { ...cur.r, reportPrompt: prevReportPrompt } });
    }
    for (const id of [projectId, projectId2]) {
      if (!id) continue;
      await cdp
        .eval(`window.__gpv?.ui?.getState().closeProjectViewerTabs(${J(id)})`)
        .catch(() => {});
      await cdp.try("remove_project", { id });
    }
    // 스코프·채팅 열림은 창 간 공유(localStorage)다 — 이 스위트가 쓴 값을 사용자의 다음 세션까지
    // 물려주지 않되, **원래 값이 있었으면 되돌린다**(지우기만 하면 사용자의 선택이 소거된다).
    const restore = (k, v) =>
      v === null || v === undefined
        ? `localStorage.removeItem(${J(k)})`
        : `localStorage.setItem(${J(k)}, ${J(String(v))})`;
    await cdp
      .eval(
        `(()=>{ try{ ${restore("gp:report-scope", prevScope)}; ${restore("gp:report-chat-open", prevChat)}; }catch(_){} return true; })()`,
      )
      .catch(() => {});
    // ⑫ 가 중간에 던졌으면 모아보기가 열린 채다 — 다음 스위트가 그리드에 가려진 화면을 본다.
    await cdp
      .eval(`(()=>{ const s=window.__gpv.ui.getState(); s.closeReport(); s.setAggregateOpen(false); return true; })()`)
      .catch(() => {});
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.error("리포트 픽스처 정리 경고:", e.message);
    }
  }
}
