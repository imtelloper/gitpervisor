import { MousePointerClick } from "lucide-react";
import { lazy, Suspense } from "react";

import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";

// Monaco 번들은 무겁다 — 파일을 처음 열 때만 로드한다
const DiffViewer = lazy(() => import("../diff/DiffViewer"));

/** Viewer 탭 — 선택된 파일의 diff/내용 또는 빈 상태. */
export function ViewerTab({ projectId }: { projectId: string }) {
  const selectedDiff = useUi((s) => s.selectedDiff);

  if (!selectedDiff) {
    return (
      <EmptyState
        icon={MousePointerClick}
        title="파일을 선택하세요"
        desc="왼쪽 변경 목록·파일 트리 또는 아래 Log의 커밋에서 파일을 클릭하면 여기에 표시됩니다"
      />
    );
  }

  return (
    <Suspense fallback={<EmptyState title="diff 뷰어 로딩 중…" />}>
      <DiffViewer projectId={projectId} target={selectedDiff} />
    </Suspense>
  );
}
