// 트리 파일 작업 커맨드 — create_dir(새 폴더) / delete_path(삭제) / write_file_bytes(이미지
// 변환·편집 저장). 픽스처 레포에서 invoke + 디스크 반영/경로 탈출 차단을 단언하고, 잔여는 정리한다.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const name =
  "트리 파일 작업 (create_dir / delete_path / write_file_bytes)";

// 1x1 PNG — write_file_bytes는 바이트를 그대로 쓰므로 내용 자체는 무관하다.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export async function run({ cdp, report: r, fix }) {
  const has = (rel) => existsSync(join(fix.repo, rel));
  const P = (relPath) => ({ projectId: fix.projectId, relPath });

  // ── create_dir ──
  const mk = await cdp.try("create_dir", P("e2e-newdir"));
  r.check(
    "create_dir: 새 폴더 생성",
    mk.ok && has("e2e-newdir"),
    mk.ok ? "(생성됨)" : mk.code,
  );

  const dup = await cdp.try("create_dir", P("e2e-newdir"));
  r.check("create_dir: 중복 → 오류", !dup.ok, dup.code || "(ok?)");

  const mkEsc = await cdp.try("create_dir", P("../escape-dir"));
  r.check(
    "create_dir: '..' 경로 거부",
    !mkEsc.ok && mkEsc.code === "IO",
    mkEsc.code || "(ok?)",
  );

  const mkGit = await cdp.try("create_dir", P(".git/evil"));
  r.check("create_dir: .git 진입 거부", !mkGit.ok, mkGit.code || "(ok?)");

  // ── create_file (임의 확장자) ──
  const cf = await cdp.try("create_file", P("e2e-newdir/main.py"));
  r.check(
    "create_file: 새 파일 생성",
    cf.ok && has("e2e-newdir/main.py"),
    cf.ok ? "(생성됨)" : cf.code,
  );
  const cfDup = await cdp.try("create_file", P("e2e-newdir/main.py"));
  r.check(
    "create_file: 중복 → ALREADY_EXISTS",
    !cfDup.ok && cfDup.code === "ALREADY_EXISTS",
    cfDup.code || "(ok?)",
  );
  const cfEsc = await cdp.try("create_file", P("../escape.py"));
  r.check(
    "create_file: '..' 경로 거부",
    !cfEsc.ok && cfEsc.code === "IO",
    cfEsc.code || "(ok?)",
  );
  const cfGit = await cdp.try("create_file", P(".git/evil.py"));
  r.check("create_file: .git 진입 거부", !cfGit.ok, cfGit.code || "(ok?)");
  // 윈도우 예약 장치명 — 확장자가 붙어도 거부(CON.txt 류).
  const cfReserved = await cdp.try("create_file", P("CON.txt"));
  r.check(
    "create_file: 예약 장치명(CON.txt) 거부",
    !cfReserved.ok && cfReserved.code === "IO",
    cfReserved.code || "(ok?)",
  );
  await cdp.try("delete_path", P("e2e-newdir/main.py"));

  // ── 윈도우 정규화 .git 우회 차단 (CVE-2019-1352 류) ──
  const gitDot = await cdp.try("create_dir", P(".git./evil"));
  r.check(
    "create_dir: '.git.' (끝점) 우회 거부",
    !gitDot.ok && gitDot.code === "IO",
    gitDot.code || "(ok?)",
  );
  const gitAds = await cdp.try("write_file_bytes", {
    ...P(".git::$INDEX_ALLOCATION/x"),
    base64: PNG_B64,
    overwrite: true,
  });
  r.check(
    "write_file_bytes: '.git::$INDEX_ALLOCATION' 우회 거부",
    !gitAds.ok && gitAds.code === "IO",
    gitAds.code || "(ok?)",
  );

  // ── write_file_bytes (이미지 변환·편집 저장) ──
  const wb = await cdp.try(
    "write_file_bytes",
    { ...P("e2e-newdir/pixel.png"), base64: PNG_B64, overwrite: false },
    { timeoutMs: 15000 },
  );
  r.check(
    "write_file_bytes: 새 파일 기록",
    wb.ok && has("e2e-newdir/pixel.png"),
    wb.ok ? "(기록됨)" : wb.code,
  );

  // 같은 경로 재기록(overwrite=false) → ALREADY_EXISTS, overwrite=true → 성공
  const wbConflict = await cdp.try("write_file_bytes", {
    ...P("e2e-newdir/pixel.png"),
    base64: PNG_B64,
    overwrite: false,
  });
  r.check(
    "write_file_bytes: 충돌(overwrite=false) → ALREADY_EXISTS",
    !wbConflict.ok && wbConflict.code === "ALREADY_EXISTS",
    wbConflict.code || "(ok?)",
  );
  const wbOver = await cdp.try("write_file_bytes", {
    ...P("e2e-newdir/pixel.png"),
    base64: PNG_B64,
    overwrite: true,
  });
  r.check("write_file_bytes: overwrite=true → 성공", wbOver.ok, wbOver.code || "");

  // ── expected_stamp: 읽은 뒤 남이 바꿨으면 거절한다 ──
  //
  // 종전에는 overwrite=true 면 아무 검사 없이 덮어썼다 — 이미지 편집기를 열어 둔 사이 외부
  // 도구가 그 파일을 바꾸면 [저장]이 그 변경을 **말없이** 날렸다(가드는 !overwrite 경로 전용).
  // 스탬프는 read_file_base64 가 준 불투명 문자열이고, 프론트는 그걸 그대로 되돌려 준다.
  const rd1 = await cdp.try("read_file_base64", P("e2e-newdir/pixel.png"));
  const stamp1 = rd1.ok && rd1.r ? rd1.r.stamp : null;
  if (r.check("read_file_base64: stamp 를 함께 준다", !!stamp1, stamp1 || "(없음)")) {
    // 같은 스탬프로 쓰면 통과해야 한다(정상 저장이 막히면 기능이 죽는다).
    const wbSame = await cdp.try("write_file_bytes", {
      ...P("e2e-newdir/pixel.png"),
      base64: PNG_B64,
      overwrite: true,
      expectedStamp: stamp1,
    });
    r.check(
      "write_file_bytes: 스탬프 일치 → 저장 성공",
      wbSame.ok,
      wbSame.code || "",
    );
    // 방금 쓴 것 자체가 mtime 을 바꿨다 → 옛 스탬프는 이제 stale 이다.
    const wbStale = await cdp.try("write_file_bytes", {
      ...P("e2e-newdir/pixel.png"),
      base64: PNG_B64,
      overwrite: true,
      expectedStamp: stamp1,
    });
    r.check(
      "write_file_bytes: 스탬프 불일치 → CONFLICT (무성 덮어쓰기 차단)",
      !wbStale.ok && wbStale.code === "CONFLICT",
      wbStale.code || "(ok? — 덮어써 버렸다)",
    );
    // 스탬프를 빼면 종전 동작 그대로 통과한다(기존 호출부·"그래도 저장" 재시도 경로).
    const wbForce = await cdp.try("write_file_bytes", {
      ...P("e2e-newdir/pixel.png"),
      base64: PNG_B64,
      overwrite: true,
    });
    r.check(
      "write_file_bytes: 스탬프 생략 → 종전대로 저장(재시도 경로)",
      wbForce.ok,
      wbForce.code || "",
    );
  }

  const wbBad = await cdp.try("write_file_bytes", {
    ...P("e2e-newdir/x.png"),
    base64: "@@@ not-valid-base64 @@@",
    overwrite: true,
  });
  r.check(
    "write_file_bytes: 잘못된 base64 → 오류",
    !wbBad.ok,
    wbBad.code || "(ok?)",
  );

  const wbEsc = await cdp.try("write_file_bytes", {
    ...P("../escape.png"),
    base64: PNG_B64,
    overwrite: true,
  });
  r.check(
    "write_file_bytes: '..' 경로 거부",
    !wbEsc.ok && wbEsc.code === "IO",
    wbEsc.code || "(ok?)",
  );

  // ── rename_path (같은 폴더 안 이름만 변경 — 이동이 아니다) ──
  // 자기 완결 픽스처(e2e-rename)를 따로 쓴다 — 위 단언들이 쓰는 e2e-newdir 를 건드리지 않게.
  await cdp.try("create_dir", P("e2e-rename"));
  await cdp.try("create_file", P("e2e-rename/old.txt"));

  const rn = await cdp.try("rename_path", {
    ...P("e2e-rename/old.txt"),
    newName: "new.txt",
  });
  r.check(
    "rename_path: 파일 이름 변경",
    rn.ok &&
      rn.r === "e2e-rename/new.txt" &&
      has("e2e-rename/new.txt") &&
      !has("e2e-rename/old.txt"),
    rn.ok ? `→ ${rn.r}` : rn.code,
  );

  // 이미 있는 이름으로는 덮어쓰지 않는다(데이터 손실 방지).
  await cdp.try("create_file", P("e2e-rename/other.txt"));
  const rnDup = await cdp.try("rename_path", {
    ...P("e2e-rename/new.txt"),
    newName: "other.txt",
  });
  r.check(
    "rename_path: 기존 이름 충돌 → ALREADY_EXISTS",
    !rnDup.ok && rnDup.code === "ALREADY_EXISTS" && has("e2e-rename/new.txt"),
    rnDup.code || "(ok?)",
  );

  // 구분자가 들어오면 '이동'이 되므로 계약상 거부한다.
  for (const [label, name] of [
    ["슬래시", "sub/x.txt"],
    ["역슬래시", "sub\\x.txt"],
    ["상위(..)", ".."],
  ]) {
    const bad = await cdp.try("rename_path", {
      ...P("e2e-rename/new.txt"),
      newName: name,
    });
    r.check(
      `rename_path: ${label} 이름 거부`,
      !bad.ok && bad.code === "IO",
      bad.code || "(ok?)",
    );
  }

  // 윈도우 예약 장치명 — 확장자가 붙어도 거부(create_file 과 같은 방어).
  const rnReserved = await cdp.try("rename_path", {
    ...P("e2e-rename/new.txt"),
    newName: "CON.txt",
  });
  r.check(
    "rename_path: 예약 장치명(CON.txt) 거부",
    !rnReserved.ok && rnReserved.code === "IO",
    rnReserved.code || "(ok?)",
  );

  const rnGit = await cdp.try("rename_path", { ...P(".git"), newName: "git-old" });
  r.check("rename_path: .git 거부", !rnGit.ok, rnGit.code || "(ok?)");

  const rnEsc = await cdp.try("rename_path", {
    ...P("../escape.txt"),
    newName: "x.txt",
  });
  r.check(
    "rename_path: '..' 원본 경로 거부",
    !rnEsc.ok && rnEsc.code === "IO",
    rnEsc.code || "(ok?)",
  );

  const rnMissing = await cdp.try("rename_path", {
    ...P("__missing_xyz__"),
    newName: "y.txt",
  });
  r.check(
    "rename_path: 없는 대상 → NOT_FOUND",
    !rnMissing.ok && rnMissing.code === "NOT_FOUND",
    rnMissing.code || "(ok?)",
  );

  const rnRoot = await cdp.try("rename_path", { ...P(""), newName: "x" });
  r.check("rename_path: 루트(빈 경로) 거부", !rnRoot.ok, rnRoot.code || "(ok?)");

  // 폴더 이름 변경 — 안의 파일이 새 경로로 함께 따라와야 한다.
  const rnDir = await cdp.try("rename_path", {
    ...P("e2e-rename"),
    newName: "e2e-renamed",
  });
  r.check(
    "rename_path: 폴더 이름 변경(하위 유지)",
    rnDir.ok &&
      rnDir.r === "e2e-renamed" &&
      has("e2e-renamed/new.txt") &&
      !has("e2e-rename"),
    rnDir.ok ? `→ ${rnDir.r}` : rnDir.code,
  );
  await cdp.try("delete_path", P("e2e-renamed"));

  // ── move_path (이름 그대로 다른 폴더로 — 트리 드래그 앤 드롭) ──
  await cdp.try("create_dir", P("e2e-move"));
  await cdp.try("create_dir", P("e2e-move/sub"));
  await cdp.try("create_file", P("e2e-move/a.txt"));

  const mv = await cdp.try("move_path", {
    ...P("e2e-move/a.txt"),
    destDir: "e2e-move/sub",
  });
  r.check(
    "move_path: 파일을 하위 폴더로 이동",
    mv.ok &&
      mv.r === "e2e-move/sub/a.txt" &&
      has("e2e-move/sub/a.txt") &&
      !has("e2e-move/a.txt"),
    mv.ok ? `→ ${mv.r}` : mv.code,
  );

  const mvRoot = await cdp.try("move_path", {
    ...P("e2e-move/sub/a.txt"),
    destDir: "",
  });
  r.check(
    "move_path: 루트(빈 destDir)로 이동",
    mvRoot.ok && mvRoot.r === "a.txt" && has("a.txt"),
    mvRoot.ok ? `→ ${mvRoot.r}` : mvRoot.code,
  );

  // 기존 파일은 덮어쓰지 않는다.
  await cdp.try("create_file", P("e2e-move/a.txt"));
  const mvDup = await cdp.try("move_path", { ...P("a.txt"), destDir: "e2e-move" });
  r.check(
    "move_path: 대상에 같은 이름 → ALREADY_EXISTS",
    !mvDup.ok && mvDup.code === "ALREADY_EXISTS" && has("a.txt"),
    mvDup.code || "(ok?)",
  );
  await cdp.try("delete_path", P("a.txt"));

  // 폴더를 자기 자신/자손 안으로 — rename이 소스를 삼키는 유형이라 반드시 거부.
  const mvSelf = await cdp.try("move_path", {
    ...P("e2e-move"),
    destDir: "e2e-move/sub",
  });
  r.check(
    "move_path: 폴더 → 자기 자손 거부",
    !mvSelf.ok && mvSelf.code === "IO" && has("e2e-move/sub"),
    mvSelf.code || "(ok?)",
  );

  const mvEsc = await cdp.try("move_path", { ...P("e2e-move/a.txt"), destDir: ".." });
  r.check("move_path: '..' destDir 거부", !mvEsc.ok, mvEsc.code || "(ok?)");
  const mvGit = await cdp.try("move_path", {
    ...P("e2e-move/a.txt"),
    destDir: ".git",
  });
  r.check("move_path: .git destDir 거부", !mvGit.ok, mvGit.code || "(ok?)");
  const mvMissing = await cdp.try("move_path", {
    ...P("__missing_xyz__"),
    destDir: "e2e-move",
  });
  r.check(
    "move_path: 없는 원본 → NOT_FOUND",
    !mvMissing.ok && mvMissing.code === "NOT_FOUND",
    mvMissing.code || "(ok?)",
  );

  // ── start_os_file_drag (트리 → 앱 밖 OS 드래그) ──
  // 버튼이 안 눌린 채 OS 드래그가 시작되면 다음 마우스 이동 때 **실제 커서 밑 창**에 파일이 떨어진다.
  // Windows 는 커맨드가 물리 버튼을 보고 거르지만(아래 마지막 단언), macOS·Linux 에는 그 가드가 없으므로
  // 그 OS 에서는 유효 경로로 부르지 마라. 경로 검증 단언은 전부 드래그 전에 거절된다.
  const D = (relPaths) => ({ projectId: fix.projectId, relPaths });
  const dragEsc = await cdp.try("start_os_file_drag", D(["../escape.txt"]));
  r.check("start_os_file_drag: '..' 경로 거부", !dragEsc.ok && dragEsc.code === "IO", dragEsc.code || "(ok?)");
  const dragGit = await cdp.try("start_os_file_drag", D([".git/config"]));
  r.check("start_os_file_drag: .git 경로 거부", !dragGit.ok, dragGit.code || "(ok?)");
  const dragMissing = await cdp.try("start_os_file_drag", D(["__missing_xyz__"]));
  r.check(
    "start_os_file_drag: 없는 파일 → NOT_FOUND",
    !dragMissing.ok && dragMissing.code === "NOT_FOUND",
    dragMissing.code || "(ok?)",
  );
  // 유효 경로가 앞에 있어도 하나라도 틀리면 드래그 없이 통째로 거절 — 일부만 내보내지 않는다.
  const dragMixed = await cdp.try("start_os_file_drag", D(["e2e-move/a.txt", "../escape.txt"]));
  r.check(
    "start_os_file_drag: 섞인 목록 통째 거부",
    !dragMixed.ok && dragMixed.code === "IO" && has("e2e-move/a.txt"),
    dragMixed.code || "(ok?)",
  );
  if (process.platform === "win32") {
    // 러너는 마우스를 누르지 않는다 — 가드가 빠지면 이 호출이 앱 메인 스레드를 붙잡고 다음 마우스 이동 때
    // 사용자 커서 밑에 a.txt 를 떨어뜨린다(2026-09-23 실제로 그렇게 걸렸다).
    const dragNoButton = await cdp.try("start_os_file_drag", D(["e2e-move/a.txt"]), { timeoutMs: 5000 });
    r.check(
      "start_os_file_drag: 버튼이 안 눌려 있으면 시작 안 함(false)",
      dragNoButton.ok && dragNoButton.r === false,
      dragNoButton.ok ? `→ ${dragNoButton.r}` : dragNoButton.code,
    );
  }

  // 폴더 이동 — 하위 파일이 함께 따라온다.
  await cdp.try("create_file", P("e2e-move/sub/deep.txt"));
  const mvDir = await cdp.try("move_path", { ...P("e2e-move/sub"), destDir: "" });
  r.check(
    "move_path: 폴더 이동(하위 유지)",
    mvDir.ok && mvDir.r === "sub" && has("sub/deep.txt") && !has("e2e-move/sub"),
    mvDir.ok ? `→ ${mvDir.r}` : mvDir.code,
  );
  await cdp.try("delete_path", P("sub"));
  await cdp.try("delete_path", P("e2e-move"));

  // ── delete_path ──
  const delFile = await cdp.try("delete_path", P("e2e-newdir/pixel.png"));
  r.check(
    "delete_path: 파일 삭제",
    delFile.ok && !has("e2e-newdir/pixel.png"),
    delFile.ok ? "(삭제됨)" : delFile.code,
  );

  const delDir = await cdp.try("delete_path", P("e2e-newdir"));
  r.check(
    "delete_path: 폴더 재귀 삭제",
    delDir.ok && !has("e2e-newdir"),
    delDir.ok ? "(삭제됨)" : delDir.code,
  );

  const delMissing = await cdp.try("delete_path", P("__missing_xyz__"));
  r.check("delete_path: 없는 대상 → 오류", !delMissing.ok, delMissing.code || "(ok?)");

  const delRoot = await cdp.try("delete_path", P(""));
  r.check("delete_path: 루트(빈 경로) 거부", !delRoot.ok, delRoot.code || "(ok?)");

  const delGit = await cdp.try("delete_path", P(".git"));
  r.check("delete_path: .git 거부", !delGit.ok, delGit.code || "(ok?)");

  // ── run_executable (오류 경로만 — 실제 프로세스는 띄우지 않는다) ──
  const runMissing = await cdp.try("run_executable", P("__nope__.exe"));
  r.check(
    "run_executable: 없는 파일 → NOT_FOUND",
    !runMissing.ok && runMissing.code === "NOT_FOUND",
    runMissing.code || "(ok?)",
  );
  const runEsc = await cdp.try("run_executable", P("../escape.exe"));
  r.check(
    "run_executable: '..' 경로 거부",
    !runEsc.ok && runEsc.code === "IO",
    runEsc.code || "(ok?)",
  );
  const runGit = await cdp.try("run_executable", P(".git/hooks/x"));
  r.check("run_executable: .git 거부", !runGit.ok, runGit.code || "(ok?)");

  // 정리 — 잔여 픽스처 디렉토리 제거(방어적, 이미 지워졌으면 무해).
  await cdp.try("delete_path", P("e2e-newdir"));

  // ── F2 = 마지막으로 누른 트리 행 이름 바꾸기 (사용자 요청 2026-09-30) ──
  // 판정은 트리 포커스가 아니라 "마지막 포인터가 트리 행이었나"다(파일을 열면 뷰어가 포커스를 가져간다) — 그래서
  // 행에 pointerdown을 쏘고 F2는 body에 쏜다. 트리 밖을 누른 뒤의 F2는 창을 열면 안 된다.
  const J = JSON.stringify;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const DIR = "e2e-f2";
  const FILE = `${DIR}/target.txt`;
  await cdp.try("create_dir", P(DIR));
  await cdp.try("create_file", P(FILE));
  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  try {
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`);
    await sleep(400);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, "viewer")`);
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ${J(["dir", fix.projectId])} })`);
    const press = (sel) =>
      cdp.eval(`(()=>{
        const el = [...document.querySelectorAll(${J(sel)})].find((e) => e.offsetWidth > 0);
        if (!el) return 'none';
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 'ok';
      })()`);
    const f2 = () =>
      cdp.eval(`(()=>{ document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
        return true; })()`);
    const prompt = async () => {
      for (let i = 0; i < 10; i++) {
        const p = await cdp.eval(`(()=>{ const p = window.__gpv.ui.getState().prompt; return p ? p.defaultValue ?? '' : null; })()`);
        if (p !== null) return p;
        await sleep(100);
      }
      return null;
    };
    const closePrompt = () => cdp.eval(`window.__gpv.ui.getState().closePrompt()`);
    const DIR_ROW = `[data-tree-row][data-tree-path=${J(DIR)}][data-tree-isdir="1"]`;
    const FILE_ROW = `[data-tree-row][data-tree-file=${J(FILE)}]`;
    let dirOk = "none";
    for (let i = 0; i < 20 && dirOk !== "ok"; i++) {
      dirOk = await cdp.eval(`!![...document.querySelectorAll(${J(DIR_ROW)})].find((e) => e.offsetWidth > 0) ? 'ok' : 'none'`);
      if (dirOk !== "ok") await sleep(250);
    }
    if (dirOk !== "ok") {
      r.skip("F2 이름 바꾸기", "트리에 픽스처 폴더 행이 보이지 않음(패널 접힘 등)");
      return;
    }
    await closePrompt();
    await press(DIR_ROW); // 펼친다
    let fileOk = "none";
    for (let i = 0; i < 20 && fileOk !== "ok"; i++) {
      fileOk = await cdp.eval(`!![...document.querySelectorAll(${J(FILE_ROW)})].find((e) => e.offsetWidth > 0) ? 'ok' : 'none'`);
      if (fileOk !== "ok") await sleep(250);
    }
    await press(FILE_ROW);
    await f2();
    const pf = await prompt();
    r.check("F2: 누른 파일 행 → 이름 바꾸기 창(기본값 = 그 파일 이름)", fileOk === "ok" && pf === "target.txt", `row=${fileOk} prompt=${J(pf)}`);
    await closePrompt();
    await press(DIR_ROW);
    await f2();
    const pd = await prompt();
    r.check("F2: 누른 폴더 행 → 폴더 이름 바꾸기 창", pd === DIR, `prompt=${J(pd)}`);
    await closePrompt();
    // 트리 밖을 누른 뒤 — 옛 행을 기억해 엉뚱한 파일 이름을 바꾸려 들면 안 된다.
    await cdp.eval(`(()=>{ document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); return true; })()`);
    await f2();
    await sleep(300);
    const pn = await cdp.eval(`window.__gpv.ui.getState().prompt`);
    r.check("F2: 트리 밖을 누른 뒤에는 창이 열리지 않는다", pn === null, J(pn));
  } finally {
    await closePromptSafe(cdp);
    await cdp.try("delete_path", P(DIR));
    if (origSel) await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`).catch(() => {});
  }
}

async function closePromptSafe(cdp) {
  await cdp.eval(`window.__gpv.ui.getState().closePrompt()`).catch(() => {});
}
