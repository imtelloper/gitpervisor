import {
  FolderOpen,
  Globe,
  RefreshCw,
  ScrollText,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { clearBrowserData } from "../../lib/browser";
import { formatBytes } from "../../lib/format";
import type { LogStatus, NotifySecret, Settings } from "../../lib/ipc";
import { errorMessage, ipc } from "../../lib/ipc";
import {
  useClearQuarantine,
  useGitCheck,
  useQuarantinedTools,
  useSetSettings,
  useSettings,
} from "../../queries";
import { useUi } from "../../stores/ui";

const isMacOS = /Mac/i.test(navigator.userAgent);

const inputCls =
  "w-full rounded border border-edge bg-base px-2 py-1 outline-none focus:border-accent";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 font-medium">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-fg-dim">{hint}</div>}
    </div>
  );
}

/**
 * macOS 격리 도구 검사 섹션.
 * brew cask로 설치한 CLI(예: claude)에 박힌 com.apple.quarantine을 스캔·해제한다.
 * 비-macOS에선 호출 측에서 렌더링하지 않는다.
 */
function QuarantineSection() {
  const { data, isFetching, refetch } = useQuarantinedTools();
  const clear = useClearQuarantine();
  const items = data ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 스캔 결과가 바뀌면 선택 상태를 초기화한다 — 사라진 항목이 선택돼 있으면 헷갈리니까.
  // 기본은 "전부 선택"으로 시작해 한 번에 해제하는 흐름을 자연스럽게 만든다.
  useEffect(() => {
    setSelected(new Set(items.map((i) => i.path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const allSelected = items.length > 0 && selected.size === items.length;
  const selectedList = useMemo(
    () => items.filter((i) => selected.has(i.path)).map((i) => i.path),
    [items, selected],
  );

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.path)));

  return (
    <>
      <div className="border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim">
        macOS 격리 도구
      </div>
      <div className="text-[11px] leading-5 text-fg-muted">
        Homebrew cask로 설치한 CLI는 macOS 격리 속성이 박혀
        터미널에서 <span className="font-mono">permission denied</span>로
        실행이 막힙니다. 여기서 한 번에 해제할 수 있습니다.
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void refetch()}
          disabled={isFetching || clear.isPending}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
          다시 검사
        </button>
        {items.length === 0 && !isFetching && (
          <span className="flex items-center gap-1.5 text-[12px] text-add">
            <ShieldCheck size={13} />
            차단된 항목 없음
          </span>
        )}
        {items.length > 0 && (
          <span className="text-[12px] text-danger">
            ⚠️ 차단된 항목 {items.length}개
          </span>
        )}
      </div>

      {items.length > 0 && (
        <>
          <div className="max-h-44 overflow-y-auto rounded border border-edge bg-base">
            <label className="flex cursor-pointer items-center gap-2 border-b border-edge px-2 py-1.5 text-[12px] font-medium text-fg-muted hover:bg-raised">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="accent-accent"
              />
              <span>전체 선택</span>
            </label>
            {items.map((it) => (
              <label
                key={it.path}
                className="flex cursor-pointer items-start gap-2 px-2 py-1.5 hover:bg-raised"
              >
                <input
                  type="checkbox"
                  checked={selected.has(it.path)}
                  onChange={() => toggle(it.path)}
                  className="mt-0.5 accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px]">
                    <span className="font-medium">{it.name}</span>
                    <span className="ml-1 text-fg-dim">({it.cask})</span>
                  </div>
                  <div className="break-all font-mono text-[10px] text-fg-dim">
                    {it.path}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <button
            onClick={() => clear.mutate(selectedList)}
            disabled={selectedList.length === 0 || clear.isPending}
            className="w-full rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {clear.isPending
              ? "해제 중…"
              : `선택 ${selectedList.length}개 격리 해제`}
          </button>
        </>
      )}
    </>
  );
}

/**
 * 브라우저 데이터 섹션 — 임베디드 브라우저(공유 프로필)의 로그인/쿠키를 지운다.
 * 북마크·방문기록은 우리 store의 별개 데이터라 유지 — 일반 브라우저의
 * "쿠키 삭제 ≠ 방문기록 삭제" 관행과 동일.
 */
function BrowserDataSection() {
  const [busy, setBusy] = useState(false);
  const toast = (kind: "error" | "success", m: string) =>
    useUi.getState().pushToast(kind, m);

  const confirmClear = () =>
    useUi.getState().askConfirm({
      title: "브라우저 데이터 초기화",
      message:
        "임베디드 브라우저의 모든 로그인 세션·쿠키·사이트 데이터를 지웁니다. 모든 사이트에서 로그아웃됩니다.",
      confirmLabel: "초기화",
      danger: true,
      onConfirm: () => {
        setBusy(true);
        void clearBrowserData()
          .then(() => toast("success", "브라우저 로그인/쿠키 데이터를 지웠습니다"))
          .catch((e) => toast("error", errorMessage(e)))
          .finally(() => setBusy(false));
      },
    });

  return (
    <>
      <div className="border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim">
        브라우저
      </div>
      <div className="text-[11px] leading-5 text-fg-muted">
        임베디드 브라우저 탭·팝업이 공유하는 로그인 세션과 쿠키를 지웁니다.
        북마크와 방문 기록은 유지됩니다.
      </div>
      <button
        disabled={busy}
        onClick={confirmClear}
        className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-danger hover:bg-danger/15 disabled:opacity-50"
      >
        <Globe size={12} />
        {busy ? "초기화 중…" : "브라우저 데이터 초기화"}
      </button>
    </>
  );
}

/**
 * 진단/로그 섹션 — 패닉 로그(panic.log)를 열고·보고·비운다.
 * 앱이 비정상 종료해도 원인+백트레이스가 로그 폴더에 남으므로, 사용자가 이를 찾아 디버깅할 수 있게 한다.
 */
function DiagnosticsSection() {
  const [status, setStatus] = useState<LogStatus | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void ipc.getLogStatus().then(setStatus).catch(() => {});
  }, []);
  useEffect(() => refresh(), [refresh]);

  const hasCrash = !!status && status.panicLogBytes > 0;
  const toast = (kind: "error" | "success", m: string) =>
    useUi.getState().pushToast(kind, m);

  return (
    <>
      <div className="border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim">
        진단 / 로그
      </div>
      <div className="text-[11px] leading-5 text-fg-muted">
        앱이 비정상 종료해도 원인과 백트레이스가{" "}
        <span className="font-mono">panic.log</span>에 기록됩니다. 여기서 로그
        폴더를 열거나 마지막 크래시 내용을 확인할 수 있습니다.
      </div>
      {status?.logDir && (
        <div className="break-all font-mono text-[10px] text-fg-dim">
          {status.logDir}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() =>
            void ipc
              .openLogsFolder()
              .catch((e) => toast("error", errorMessage(e)))
          }
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg"
        >
          <FolderOpen size={12} />
          로그 폴더 열기
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setLog(await ipc.readCrashLog(256 * 1024));
            } catch (e) {
              toast("error", errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50"
        >
          <ScrollText size={12} />
          패닉 로그 보기
        </button>
        {hasCrash && (
          <button
            onClick={async () => {
              try {
                await ipc.clearCrashLog();
                setLog(null);
                refresh();
                toast("success", "크래시 로그를 비웠습니다");
              } catch (e) {
                toast("error", errorMessage(e));
              }
            }}
            className="rounded border border-edge px-2.5 py-1 text-danger hover:bg-danger/15"
          >
            비우기
          </button>
        )}
      </div>
      {hasCrash ? (
        <span className="text-[12px] text-danger">
          ⚠️ 마지막 크래시: {status?.lastCrashAt ?? "?"} (
          {formatBytes(status?.panicLogBytes ?? 0)})
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[12px] text-add">
          <ShieldCheck size={13} />
          크래시 기록 없음
        </span>
      )}
      {log !== null && (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded border border-edge bg-base p-2 font-mono text-[10px] leading-4">
          {log || "(비어 있음)"}
        </pre>
      )}
    </>
  );
}

/** 설정 모달 호스트 — 툴바 ⚙ 버튼으로 연다 (설계 F12). 테마는 후속 보류. */
export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const { data: settings } = useSettings();
  const { data: gitCheck } = useGitCheck();
  const save = useSetSettings();

  const [form, setForm] = useState<Settings | null>(null);
  // 외부 알림 시크릿(웹훅 URL·SMTP 비번)은 키링에 별도 저장 — 입력값이 비면 "변경 안 함".
  const [slackSecret, setSlackSecret] = useState("");
  const [smtpSecret, setSmtpSecret] = useState("");
  const [slackHas, setSlackHas] = useState(false);
  const [smtpHas, setSmtpHas] = useState(false);

  // 모달을 열 때 현재 설정으로 폼을 초기화 + 시크릿 저장 여부를 조회한다
  useEffect(() => {
    if (open && settings) setForm({ ...settings });
    if (open) {
      setSlackSecret("");
      setSmtpSecret("");
      void ipc.notifyHasSecret("slack").then(setSlackHas).catch(() => {});
      void ipc.notifyHasSecret("smtp").then(setSmtpHas).catch(() => {});
    }
  }, [open, settings]);

  if (!open || !form) return null;

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  function buildCleaned(f: Settings): Settings {
    return {
      ...f,
      gitPath: f.gitPath && f.gitPath.trim() ? f.gitPath.trim() : null,
      remoteRefreshMinutes: Math.max(0, Math.floor(f.remoteRefreshMinutes || 0)),
      diffFontSize: Math.min(24, Math.max(10, Math.floor(f.diffFontSize || 13))),
      terminalShell:
        f.terminalShell && f.terminalShell.trim()
          ? f.terminalShell.trim()
          : null,
      terminalFontSize: Math.min(
        24,
        Math.max(10, Math.floor(f.terminalFontSize || 13)),
      ),
      smtpHost: f.smtpHost?.trim() || null,
      smtpPort: Math.min(65535, Math.max(1, Math.floor(f.smtpPort || 587))),
      smtpUsername: f.smtpUsername?.trim() || null,
      smtpFrom: f.smtpFrom?.trim() || null,
      smtpTo: f.smtpTo?.trim() || null,
    };
  }

  /** 시크릿(있으면) + 설정을 영속화한다. 성공 시 true. */
  async function persist(): Promise<boolean> {
    if (!form) return false;
    try {
      if (slackSecret.trim()) {
        await ipc.notifySetSecret("slack", slackSecret.trim());
        setSlackSecret("");
        setSlackHas(true);
      }
      if (smtpSecret.trim()) {
        await ipc.notifySetSecret("smtp", smtpSecret.trim());
        setSmtpSecret("");
        setSmtpHas(true);
      }
      await save.mutateAsync(buildCleaned(form));
      return true;
    } catch (e) {
      useUi.getState().pushToast("error", errorMessage(e));
      return false;
    }
  }

  function handleSave() {
    void persist().then((ok) => {
      if (ok) setOpen(false);
    });
  }

  // 테스트 — 먼저 현재 설정+시크릿을 저장한 뒤 해당 채널로 샘플 알림을 보낸다.
  function handleTest(channel: NotifySecret) {
    void persist().then((ok) => {
      if (!ok) return;
      void ipc
        .notifyTest(channel)
        .then(() =>
          useUi.getState().pushToast("success", "테스트 알림을 보냈습니다"),
        )
        .catch((e) => useUi.getState().pushToast("error", errorMessage(e)));
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex max-h-[85vh] w-[500px] flex-col rounded-lg border border-edge bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <SettingsIcon size={16} className="text-fg-muted" />
          <span className="font-semibold">설정</span>
          <div className="flex-1" />
          <button
            onClick={() => setOpen(false)}
            className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>

        <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1 text-[13px]">
          <Field label="테마">
            <div className="flex gap-2">
              {(["darcula", "monokai"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => update("theme", t)}
                  className={`flex-1 rounded border px-3 py-1.5 ${
                    form.theme === t
                      ? "border-accent bg-accent/15 text-fg"
                      : "border-edge text-fg-muted hover:bg-raised"
                  }`}
                >
                  {t === "darcula" ? "다크 (Darcula)" : "Monokai"}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Diff 폰트 크기" hint="10–24 px">
            <input
              type="number"
              min={10}
              max={24}
              value={form.diffFontSize}
              onChange={(e) => update("diffFontSize", Number(e.target.value))}
              className={inputCls}
            />
          </Field>

          <Field
            label="원격 새로고침 주기 (분)"
            hint="0 = 끔 · 기본 5분. 배경 fetch로 pull 받을 커밋(↓)을 자동 감지합니다"
          >
            <input
              type="number"
              min={0}
              value={form.remoteRefreshMinutes}
              onChange={(e) =>
                update("remoteRefreshMinutes", Number(e.target.value))
              }
              className={inputCls}
            />
          </Field>

          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={form.confirmDiscard}
              onChange={(e) => update("confirmDiscard", e.target.checked)}
              className="accent-accent"
            />
            <span>변경 되돌리기·파일 삭제 전 확인 다이얼로그</span>
          </label>

          <Field label="git 실행 파일 경로" hint="비우면 PATH에서 자동 탐색 (변경은 다음 git 작업부터 적용)">
            <input
              type="text"
              value={form.gitPath ?? ""}
              placeholder="(자동 탐색)"
              onChange={(e) => update("gitPath", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Field>
          <div className="text-[11px] text-fg-dim">
            현재:{" "}
            {gitCheck?.found ? (
              <span className="font-mono text-fg-muted">
                {gitCheck.path} · {gitCheck.version}
              </span>
            ) : (
              <span className="text-danger">git을 찾지 못함</span>
            )}
          </div>

          <div className="border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim">
            터미널
          </div>

          <Field
            label="셸"
            hint="비우면 자동 탐색 (pwsh → powershell → cmd). 새 터미널부터 적용"
          >
            <input
              type="text"
              value={form.terminalShell ?? ""}
              placeholder="(자동 탐색)"
              onChange={(e) => update("terminalShell", e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </Field>

          <Field label="터미널 폰트 크기" hint="10–24 px · 새 터미널부터 적용">
            <input
              type="number"
              min={10}
              max={24}
              value={form.terminalFontSize}
              onChange={(e) =>
                update("terminalFontSize", Number(e.target.value))
              }
              className={inputCls}
            />
          </Field>

          <div className="border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim">
            알림
          </div>

          <Field
            label="AI 작업 완료 알림"
            hint="터미널의 Claude가 작업을 끝내면 OS 알림을 보냅니다. 상태바의 AI 칩을 클릭하면 해당 프로젝트로 이동합니다."
          >
            <select
              value={form.notifyMode || "project-inactive"}
              onChange={(e) =>
                update("notifyMode", e.target.value as Settings["notifyMode"])
              }
              className={inputCls}
            >
              <option value="off">끔</option>
              <option value="project-inactive">
                프로젝트 단위 · 창이 비활성일 때만
              </option>
              <option value="terminal">터미널 단위로 매번</option>
              <option value="always">항상 (포커스 중에도)</option>
            </select>
          </Field>

          <div className="text-[11px] leading-5 text-fg-muted">
            아래를 켜면 OS 알림에 더해 Slack·이메일로도 완료 알림을 보냅니다 —
            원격에서도 작업 종료를 알 수 있습니다(시크릿은 OS 키링에 저장).
          </div>

          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={form.slackEnabled}
              onChange={(e) => update("slackEnabled", e.target.checked)}
              className="accent-accent"
            />
            <span>Slack 웹훅으로도 알림</span>
          </label>
          {form.slackEnabled && (
            <div className="space-y-2 pl-6">
              <input
                type="password"
                value={slackSecret}
                placeholder={
                  slackHas
                    ? "(저장됨 — 변경하려면 새 URL 입력)"
                    : "https://hooks.slack.com/services/..."
                }
                onChange={(e) => setSlackSecret(e.target.value)}
                className={`${inputCls} font-mono`}
              />
              <button
                onClick={() => handleTest("slack")}
                className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg"
              >
                <Send size={12} />
                테스트 전송
              </button>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={form.emailEnabled}
              onChange={(e) => update("emailEnabled", e.target.checked)}
              className="accent-accent"
            />
            <span>이메일(SMTP)로도 알림</span>
          </label>
          {form.emailEnabled && (
            <div className="space-y-2 pl-6">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.smtpHost ?? ""}
                  placeholder="SMTP 호스트 (예: smtp.gmail.com)"
                  onChange={(e) => update("smtpHost", e.target.value)}
                  className={`${inputCls} flex-1 font-mono`}
                />
                <input
                  type="number"
                  value={form.smtpPort || 587}
                  onChange={(e) => update("smtpPort", Number(e.target.value))}
                  className={`${inputCls} w-20`}
                  title="포트 (465=암호화, 587=STARTTLS)"
                />
              </div>
              <input
                type="text"
                value={form.smtpFrom ?? ""}
                placeholder="보내는 주소 (from)"
                onChange={(e) => update("smtpFrom", e.target.value)}
                className={`${inputCls} font-mono`}
              />
              <input
                type="text"
                value={form.smtpTo ?? ""}
                placeholder="받는 주소 (to)"
                onChange={(e) => update("smtpTo", e.target.value)}
                className={`${inputCls} font-mono`}
              />
              <input
                type="text"
                value={form.smtpUsername ?? ""}
                placeholder="사용자명 (보통 from과 동일)"
                onChange={(e) => update("smtpUsername", e.target.value)}
                className={`${inputCls} font-mono`}
              />
              <input
                type="password"
                value={smtpSecret}
                placeholder={
                  smtpHas ? "(저장됨 — 변경하려면 입력)" : "비밀번호 / 앱 비밀번호"
                }
                onChange={(e) => setSmtpSecret(e.target.value)}
                className={`${inputCls} font-mono`}
              />
              <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={form.smtpTls}
                  onChange={(e) => update("smtpTls", e.target.checked)}
                  className="accent-accent"
                />
                <span>TLS 암호화 사용 (권장)</span>
              </label>
              <button
                onClick={() => handleTest("smtp")}
                className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg"
              >
                <Send size={12} />
                테스트 전송
              </button>
            </div>
          )}

          <BrowserDataSection />

          <DiagnosticsSection />

          {isMacOS && <QuarantineSection />}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => setOpen(false)}
            className="rounded px-3 py-1.5 text-fg-muted hover:bg-raised"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={save.isPending}
            className="rounded bg-accent px-3 py-1.5 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {save.isPending ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
