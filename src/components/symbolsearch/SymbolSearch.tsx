import { useCallback } from "react";

import { ipc } from "../../lib/ipc";
import { useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";
import { QuickPick, type QuickPickItem } from "../common/QuickPick";

type Sym = { path: string; line: number; column: number };

/**
 * Go to Symbol — mod+Alt+N으로 여는 전역 심볼 검색. 백엔드 find_symbols(부분일치+랭킹)를
 * 비동기 소스로 QuickPick(09 프리미티브)에 연결. 디바운스·seq 무효화·로딩은 QuickPick 내부.
 * 선택 시 터미널 탭이면 뷰어로 전환 후 selectDiff로 심볼 위치 착지.
 */
export function SymbolSearch() {
  const open = useUi((s) => s.symbolSearchOpen);
  const setOpen = useUi((s) => s.setSymbolSearchOpen);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const aggregateOpen = useUi((s) => s.aggregateOpen);
  const selectedDiff = useUi((s) => s.selectedDiff);
  const selectDiff = useUi((s) => s.selectDiff);

  // 현재 뷰어 파일 확장자 — 랭킹 부스트 힌트(필터 아님)
  const extHint =
    selectedDiff?.mode === "file"
      ? (selectedDiff.path.split(".").pop() ?? null)
      : null;

  const source = useCallback(
    async (query: string): Promise<QuickPickItem<Sym>[]> => {
      const q = query.trim();
      if (q.length < 2 || !selectedProjectId) return [];
      const res = await ipc.findSymbols(selectedProjectId, q, extHint);
      return res.map((m) => ({
        id: `${m.path}:${m.line}:${m.column}`,
        label: m.name,
        // 시그니처 첫 줄을 보조 표기로
        description: m.signature.split("\n")[0],
        hint: `${m.path.split("/").pop()}:${m.line}`,
        data: { path: m.path, line: m.line, column: m.column },
      }));
    },
    [selectedProjectId, extHint],
  );

  const onPick = useCallback(
    (item: QuickPickItem<Sym>) => {
      if (selectedProjectId) {
        // 터미널 탭을 보던 중이면 뷰어로 전환해 착지가 보이게 한다
        useTerminals.getState().setActiveTab(selectedProjectId, "viewer");
      }
      selectDiff({
        mode: "file",
        path: item.data.path,
        line: item.data.line,
        column: item.data.column,
      });
      setOpen(false);
    },
    [selectedProjectId, selectDiff, setOpen],
  );

  if (!open || !selectedProjectId || aggregateOpen) return null;

  return (
    <QuickPick
      placeholder="심볼 이름으로 검색 (2자 이상)…"
      source={source}
      debounceMs={250}
      onPick={onPick}
      onClose={() => setOpen(false)}
      emptyText="심볼을 입력하세요 (함수·클래스·타입 정의)"
    />
  );
}
