import { useProjectLogo } from "../../queries";

/** 프로젝트 로고 — 수동 지정(태스크 54)이 있으면 그것, 없으면 레포 안에서 자동 감지한 이미지.
 *  로고가 없는 프로젝트가 대부분이라 없으면 조용히 아무것도 그리지 않는다(자리도 차지하지 않는다).
 *
 *  `useProjectLogo`는 react-query 키를 공유하므로 셀 20개가 떠도 IPC는 프로젝트당 1회다.
 *  alt=""·aria-hidden: 표시처마다 프로젝트 이름이 바로 옆에 있다(두 번 읽힐 이유가 없다). */
export function ProjectLogo({
  projectId,
  size = 16,
  className,
}: {
  projectId: string;
  size?: number;
  className?: string;
}) {
  const { data } = useProjectLogo(projectId);
  if (!data) return null;
  return (
    <img
      src={data.dataUri}
      alt=""
      aria-hidden
      draggable={false}
      width={size}
      height={size}
      title={`로고: ${data.source}`}
      className={`shrink-0 rounded-sm object-contain ${className ?? ""}`}
    />
  );
}
