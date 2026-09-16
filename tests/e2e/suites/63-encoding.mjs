// 파일 인코딩 왕복 (설계 DOCS/quality-batch-2026-09-design.md B장)
//
// 계약: **열기 `bytes → (text, enc)` · 저장 `(text, enc) → bytes` · enc 는 FileDiff 로 왕복한다.**
//
// 이 스위트의 핵심은 화면이 아니라 **디스크 바이트**다. 예전에는 `from_utf8_lossy` 가 CP949
// 주석을 U+FFFD 로 바꿔 놓고, 그 문자열을 저장하면 원본이 영구 소실됐다 — 화면만 보면
// "한글이 깨져 보인다" 정도로 보이지만 실제로는 파일이 망가진 상태였다. 그래서 여는 것보다
// **저장 뒤 바이트 비교**가 이 스위트의 무게중심이다.

export const name = "파일 인코딩 왕복 (CP949 / BOM / UTF-16)";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const J = JSON.stringify;

/** 바이트 단위 문자열 치환 — latin1 은 바이트↔문자가 1:1 이라 왕복이 무손실이다. */
function patchBytes(buf, from, to) {
  return Buffer.from(buf.toString("latin1").replace(from, to), "latin1");
}

async function poll(fn, ok, tries = 30, gap = 200) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (ok(last)) return last;
    await sleep(gap);
  }
  return last;
}

