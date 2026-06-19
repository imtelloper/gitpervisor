import { Globe } from "lucide-react";
import { useEffect, useState } from "react";

/** 사이트 파비콘 — origin/favicon.ico를 시도하고 실패 시 Globe로 폴백. */
export function Favicon({ url, size = 13 }: { url: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  let origin = "";
  try {
    origin = url ? new URL(url).origin : "";
  } catch {
    origin = "";
  }

  if (!origin || failed) return <Globe size={size} />;
  return (
    <img
      src={`${origin}/favicon.ico`}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-[2px] object-contain"
      onError={() => setFailed(true)}
    />
  );
}
