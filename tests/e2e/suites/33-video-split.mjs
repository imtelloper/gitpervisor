// 동영상 타임틱 분할 (DOCS/task/22-video-timetick-split.md §7.1) — planSegments(순수) +
// videoSplit 배치 루프(순차 export · 덮어쓰기 확인 · 취소 후 완료분 유지 · ffmpeg 잔존 0).
//
// 백엔드는 기존 video_export를 그대로 쓴다 — 여기서 검증하는 것은 **프론트 배치 계약**이다.
// 실제 파일이 생기는지·길이 합이 원본과 맞는지까지 디스크에서 교차검증한다.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const name = "동영상 타임틱 분할 (planSegments / videoSplit 배치)";

const SRC = "e2e-split.mp4";
const FOLDER = "e2e-split.split";
const BIG = "e2e-split-big.mp4";
const BIG_FOLDER = "e2e-split-big.split";

/** cond()가 참을 돌려줄 때까지 폴링. 반환값이 곧 결과(타임아웃이면 마지막 값). */
async function waitFor(cond, timeoutMs, stepMs = 200) {
  const until = Date.now() + timeoutMs;
  let last = await cond();
  while (!last && Date.now() < until) {
    await new Promise((res) => setTimeout(res, stepMs));
    last = await cond();
  }
  return last;
}

function probeDuration(file) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  return Number(out.trim());
}

/** 살아있는 ffmpeg 프로세스 수 — 취소 후 잔존 확인용(win32 외엔 null = 검사 생략). */
function ffmpegCount() {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq ffmpeg.exe", "/NH"], {
      encoding: "utf8",
    });
    return out.split("\n").filter((l) => /ffmpeg\.exe/i.test(l)).length;
  } catch {
    return null;
  }
}

