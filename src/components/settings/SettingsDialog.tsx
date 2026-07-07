// 설정 모달 (태스크 18) — 좌 사이드바 카테고리 + 검색. 셸이 폼 상태 전부 소유(테마 프리뷰·시크릿·
// LSP 진행·category/query), 섹션은 순수 표현. 저장 모델은 불변(전역 폼 + 단일 저장/취소).
import { Search, Settings as SettingsIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { NotifySecret, Settings, ThemeName } from "../../lib/ipc";
import { errorMessage, ipc } from "../../lib/ipc";
import { refreshTerminalThemes } from "../../lib/terminal";
import { useProjects, useSetSettings, useSettings } from "../../queries";
import { useUi } from "../../stores/ui";
import { AppearanceSection } from "./sections/AppearanceSection";
import { CodeToolsSection } from "./sections/CodeToolsSection";
import { GeneralSection } from "./sections/GeneralSection";
import { MaintenanceSection } from "./sections/MaintenanceSection";
import { NotifySection } from "./sections/NotifySection";
import { TerminalSection } from "./sections/TerminalSection";
import {
  CATEGORIES,
  matchesEntry,
  SETTINGS_INDEX,
  type SettingsCategory,
} from "./settings-index";

/** 저장 시점 정규화(클램프·trim→null) — dirty 비교와 저장 양쪽이 쓰는 순수 함수. */
function buildCleaned(f: Settings): Settings {
  return {
    ...f,
    gitPath: f.gitPath && f.gitPath.trim() ? f.gitPath.trim() : null,
    remoteRefreshMinutes: Math.max(0, Math.floor(f.remoteRefreshMinutes || 0)),
    diffFontSize: Math.min(24, Math.max(10, Math.floor(f.diffFontSize || 13))),
    terminalShell: f.terminalShell && f.terminalShell.trim() ? f.terminalShell.trim() : null,
    terminalFontSize: Math.min(24, Math.max(10, Math.floor(f.terminalFontSize || 13))),
    smtpHost: f.smtpHost?.trim() || null,
    smtpPort: Math.min(65535, Math.max(1, Math.floor(f.smtpPort || 587))),
    smtpUsername: f.smtpUsername?.trim() || null,
    smtpFrom: f.smtpFrom?.trim() || null,
    smtpTo: f.smtpTo?.trim() || null,
  };
}

/** dirty 판정용 비교 — 배열은 내용 비교, 나머지는 값 비교(정규화 후). */
function settingsEqual(a: Settings, b: Settings): boolean {
  for (const k of Object.keys(a) as (keyof Settings)[]) {
    const av = a[k];
    const bv = b[k];
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) return false;
      const as = [...av].sort();
      const bs = [...bv].sort();
      if (as.some((v, i) => v !== bs[i])) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

/** 설정 모달 호스트 — 툴바 ⚙ 버튼으로 연다. */
export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const { data: settings } = useSettings();
  const { data: projects } = useProjects();
  const save = useSetSettings();

  const [form, setForm] = useState<Settings | null>(null);
  const [category, setCategory] = useState<SettingsCategory>("general");
  const [query, setQuery] = useState("");
  const [lspBusy, setLspBusy] = useState(false);
  const [lspStatus, setLspStatus] = useState("");
  const [slackSecret, setSlackSecret] = useState("");
  const [smtpSecret, setSmtpSecret] = useState("");
  const [slackHas, setSlackHas] = useState(false);
  const [smtpHas, setSmtpHas] = useState(false);
  // 유지보수 섹션은 첫 진입 후 계속 마운트(hidden)해 자체 상태(선택 Set·busy·로그)를 보존(§3.6 I1).
  const [maintVisited, setMaintVisited] = useState(false);

  // 모달 열 때 폼 초기화 + 검색 리셋(I5) + 시크릿 저장 여부 조회.
  useEffect(() => {
    if (open && settings) setForm({ ...settings });
    if (open) {
      setSlackSecret("");
      setSmtpSecret("");
      setQuery("");
      void ipc.notifyHasSecret("slack").then(setSlackHas).catch(() => {});
      void ipc.notifyHasSecret("smtp").then(setSmtpHas).catch(() => {});
    }
  }, [open, settings]);

  useEffect(() => {
    if (category === "maintenance") setMaintVisited(true);
  }, [category]);

  // 검색 매칭.
  const matched = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    return SETTINGS_INDEX.filter((e) => matchesEntry(e, q));
  }, [query]);
  const matchedCats = useMemo(
    () => (matched ? new Set(matched.map((m) => m.category)) : null),
    [matched],
  );

  // 검색 시 현재 카테고리가 매칭 밖이면 첫 매칭 카테고리로 자동 전환(I3). deps는 query만 —
  // 검색 중 사용자가 카테고리를 눌러도(setCategory) query 불변이라 그 선택이 유지된다.
  useEffect(() => {
    if (!matched || matched.length === 0) return;
    const cats = new Set(matched.map((m) => m.category));
    if (!cats.has(category)) setCategory(matched[0].category);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // 하이라이트 키 — 현재 카테고리의 매칭 필드. 조건 렌더로 숨은 필드(부모 토글 off)는 토글로 폴백(C3).
  const hl = useMemo(() => {
    const s = new Set<string>();
    if (!matched || !form) return s;
    for (const m of matched) {
      if (m.category !== category) continue;
      const id = m.key ?? m.id;
      if (!id) continue;
      if (m.parentToggle && form[m.parentToggle] === false) s.add(m.parentToggle);
      else s.add(String(id));
    }
    return s;
  }, [matched, category, form]);

  // dirty(I2): 정규화 비교 + 배열 내용 비교 + 시크릿 입력 non-empty.
  const isDirty = useMemo(() => {
    if (!form || !settings) return false;
    if (slackSecret.trim() || smtpSecret.trim()) return true;
    return !settingsEqual(buildCleaned(form), settings);
  }, [form, settings, slackSecret, smtpSecret]);

  // Esc — 검색어 있으면 클리어, 없으면 닫기. 위층 모달(confirm/prompt)엔 양보(M3).
  const escRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const ui = useUi.getState();
      if (ui.prompt || ui.confirm) return;
      e.preventDefault();
      escRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !form) return null;

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  // 테마 라이브 프리뷰 — App의 테마 effect는 저장값 의존이라 직접 dataset.theme + 터미널 재적용.
  const previewTheme = (id: ThemeName) => {
    update("theme", id);
    document.documentElement.dataset.theme = id;
    refreshTerminalThemes();
  };

  // 저장 없이 닫기 — 프리뷰로 바꾼 테마를 저장값으로 복원. 배경클릭·X·취소·Esc 4경로 전부 이 함수.
  const closeWithoutSave = () => {
    const saved = settings?.theme ?? "darcula";
    if (document.documentElement.dataset.theme !== saved) {
      document.documentElement.dataset.theme = saved;
      refreshTerminalThemes();
    }
    setOpen(false);
  };
  escRef.current = () => {
    if (query) setQuery("");
    else closeWithoutSave();
  };

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

  // 테스트 — 현재 설정+시크릿을 먼저 저장(다른 카테고리 미저장분 포함)한 뒤 발송(§6 I4).
  function handleTest(channel: NotifySecret) {
    void persist().then((ok) => {
      if (!ok) return;
      void ipc
        .notifyTest(channel)
        .then(() => useUi.getState().pushToast("success", "테스트 알림을 보냈습니다"))
        .catch((e) => useUi.getState().pushToast("error", errorMessage(e)));
    });
  }

  async function downloadLspServers() {
    setLspBusy(true);
    setLspStatus("다운로드 준비…");
    try {
      const failed: string[] = [];
      let noNode = false;
      for (const lang of ["py", "ts", "cpp", "rust", "lua"] as const) {
        const res = await ipc.lspEnsure(lang, (p) => {
          const ph = p.phase === "download" ? "받는 중" : p.phase === "done" ? "완료" : "실패";
          setLspStatus(`${p.name}: ${ph}${p.message ? ` (${p.message})` : ""}`);
        });
        if (!res.nodeFound && (lang === "py" || lang === "ts")) noNode = true;
        failed.push(...res.missing);
      }
      if (noNode) setLspStatus("⚠ Node.js를 찾지 못했습니다(파이썬·TS 서버에 필요)");
      else if (failed.length) setLspStatus(`⚠ 일부 실패: ${[...new Set(failed)].join(", ")}`);
      else setLspStatus("설치 완료 ✓ — 켠 프로젝트에서 파일을 열면 활성화됩니다");
    } catch {
      setLspStatus("⚠ 다운로드 실패 — 네트워크를 확인하세요");
    }
    setLspBusy(false);
  }

  const noResults = matched != null && matched.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={closeWithoutSave}
    >
      <div
        className="flex h-[min(640px,85vh)] w-[860px] max-w-[95vw] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-3">
          <SettingsIcon size={16} className="text-fg-muted" />
          <span className="font-semibold">설정</span>
          <div className="flex-1" />
          <button
            onClick={closeWithoutSave}
            className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>

        {/* 본문 — 좌 사이드바 + 우 카테고리 */}
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[200px] shrink-0 flex-col border-r border-edge">
            <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
              <Search size={13} className="text-fg-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="설정 검색…"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-dim"
              />
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {CATEGORIES.map((c) => {
                const active = category === c.id;
                const dimmed = matchedCats != null && !matchedCats.has(c.id);
                const Icon = c.icon;
                return (
                  <button
                    key={c.id}
                    onClick={() => setCategory(c.id)}
                    className={`flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-[13px] ${
                      active
                        ? "border-accent bg-selection text-fg"
                        : "border-transparent text-fg-muted hover:bg-raised"
                    } ${dimmed ? "opacity-40" : ""}`}
                  >
                    <Icon size={14} className="shrink-0" />
                    <span className="truncate">{c.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-5 text-[13px]">
            {noResults && (
              <div className="text-[12px] text-fg-dim">"{query}"에 대한 설정 결과가 없습니다.</div>
            )}
            {category === "general" && <GeneralSection form={form} update={update} hl={hl} />}
            {category === "appearance" && (
              <AppearanceSection form={form} update={update} hl={hl} previewTheme={previewTheme} />
            )}
            {category === "codetools" && (
              <CodeToolsSection
                form={form}
                update={update}
                hl={hl}
                projects={projects}
                lspBusy={lspBusy}
                lspStatus={lspStatus}
                onDownload={() => void downloadLspServers()}
              />
            )}
            {category === "terminal" && <TerminalSection form={form} update={update} hl={hl} />}
            {category === "notify" && (
              <NotifySection
                form={form}
                update={update}
                hl={hl}
                slackSecret={slackSecret}
                setSlackSecret={setSlackSecret}
                smtpSecret={smtpSecret}
                setSmtpSecret={setSmtpSecret}
                slackHas={slackHas}
                smtpHas={smtpHas}
                onTest={handleTest}
              />
            )}
            {/* 유지보수 — 첫 진입 후 hidden 마운트 유지(I1). */}
            {maintVisited && (
              <div className={category === "maintenance" ? "space-y-4" : "hidden"}>
                <MaintenanceSection hl={hl} />
              </div>
            )}
          </div>
        </div>

        {/* 푸터 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-edge px-5 py-3">
          {isDirty && (
            <span className="flex items-center gap-1.5 text-[11px] text-warn">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" />
              저장되지 않은 변경
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={closeWithoutSave}
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
