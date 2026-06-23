export function relativeTime(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 10_000) return "방금 전";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}초 전`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  return `${Math.floor(diff / 3_600_000)}시간 전`;
}

export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0
    ? { dir: "", base: path }
    : { dir: path.slice(0, i), base: path.slice(i + 1) };
}

/** 바이트를 사람이 읽는 단위로 (1024 기준). 예: 0 → "0 B", 1.2e9 → "1.2 GB" */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const v = bytes / 1024 ** i;
  // B/KB 는 정수, 그 이상은 소수 1자리 (단 100 이상이면 정수)
  const digits = i <= 1 ? 0 : v >= 100 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** 커밋 날짜(ISO): 24시간 내는 상대시간, 올해는 MM-DD, 그 외 YYYY-MM-DD. */
export function shortDate(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return "";
  if (now - t < 86_400_000) return relativeTime(t, now);
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${mo}-${da}`
    : `${d.getFullYear()}-${mo}-${da}`;
}
