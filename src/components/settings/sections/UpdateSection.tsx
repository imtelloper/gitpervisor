// 업데이트 (자동 업데이트) — 폼이 아닌 즉시 액션 섹션. 시작 시 자동 확인은 localStorage 토글이라
// 백엔드 Settings 스키마를 건드리지 않는다. 실제 확인·다운로드·설치는 useUpdater(Tauri updater).
import { getVersion } from "@tauri-apps/api/app";
import { ArrowUpCircle, CheckCircle2, Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { relativeTime } from "../../../lib/format";
import { useUpdater } from "../../../stores/updater";
import { Hl } from "./shared";

const subHeading = "border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim";

export function UpdateSection({ hl }: { hl: Set<string> }) {
  const s = useUpdater();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void getVersion().then(setAppVersion).catch(() => {});
  }, []);
  const current = s.currentVersion ?? appVersion;

  const busy = s.status === "checking" || s.status === "downloading" || s.status === "installed";

  return (
    <div className="space-y-3">
      <Hl id="appUpdate" hl={hl}>
        <div className="space-y-2">
          <div className={subHeading}>업데이트</div>

          {/* 버전 표시 */}
          <div className="flex items-baseline gap-2 text-[12px]">
            <span className="text-fg-muted">현재 버전</span>
            <span className="font-mono text-fg">v{current ?? "…"}</span>
            {s.status === "available" && s.newVersion && (
              <>
                <ArrowUpCircle size={13} className="text-accent" />
                <span className="font-mono text-accent">v{s.newVersion}</span>
                <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">
                  새 버전
                </span>
              </>
            )}
          </div>

          {/* 상태 줄 */}
          {s.status === "upToDate" && (
            <div className="flex items-center gap-1.5 text-[12px] text-add">
              <CheckCircle2 size={13} />
              최신 버전입니다
            </div>
          )}
          {s.status === "error" && (
            <div className="text-[12px] text-danger">
              업데이트 확인 실패 — 잠시 후 다시 시도하세요
              {s.error ? <span className="block font-mono text-[10px] text-fg-dim">{s.error}</span> : null}
            </div>
          )}

          {/* 새 버전: 릴리스 노트 + 업데이트 버튼 */}
          {s.status === "available" && (
            <>
              {s.notes && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-edge bg-base p-2 text-[11px] leading-5 text-fg-muted">
                  {s.notes}
                </pre>
              )}
              <button
                onClick={() => void s.downloadAndInstall()}
                className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover"
              >
                <Download size={13} />
                지금 업데이트하고 재시작
              </button>
              <div className="text-[10px] leading-4 text-fg-dim">
                설치 시 관리자 권한 승격(UAC) 창이 한 번 뜹니다. 설치 후 앱이 자동 재시작됩니다.
              </div>
            </>
          )}

          {/* 다운로드 진행률 */}
          {s.status === "downloading" && (
            <div className="space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-edge">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${s.progress}%` }}
                />
              </div>
              <div className="text-[11px] text-fg-muted">다운로드 중… {s.progress}%</div>
            </div>
          )}
          {s.status === "installed" && (
            <div className="text-[12px] text-fg-muted">설치 완료 — 재시작하는 중…</div>
          )}
        </div>
      </Hl>

      {/* 자동 확인 토글 + 수동 확인 */}
      <Hl id="autoUpdateCheck" hl={hl}>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted">
            <input
              type="checkbox"
              checked={s.autoCheck}
              onChange={(e) => s.setAutoCheck(e.target.checked)}
              className="accent-accent"
            />
            시작할 때 자동으로 새 버전 확인
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void s.check()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-[12px] text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50"
            >
              <RefreshCw size={12} className={s.status === "checking" ? "animate-spin" : ""} />
              {s.status === "checking" ? "확인 중…" : "지금 확인"}
            </button>
            {s.lastCheckedAt && (
              <span className="text-[11px] text-fg-dim">
                마지막 확인 {relativeTime(s.lastCheckedAt)}
              </span>
            )}
          </div>
        </div>
      </Hl>
    </div>
  );
}
