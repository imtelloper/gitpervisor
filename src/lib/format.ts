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
