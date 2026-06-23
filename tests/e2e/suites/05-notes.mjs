// 프로젝트 메모 — get_notes, add_memo, update_memo, delete_memo (낙관적 백엔드 영속).
export const name = "프로젝트 메모 (notes: add / update / delete)";

const MEMO_ID = "gpv-e2e-memo-1";

export async function run({ cdp, report: r, fix }) {
  try {
  // ── add_memo ──
  const memo = await cdp.invoke("add_memo", { projectId: fix.projectId, memoId: MEMO_ID });
  r.check("add_memo: Memo 반환(빈 텍스트)", memo?.id === MEMO_ID && memo?.text === "", `id=${memo?.id}`);

  let notes = await cdp.invoke("get_notes");
  r.check("get_notes: 픽스처 메모 등록됨", (notes?.[fix.projectId] || []).some((m) => m.id === MEMO_ID));

  // ── update_memo ──
  const updated = await cdp.invoke("update_memo", { projectId: fix.projectId, memoId: MEMO_ID, text: "hello e2e" });
  r.check("update_memo: 텍스트 반영", updated?.text === "hello e2e", updated?.text);
  notes = await cdp.invoke("get_notes");
  const stored = (notes?.[fix.projectId] || []).find((m) => m.id === MEMO_ID);
  r.check("get_notes: 수정 텍스트 영속", stored?.text === "hello e2e");

  // ── delete_memo ──
  await cdp.invoke("delete_memo", { projectId: fix.projectId, memoId: MEMO_ID });
  notes = await cdp.invoke("get_notes");
  r.check("delete_memo: 메모 제거됨", !(notes?.[fix.projectId] || []).some((m) => m.id === MEMO_ID));
  } finally {
    // 스위트가 도중에 throw 해도 메모를 남기지 않는다(영속 정리, 멱등).
    await cdp.try("delete_memo", { projectId: fix.projectId, memoId: MEMO_ID });
  }
}
