// 시스템/게이트/설정 — check_git, sys_metrics, get_settings/set_settings(스냅샷 복원).
export const name = "시스템 · 게이트 · 설정 (check_git / sys_metrics / settings)";

export async function run({ cdp, report: r, snapshot }) {
  // ── check_git ──
  const gc = await cdp.invoke("check_git");
  r.check("check_git: git 발견됨", gc?.found === true, gc?.version || gc?.reason || "");
  r.check("check_git: 버전 문자열 존재", typeof gc?.version === "string" && gc.version.length > 0, gc?.version);
  r.check("check_git: 실행 경로 존재", typeof gc?.path === "string" && gc.path.length > 0, gc?.path);

  // ── sys_metrics ──
  const sm = await cdp.invoke("sys_metrics", {}, { timeoutMs: 8000 });
  r.check("sys_metrics: cpu 0-100", typeof sm?.cpu === "number" && sm.cpu >= 0 && sm.cpu <= 100, `cpu=${sm?.cpu}`);
  r.check("sys_metrics: ram 0-100", typeof sm?.ram === "number" && sm.ram >= 0 && sm.ram <= 100, `ram=${sm?.ram}`);
  r.check("sys_metrics: ramTotal>0 바이트", typeof sm?.ramTotal === "number" && sm.ramTotal > 0, `ramTotal=${sm?.ramTotal}`);
  r.check("sys_metrics: storageTotal>0", typeof sm?.storageTotal === "number" && sm.storageTotal > 0, `${sm?.storageTotal}`);

  // ── settings: 읽기 → 변경 → 검증 → 복원 ──
  const s0 = await cdp.invoke("get_settings");
  r.check("get_settings: 객체 반환", !!s0 && typeof s0 === "object", `theme=${s0?.theme}`);
  r.check("get_settings: 스냅샷과 일치", s0?.theme === snapshot.settings?.theme, `${s0?.theme} vs ${snapshot.settings?.theme}`);

  const bumped = { ...s0, diffFontSize: (s0.diffFontSize || 14) + 3 };
  await cdp.invoke("set_settings", { settings: bumped });
  const s1 = await cdp.invoke("get_settings");
  r.check("set_settings: 변경 반영(diffFontSize)", s1?.diffFontSize === bumped.diffFontSize, `${s1?.diffFontSize}`);

  await cdp.invoke("set_settings", { settings: s0 });
  const s2 = await cdp.invoke("get_settings");
  r.check("set_settings: 원복 성공", s2?.diffFontSize === s0.diffFontSize, `${s2?.diffFontSize}`);
}
