import type {
  ApiRequestBody,
  AuthConfig,
  KvRow,
  RequestSettings,
} from "../../stores/apiclient";
import { useApiClient } from "../../stores/apiclient";
import { BodyEditor } from "./BodyEditor";
import { KeyValueEditor } from "./KeyValueEditor";

type View = "params" | "headers" | "body" | "auth" | "settings";

/** 기본값과 다른 설정 수 — "설정" 탭 배지용. */
function countSettings(s: RequestSettings | undefined): number {
  if (!s) return 0;
  return (
    (s.verifyTls === false ? 1 : 0) +
    (s.followRedirects === false ? 1 : 0) +
    (s.timeoutMs != null ? 1 : 0) +
    (s.maxRedirects != null ? 1 : 0)
  );
}

/** 활성(채워진) 행 수 — 카운트 배지용. */
function countRows(rows: KvRow[]): number {
  return rows.filter((r) => r.enabled && (r.key !== "" || r.value !== "")).length;
}

/**
 * 요청 하단 서브탭(§8.5) — Params/Headers/Body/Auth + 카운트 배지.
 * 본문은 KeyValueEditor / BodyEditor / Auth 폼.
 */
export function RequestTabs({ tabId }: { tabId: string }) {
  const draft = useApiClient((s) => s.draftById[tabId]);
  const view = useApiClient((s) => s.items[tabId]?.view ?? "params");
  const setView = useApiClient((s) => s.setView);
  const patchDraft = useApiClient((s) => s.patchDraft);

  if (!draft) return null;

  const bodyCount = draft.body.mode === "none" ? 0 : 1;
  const authCount = draft.auth.kind === "none" ? 0 : 1;

  const TABS: { view: View; label: string; count: number | null }[] = [
    { view: "params", label: "Params", count: countRows(draft.params) },
    { view: "headers", label: "Headers", count: countRows(draft.headers) },
    { view: "body", label: "Body", count: bodyCount || null },
    { view: "auth", label: "Auth", count: authCount || null },
    { view: "settings", label: "설정", count: countSettings(draft.settings) || null },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-edge px-3 text-xs">
        {TABS.map((t) => (
          <button
            key={t.view}
            onClick={() => setView(tabId, t.view)}
            className={`flex items-center gap-1 rounded px-2 py-1 ${
              view === t.view
                ? "bg-raised text-fg"
                : "text-fg-muted hover:bg-raised/60 hover:text-fg"
            }`}
          >
            {t.label}
            {t.count != null && t.count > 0 && (
              <span className="rounded bg-accent/20 px-1 text-[10px] leading-4 text-accent">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {view === "params" && (
          <KeyValueEditor
            rows={draft.params}
            onChange={(params) => patchDraft(tabId, { params })}
          />
        )}
        {view === "headers" && (
          <KeyValueEditor
            rows={draft.headers}
            onChange={(headers) => patchDraft(tabId, { headers })}
            keyPlaceholder="Header-Name"
          />
        )}
        {view === "body" && (
          <BodyEditor
            body={draft.body}
            onChange={(patch: Partial<ApiRequestBody>) =>
              patchDraft(tabId, { body: { ...draft.body, ...patch } })
            }
          />
        )}
        {view === "auth" && (
          <AuthForm
            auth={draft.auth}
            onChange={(auth) => patchDraft(tabId, { auth })}
          />
        )}
        {view === "settings" && (
          <SettingsForm
            settings={draft.settings}
            onChange={(settings) => patchDraft(tabId, { settings })}
          />
        )}
      </div>
    </div>
  );
}

/** 요청별 전송 설정(§2/§10.4) — TLS검증·리다이렉트 토글 + 타임아웃·최대횟수.
 *  undefined는 백엔드 기본값(TLS on/추종/30s/10)을 뜻하므로 토글 기본 상태도 그렇게 표시. */
function SettingsForm({
  settings,
  onChange,
}: {
  settings: RequestSettings | undefined;
  onChange: (s: RequestSettings) => void;
}) {
  const s = settings ?? {};
  const set = (patch: Partial<RequestSettings>) => onChange({ ...s, ...patch });
  const verifyTls = s.verifyTls !== false; // 기본 true
  const followRedirects = s.followRedirects !== false; // 기본 true
  const numOrUndef = (v: string) =>
    v.trim() === "" ? undefined : Math.max(0, Math.floor(Number(v) || 0));

  return (
    <div className="space-y-4 p-3 text-[13px]">
      <Toggle
        label="TLS 인증서 검증"
        hint="끄면 자가서명·만료 인증서도 허용(개발용). 응답에 ⚠️ 검증 꺼짐 배지가 뜬다."
        checked={verifyTls}
        onChange={(v) => set({ verifyTls: v })}
      />
      <Toggle
        label="리다이렉트 추종"
        hint="3xx Location을 자동 추종. 다른 origin으로 넘어가면 Authorization·Cookie는 자동 제거된다."
        checked={followRedirects}
        onChange={(v) => set({ followRedirects: v })}
      />
      {followRedirects && (
        <Field label="최대 리다이렉트 횟수">
          <input
            type="number"
            min={0}
            value={s.maxRedirects ?? ""}
            placeholder="10 (기본)"
            onChange={(e) => set({ maxRedirects: numOrUndef(e.target.value) })}
            className="w-32 rounded border border-edge bg-base px-2 py-1 outline-none focus:border-accent"
          />
        </Field>
      )}
      <Field label="타임아웃 (ms)">
        <input
          type="number"
          min={0}
          value={s.timeoutMs ?? ""}
          placeholder="30000 (기본)"
          onChange={(e) => set({ timeoutMs: numOrUndef(e.target.value) })}
          className="w-32 rounded border border-edge bg-base px-2 py-1 outline-none focus:border-accent"
        />
      </Field>
    </div>
  );
}

/** 체크박스 토글 + 보조설명. */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 shrink-0"
      />
      <span>
        <div className="text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-fg-dim">{hint}</div>}
      </span>
    </label>
  );
}

const AUTH_KINDS: { kind: AuthConfig["kind"]; label: string }[] = [
  { kind: "none", label: "None" },
  { kind: "inherit", label: "Inherit" },
  { kind: "bearer", label: "Bearer" },
  { kind: "basic", label: "Basic" },
  { kind: "apikey", label: "API Key" },
];

/** 인증 폼(§7) — kind select + 조건부 입력(DbConnection Field 패턴). */
function AuthForm({
  auth,
  onChange,
}: {
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
}) {
  const setKind = (kind: AuthConfig["kind"]) => {
    switch (kind) {
      case "none":
        return onChange({ kind: "none" });
      case "inherit":
        return onChange({ kind: "inherit" });
      case "bearer":
        return onChange({ kind: "bearer", token: "" });
      case "basic":
        return onChange({ kind: "basic", username: "", password: "" });
      case "apikey":
        return onChange({ kind: "apikey", key: "", value: "", in: "header" });
    }
  };

  return (
    <div className="space-y-3 p-3 text-[13px]">
      <label className="block">
        <div className="mb-0.5 text-[12px] text-fg-muted">인증 방식</div>
        <select
          value={auth.kind}
          onChange={(e) => setKind(e.target.value as AuthConfig["kind"])}
          className="w-48 rounded border border-edge bg-base px-2 py-1 outline-none focus:border-accent"
        >
          {AUTH_KINDS.map((a) => (
            <option key={a.kind} value={a.kind}>
              {a.label}
            </option>
          ))}
        </select>
      </label>

      {auth.kind === "inherit" && (
        <div className="text-[12px] text-fg-dim">
          상위 폴더(컬렉션)의 인증을 위임합니다.
        </div>
      )}

      {auth.kind === "bearer" && (
        <Field label="Token">
          <input
            value={auth.token}
            onChange={(e) => onChange({ ...auth, token: e.target.value })}
            placeholder="{{token}} 또는 토큰 값"
            className="w-full rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
          />
        </Field>
      )}

      {auth.kind === "basic" && (
        <>
          <Field label="Username">
            <input
              value={auth.username}
              onChange={(e) => onChange({ ...auth, username: e.target.value })}
              className="w-full rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={auth.password}
              onChange={(e) => onChange({ ...auth, password: e.target.value })}
              className="w-full rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
            />
          </Field>
        </>
      )}

      {auth.kind === "apikey" && (
        <>
          <Field label="Key">
            <input
              value={auth.key}
              onChange={(e) => onChange({ ...auth, key: e.target.value })}
              placeholder="X-API-Key"
              className="w-full rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
            />
          </Field>
          <Field label="Value">
            <input
              value={auth.value}
              onChange={(e) => onChange({ ...auth, value: e.target.value })}
              placeholder="{{apiKey}}"
              className="w-full rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
            />
          </Field>
          <Field label="추가 위치">
            <select
              value={auth.in}
              onChange={(e) =>
                onChange({ ...auth, in: e.target.value as "header" | "query" })
              }
              className="w-48 rounded border border-edge bg-base px-2 py-1 outline-none focus:border-accent"
            >
              <option value="header">Header</option>
              <option value="query">Query</option>
            </select>
          </Field>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-0.5 text-[12px] text-fg-muted">{label}</div>
      {children}
    </label>
  );
}