export async function run({ cdp, report: r, fix }) {
  const tool = await cdp.try("video_tool_status", {});
  if (!tool.ok || !tool.r?.found || !tool.r?.probeFound) {
    r.skip("동영상 분할 전체", "ffmpeg/ffprobe 미발견");
    return;
  }

  const gpv = await cdp.eval("typeof window.__gpv?.planSegments");
  if (gpv !== "function") {
    r.skip("동영상 분할 전체", "__gpv.planSegments 없음(release 빌드?)");
    return;
  }

  const srcPath = join(fix.repo, SRC);
  const outDir = join(fix.repo, FOLDER);
  const parts = () =>
    existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".mp4")).sort() : [];

  // ── 1. 테스트 영상(6초, 키프레임 1초 간격) ──
  try {
    execFileSync(
      "ffmpeg",
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-g", "30", "-pix_fmt", "yuv420p", "-shortest", srcPath,
      ],
      { encoding: "utf8" },
    );
  } catch (e) {
    r.check("테스트 영상 생성", false, e.message);
    return;
  }
  r.check("테스트 영상 생성 (6초 h264+aac)", existsSync(srcPath), `${SRC}`);

  // ── 2. planSegments — 정렬·클램프·100ms 병합 ──
  const segs = await cdp.eval("window.__gpv.planSegments([2, 4, 4.05], 6)");
  r.check(
    "planSegments: 100ms 미만 이웃 병합 → 3세그먼트",
    Array.isArray(segs) && segs.length === 3,
    `${segs?.length}개`,
  );
  r.check(
    "planSegments: 경계가 [0,2000] [2000,4000] [4000,6000]",
    JSON.stringify(segs) ===
      JSON.stringify([
        { startMs: 0, endMs: 2000 },
        { startMs: 2000, endMs: 4000 },
        { startMs: 4000, endMs: 6000 },
      ]),
    JSON.stringify(segs),
  );
  const edge = await cdp.eval("window.__gpv.planSegments([-1, 0, 6, 9], 6)");
  r.check(
    "planSegments: 범위 밖 틱 제거 → 세그먼트 1개(전체)",
    Array.isArray(edge) && edge.length === 1 && edge[0].endMs === 6000,
    JSON.stringify(edge),
  );

  // ── 3. 배치 실행 (copy 모드) ──
  const startExpr = (folder, src, stem, mode, segments) => `(()=>{
    window.__gpv.ui.setState({ toasts: [] });
    void window.__gpv.videoSplit.getState().start(${JSON.stringify(fix.projectId)},
      ${JSON.stringify(src)}, "", ${JSON.stringify(segments)},
      { folder: ${JSON.stringify(folder)}, mode: ${JSON.stringify(mode)},
        stem: ${JSON.stringify(stem)}, durationMs: 6000, hasAudio: true });
    return true;
  })()`;
  const batchNull = () => cdp.eval("window.__gpv.videoSplit.getState().batch === null");

  await cdp.eval(startExpr(FOLDER, SRC, "e2e-split", "copy", segs));
  const started = await waitFor(
    () => cdp.eval("window.__gpv.videoSplit.getState().batch !== null"),
    5000,
    50,
  );
  r.check("배치 시작: 스토어에 batch 생성", started, started ? "" : "(batch가 안 생김)");

  const finished = await waitFor(batchNull, 60000);
  r.check("배치 완료: batch null 로 정리", finished, finished ? "" : "60s 초과");
  r.check(
    "산출물: <stem>.part-01~03.mp4 3개",
    parts().length === 3 &&
      parts().every((f, i) => f === `e2e-split.part-0${i + 1}.mp4`),
    parts().join(", ") || "(없음)",
  );

  // 요약 토스트는 배치당 정확히 1개 — 세그먼트마다 뜨면 안 된다(events.ts owns() 위임).
  const toasts = await cdp.eval(
    "window.__gpv.ui.getState().toasts.map(t => t.kind + ':' + t.message)",
  );
  r.check(
    "토스트: 요약 1개만(세그먼트별 중복 없음)",
    Array.isArray(toasts) && toasts.length === 1 && /분할 저장/.test(toasts[0]),
    JSON.stringify(toasts),
  );

  // ── 4. 길이 합 — copy는 키프레임 스냅이라 오차를 허용한다 ──
  let sum = 0;
  try {
    sum = parts().reduce((acc, f) => acc + probeDuration(join(outDir, f)), 0);
  } catch (e) {
    r.check("ffprobe 길이 측정", false, e.message);
  }
  r.check(
    "길이 합 ≈ 원본 6초 (copy 키프레임 오차 허용 5.5~7.0)",
    sum >= 5.5 && sum <= 7.0,
    `합 ${sum.toFixed(2)}초 (${parts().map((f) => probeDuration(join(outDir, f)).toFixed(2)).join(" / ")})`,
  );

  // ── 5. 재실행 → 덮어쓰기 확인 1회 ──
  const before = parts().map((f) => statSync(join(outDir, f)).mtimeMs);
  await new Promise((res) => setTimeout(res, 1100)); // mtime 해상도 회피
  await cdp.eval(startExpr(FOLDER, SRC, "e2e-split", "copy", segs));
  const asked = await waitFor(
    () =>
      cdp.eval(
        "(window.__gpv.ui.getState().confirm?.message || '').includes('덮어쓸까요')",
      ),
    30000,
  );
  r.check("덮어쓰기: 확인 다이얼로그 1회", asked, asked ? "" : "(안 뜸)");
  if (asked) {
    await cdp.eval(
      "(()=>{ const u = window.__gpv.ui.getState(); u.confirm.onConfirm(); u.closeConfirm(); return true; })()",
    );
    const done2 = await waitFor(batchNull, 60000);
    const after = parts().map((f) => statSync(join(outDir, f)).mtimeMs);
    r.check(
      "덮어쓰기: 확인 후 완주 + 모든 part mtime 갱신",
      done2 && after.length === 3 && after.every((m, i) => m > before[i]),
      done2 ? `${after.length}개 갱신` : "60s 초과",
    );
  } else {
    // 다이얼로그가 안 떴으면 배치가 매달려 있을 수 있다 — 다음 단계를 위해 정리한다.
    await cdp.eval("(()=>{ window.__gpv.videoSplit.getState().cancel(); return true; })()");
    await waitFor(batchNull, 30000);
  }

  // ── 6. 동시 배치 금지 ──
  await cdp.eval(startExpr(FOLDER, SRC, "e2e-split", "copy", segs));
  await cdp.eval(startExpr(FOLDER, SRC, "e2e-split", "copy", segs));
  const oneBatch = await cdp.eval(
    "window.__gpv.videoSplit.getState().batch?.total ?? null",
  );
  r.check("동시 배치: 두 번째 start는 no-op", oneBatch === 3, `total=${oneBatch}`);
  // 이 배치는 확인 다이얼로그를 띄운다(이미 파일 존재) — 취소로 닫아 완료분을 유지시킨다.
  const asked2 = await waitFor(
    () => cdp.eval("window.__gpv.ui.getState().confirm !== null"),
    30000,
  );
  if (asked2)
    await cdp.eval(
      "(()=>{ const u = window.__gpv.ui.getState(); u.confirm.onCancel(); u.closeConfirm(); return true; })()",
    );
  const cancelledByDialog = await waitFor(batchNull, 30000);
  r.check(
    "덮어쓰기 거부: 배치 중단 + 완료분 유지",
    cancelledByDialog && parts().length === 3,
    `part ${parts().length}개`,
  );

  // ── 7. 취소 — 완료분 유지 · .tmp 없음 · ffmpeg 잔존 0 ──
  // encode 모드가 충분히 느리도록 별도의 큰 소스를 쓴다(720p 30초 → 6세그먼트).
  const bigPath = join(fix.repo, BIG);
  const bigDir = join(fix.repo, BIG_FOLDER);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=duration=30:size=1280x720:rate=30",
      "-g", "30", "-pix_fmt", "yuv420p", "-preset", "ultrafast", bigPath,
    ],
    { encoding: "utf8" },
  );
  const bigSegs = await cdp.eval("window.__gpv.planSegments([5,10,15,20,25], 30)");
  await cdp.eval(`(()=>{
    window.__gpv.ui.setState({ toasts: [] });
    void window.__gpv.videoSplit.getState().start(${JSON.stringify(fix.projectId)},
      ${JSON.stringify(BIG)}, "", ${JSON.stringify(bigSegs)},
      { folder: ${JSON.stringify(BIG_FOLDER)}, mode: "encode", stem: "e2e-split-big",
        durationMs: 30000, hasAudio: false });
    return true;
  })()`);
  // 첫 진행률이 보이면(=ffmpeg가 실제로 돌고 있으면) 취소한다.
  await waitFor(
    () =>
      cdp.eval(
        "(window.__gpv.videoSplit.getState().batch?.currentPct ?? 0) > 0 || (window.__gpv.videoSplit.getState().batch?.done ?? 0) > 0",
      ),
    30000,
    100,
  );
  await cdp.eval("(()=>{ window.__gpv.videoSplit.getState().cancel(); return true; })()");
  const cancelled = await waitFor(batchNull, 60000);
  const bigParts = existsSync(bigDir) ? readdirSync(bigDir) : [];
  r.check("취소: batch null 로 정리", cancelled, cancelled ? "" : "60s 초과");
  r.check(
    "취소: 전체 6개보다 적게 저장(완료분은 유지)",
    bigParts.filter((f) => f.endsWith(".mp4")).length < 6,
    `${bigParts.filter((f) => f.endsWith(".mp4")).length}/6개`,
  );
  r.check(
    "취소: .tmp 잔여 없음",
    !bigParts.some((f) => f.endsWith(".tmp")),
    bigParts.join(", ") || "(빈 폴더)",
  );
  const cancelToast = await cdp.eval(
    "window.__gpv.ui.getState().toasts.map(t => t.message).join(' | ')",
  );
  r.check(
    "취소: 'k/N개 저장 후 중단' 토스트 1개",
    /\d+\/6개 저장 후 중단/.test(cancelToast || ""),
    cancelToast || "(없음)",
  );
  const left = await waitFor(() => Promise.resolve(ffmpegCount() === 0), 10000, 500);
  const n = ffmpegCount();
  if (n === null) r.skip("취소: ffmpeg 프로세스 잔존 0", "win32 아님");
  else r.check("취소: ffmpeg 프로세스 잔존 0", left && n === 0, `${n}개`);

  // ── 정리 — 픽스처 레포에서 생성물 제거(러너 teardown도 지우지만 다음 스위트를 위해) ──
  for (const rel of [FOLDER, BIG_FOLDER, SRC, BIG])
    await cdp.try("delete_path", { projectId: fix.projectId, relPath: rel });
}
