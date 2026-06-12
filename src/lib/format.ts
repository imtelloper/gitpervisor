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