export async function run({ cdp, report: r, fix }) {
  fix.writeEncodingFixtures();

  const D = (path, encoding) =>
    cdp.invoke("get_file_diff", {
      projectId: fix.projectId,
      target: { mode: "file", path },
      encoding,
    });
  const W = (relPath, content, encoding, bom) =>
    cdp.try("write_file", { projectId: fix.projectId, relPath, content, encoding, bom });

  try {
    // ── ① CP949 파일을 열면 한글이 보인다 (사용자 사례 그대로) ──
    const cp = await D("enc/cp949.h");
    r.check(
      "CP949 열기: 주석이 한글로 보인다",
      !!cp.newContent &&
        cp.newContent.includes("일반 사용") &&
        cp.newContent.includes("연결검사") &&
        !cp.newContent.includes("�"),
      J(cp.newContent?.slice(0, 40)),
    );
    r.check(
      "CP949 열기: 인코딩 정체가 FileDiff 로 온다",
      cp.encoding === "EUC-KR" && cp.bom === false && cp.lossy === false,
      `encoding=${cp.encoding} bom=${cp.bom} lossy=${cp.lossy}`,
    );

    // ── ② 한 줄만 고쳐 저장 → **고친 줄 외 바이트가 완전히 동일**하고 CP949 그대로 ──
    //    이 단언이 없으면 "화면만 고치고 파일을 망가뜨리는" 상태를 못 잡는다.
    const before = fix.readBytes("enc/cp949.h");
    const edited = cp.newContent.replace("#define MAX 10", "#define MAX 20");
    r.check("전제: 편집이 실제로 반영된 문자열", edited !== cp.newContent);
    const w = await W("enc/cp949.h", edited, cp.encoding, cp.bom);
    const after = fix.readBytes("enc/cp949.h");
    const want = patchBytes(before, "#define MAX 10", "#define MAX 20");
    r.check(
      "CP949 저장: 고친 줄 외 바이트 완전 동일 · 인코딩 유지",
      w.ok && after.equals(want),
      w.ok
        ? `want=${want.toString("hex").slice(0, 60)}… got=${after.toString("hex").slice(0, 60)}…`
        : `${w.code} ${w.message}`,
    );
    // 저장 결과를 **다시 읽어도** 한글이다(왕복이 한 바퀴 더 돌아도 안 무너진다).
    const cp2 = await D("enc/cp949.h");
    r.check(
      "CP949 재열기: 여전히 한글 · MAX 20",
      cp2.newContent?.includes("일반 사용") && cp2.newContent.includes("#define MAX 20"),
      J(cp2.newContent?.slice(0, 40)),
    );

    // ── ③ UTF-8 BOM: 첫 글자에 보이지 않는 문자가 없고, 저장 후에도 BOM 유지 ──
    const bomd = await D("enc/utf8bom.txt");
    r.check(
      "UTF-8 BOM: 텍스트 첫 글자가 U+FEFF 가 아니다",
      bomd.newContent?.startsWith("안녕") === true && bomd.bom === true,
      `first=${J(bomd.newContent?.[0])} bom=${bomd.bom}`,
    );
    const bomBefore = fix.readBytes("enc/utf8bom.txt");
    const wb = await W("enc/utf8bom.txt", bomd.newContent, bomd.encoding, bomd.bom);
    r.check(
      "UTF-8 BOM 저장: 바이트 불변(BOM 유지)",
      wb.ok && fix.readBytes("enc/utf8bom.txt").equals(bomBefore),
      wb.ok ? `head=${fix.readBytes("enc/utf8bom.txt").subarray(0, 3).toString("hex")}` : wb.code,
    );

    // ── ④ UTF-16LE 은 텍스트로 열린다(NUL 때문에 바이너리로 안 빠진다 — B-K5) ──
    const u16 = await D("enc/utf16le.txt");
    r.check(
      "UTF-16LE: 바이너리 아님 · 텍스트로 열린다",
      u16.isBinary === false && u16.newContent?.includes("가나다") === true,
      `isBinary=${u16.isBinary} encoding=${u16.encoding} text=${J(u16.newContent?.slice(0, 12))}`,
    );
    const u16Before = fix.readBytes("enc/utf16le.txt");
    const w16 = await W("enc/utf16le.txt", u16.newContent, u16.encoding, u16.bom);
    r.check(
      "UTF-16LE 저장: 바이트 불변(UTF-8 로 변신하지 않는다)",
      w16.ok && fix.readBytes("enc/utf16le.txt").equals(u16Before),
      w16.ok ? `len=${fix.readBytes("enc/utf16le.txt").length} orig=${u16Before.length}` : w16.code,
    );

    // ── ⑤ 표현 불가 문자(이모지)는 **저장을 막는다** — 조용한 `?` 치환 금지(B-K4) ──
    const emojiBefore = fix.readBytes("enc/cp949.h");
    const bad = await W("enc/cp949.h", `${cp2.newContent}// 😀\r\n`, "EUC-KR", false);
    r.check(
      "CP949 + 이모지 → UNMAPPABLE 로 거절",
      !bad.ok && bad.code === "UNMAPPABLE",
      bad.ok ? "(저장돼 버렸다)" : `${bad.code} ${bad.message}`,
    );
    r.check(
      "거절된 저장은 파일을 건드리지 않는다",
      fix.readBytes("enc/cp949.h").equals(emojiBefore),
    );

    // ── ⑥ 기존 UTF-8 파일의 동작은 바이트 단위로 같다(되돌리기 어려운 변경의 회귀 반증) ──
    const u8 = await D("enc/utf8.txt");
    const u8Before = fix.readBytes("enc/utf8.txt");
    r.check(
      "UTF-8: 인코딩 정체 = UTF-8 · BOM 없음",
      u8.encoding === "UTF-8" && u8.bom === false && u8.lossy === false,
      `encoding=${u8.encoding} bom=${u8.bom}`,
    );
    const wPlain = await W("enc/utf8.txt", u8.newContent); // 인자 생략 = 기존 동작
    r.check(
      "UTF-8: 인코딩 인자 없이 저장해도 바이트 불변",
      wPlain.ok && fix.readBytes("enc/utf8.txt").equals(u8Before),
      wPlain.code || "",
    );
    const wEnc = await W("enc/utf8.txt", u8.newContent, u8.encoding, u8.bom);
    r.check(
      "UTF-8: 인코딩 동봉 저장도 바이트 불변",
      wEnc.ok && fix.readBytes("enc/utf8.txt").equals(u8Before),
      wEnc.code || "",
    );

    // ── ⑦ 다른 인코딩으로 다시 열기(B-K6) — 사람이 탐지를 뒤집을 수 있다 ──
    const forced = await D("enc/cp949.h", "windows-1252");
    r.check(
      "강제 인코딩: 탐지를 무시하고 지정한 인코딩으로 읽는다",
      forced.encoding === "windows-1252" && !forced.newContent.includes("일반"),
      `encoding=${forced.encoding}`,
    );

    // ── ⑧ 형제 경로(B-K7): 검색 결과 줄도 한글로 온다 ──
    //    뷰어만 고치면 "보이는데 검색 결과만 깨지는" 새 이상 상태가 생긴다.
    const sr = await cdp.invoke("search_in_project", {
      projectId: fix.projectId,
      query: "//",
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      include: ["*.h"],
    });
    const hFile = sr.files.find((f) => f.path === "enc/cp949.h");
    const hText = (hFile?.matches ?? []).map((m) => m.text).join("\n");
    r.check(
      "검색 결과: CP949 파일의 주석이 한글로 온다(U+FFFD 없음)",
      hText.includes("일반 사용") && !hText.includes("�"),
      J(hText.slice(0, 60)),
    );

    // ── ⑨ 프론트 저장 경로 — 확인창이 뜨고, 취소하면 파일이 그대로다 ──
    //
    // 이 검사가 진짜로 잡는 것: **뷰어가 저장할 때 인코딩을 동봉하는가.** 동봉을 빠뜨리면
    // 백엔드는 UTF-8 로 조용히 성공하고(=CP949 파일이 UTF-8 로 변환되고) 확인창이 아예
    // 뜨지 않는다. 그래서 "확인창이 떴다"가 곧 "인코딩이 왕복했다"의 증거다.
    const hasStore = await cdp.eval(`!!window.__gpv && !!window.__monaco`);
    if (!hasStore) {
      r.skip("뷰어 저장 확인창", "window.__gpv/__monaco 미노출(dev 빌드 아님) — 스킵");
    } else {
      // 앞 스위트가 남긴 화면 상태(분할 패널·최대화·모달·모아보기)를 먼저 걷어낸다 — 전체 회차에서
      // 그대로 열면 에디터가 다른 패널에 뜨거나 모달에 가려, 12초를 기다리다 헛되이 빨개진다(실측).
      await cdp.eval(`(()=>{ const u = window.__gpv.ui.getState();
        u.setAggregateOpen(false);
        u.closeGitDialog(); u.closeFileTreeDialog(); u.closeConfirm(); u.closePrompt();
        window.__gpv.ui.setState({
          viewerLayout: { kind: "leaf", paneId: "enc-pane" },
          viewerActivePaneId: "enc-pane",
          viewerByPane: {}, viewerMaximizedPaneId: null,
          selectedDiff: null, selectedDiffRepoId: null,
        });
        u.selectProject(${J(fix.projectId)});
        window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, "viewer");
        u.selectDiff({ mode: "file", path: "enc/cp949.h" });
      })()`);
      // 에디터가 그 파일 내용으로 뜰 때까지 기다린다.
      const ready = await poll(
        () =>
          cdp.eval(
            `(()=>{ const eds = window.__monaco.editor.getEditors();
               return eds.some(e => (e.getModel()?.getValue() ?? "").includes("일반 사용")); })()`,
          ),
        (v) => v === true,
        40,
        300,
      );
      if (ready !== true) {
        r.check("뷰어에 CP949 파일이 열린다", false, "에디터 내용 대기 시간 초과");
      } else {
        const uiBefore = fix.readBytes("enc/cp949.h");
        // 이모지를 넣고 뷰어의 저장 액션(Ctrl+S 와 같은 것)을 실행한다.
        const ran = await cdp.eval(`(()=>{
          const ed = window.__monaco.editor.getEditors()
            .find(e => (e.getModel()?.getValue() ?? "").includes("일반 사용"));
          if (!ed) return "no-editor";
          if (ed.getOption(window.__monaco.editor.EditorOption.readOnly)) return "read-only";
          ed.setValue(ed.getValue() + "// \u{1F600}\\r\\n");
          const a = ed.getAction("gp.save");
          if (!a) return "no-action";
          a.run();
          return "ok";
        })()`);
        r.check("뷰어 저장 액션 실행", ran === "ok", String(ran));
        const asked = await poll(
          () => cdp.eval(`(window.__gpv.ui.getState().confirm?.confirmLabel) ?? null`),
          (v) => v === "UTF-8 로 저장",
          25,
          200,
        );
        r.check(
          "표현 불가 문자 → 확인창(UTF-8 로 저장 / 취소)",
          asked === "UTF-8 로 저장",
          `confirmLabel=${J(asked)}`,
        );
        // 확인창의 [취소]를 실제 DOM 에서 누른다(호스트 배선까지 함께 검증).
        const clicked = await cdp.eval(`(()=>{
          const ok = [...document.querySelectorAll('button')]
            .find(b => b.textContent.trim() === 'UTF-8 로 저장');
          const cancel = ok?.parentElement?.querySelector('button');
          if (!cancel || cancel === ok) return false;
          cancel.click();
          return true;
        })()`);
        const closed = await poll(
          () => cdp.eval(`window.__gpv.ui.getState().confirm === null`),
          (v) => v === true,
          15,
          200,
        );
        r.check("취소 클릭으로 확인창이 닫힌다", clicked === true && closed === true);
        await sleep(300); // 취소 뒤에도 늦게 쓰는 경로가 없는지 잠깐 기다렸다 본다
        r.check(
          "취소하면 파일이 그대로다(디스크 바이트 불변)",
          fix.readBytes("enc/cp949.h").equals(uiBefore),
          `len=${fix.readBytes("enc/cp949.h").length} orig=${uiBefore.length}`,
        );
      }
      await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
    }
  } finally {
    // 다른 스위트의 status·검색·트리 단언에 새지 않게 통째로 지운다.
    await cdp.eval(`window.__gpv?.ui?.getState?.().selectDiff(null)`).catch(() => {});
    fix.removeEncodingFixtures();
  }
}
