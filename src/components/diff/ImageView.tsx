import { FileWarning } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage } from "../../lib/ipc";
import { useFileImage } from "../../queries";
import { EmptyState } from "../common/EmptyState";

/** 이미지 파일 미리보기 — 워크트리 파일을 base64 data URL로 렌더. 맞춤/실제 크기 토글. */
export default function ImageView({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const { data, isLoading, error } = useFileImage(projectId, path);
  const [actual, setActual] = useState(false); // false=화면 맞춤, true=원본 픽셀

  // 파일이 바뀌면 다시 "맞춤"으로
  useEffect(() => setActual(false), [path]);

  if (isLoading) return <EmptyState title="이미지 불러오는 중…" />;
  if (error || !data)
    return (
      <EmptyState
        icon={FileWarning}
        title="이미지를 불러오지 못했습니다"
        desc={error ? errorMessage(error) : undefined}
      />
    );

  const src = `data:${data.mime};base64,${data.base64}`;
  return (
    <div className="flex h-full flex-col bg-base">
      <div className="flex h-8 shrink-0 items-center justify-end gap-2 border-b border-edge px-3 text-xs text-fg-dim">
        <button
          onClick={() => setActual((v) => !v)}
          className="rounded px-2 py-0.5 hover:bg-raised hover:text-fg"
        >
          {actual ? "화면 맞춤" : "실제 크기"}
        </button>
      </div>
      <div className="checkerboard min-h-0 flex-1 overflow-auto p-4">
        <img
          src={src}
          alt={path}
          className={
            actual
              ? "max-w-none"
              : "mx-auto max-h-full max-w-full object-contain"
          }
        />
      </div>
    </div>
  );
}
