import { open } from "@tauri-apps/plugin-dialog";
import { Database, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { DbConnection, DbEngine } from "../../lib/ipc";
import { useDeleteConnection, useSaveConnection } from "../../queries";
import { useDb } from "../../stores/db";

const ENGINES: { value: DbEngine; label: string; port: number }[] = [
  { value: "mongodb", label: "MongoDB", port: 27017 },
  { value: "postgres", label: "PostgreSQL", port: 5432 },
  { value: "mysql", label: "MySQL", port: 3306 },
  { value: "mssql", label: "SQL Server", port: 1433 },
  { value: "sqlite", label: "SQLite", port: 0 },
];

const inputCls =
  "w-full rounded border border-edge bg-base px-2 py-1 outline-none focus:border-accent";

/** 옵션 문자열에서 tls=true를 토글한다(다른 옵션은 보존). */
function toggleTls(options: string | null, on: boolean): string | null {
  const parts = (options ?? "")
    .split("&")
    .map((p) => p.trim())
    .filter((p) => p && !/^tls=/i.test(p));
  if (on) parts.push("tls=true");
  return parts.join("&") || null;
}

/** SQL Server Windows 통합 인증(trusted_connection=yes) 토글. */
function toggleTrusted(options: string | null, on: boolean): string | null {
  const parts = (options ?? "")
    .split("&")
    .map((p) => p.trim())
    .filter((p) => p && !/^trusted_connection=/i.test(p));
  if (on) parts.push("trusted_connection=yes");
  return parts.join("&") || null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[12px] font-medium text-fg-muted">{label}</div>
      {children}
    </label>
  );
}

export function ConnectionDialog() {
  const dialog = useDb((s) => s.dialog);
  const closeDialog = useDb((s) => s.closeDialog);
  const onRemoved = useDb((s) => s.onConnectionRemoved);
  const save = useSaveConnection();
  const del = useDeleteConnection();

  const [form, setForm] = useState<DbConnection | null>(null);
  const [password, setPassword] = useState("");

  const isNew = dialog === "new";

  useEffect(() => {
    if (!dialog) {
      setForm(null);
      return;
    }
    setPassword("");
    if (dialog === "new") {
      setForm({
        id: crypto.randomUUID(),
        name: "",
        engine: "mongodb",
        host: "localhost",
        port: 27017,
        database: null,
        username: "",
        options: null,
        readOnly: false,
        color: null,
      });
    } else {
      setForm({ ...dialog });
    }
  }, [dialog]);

  if (!dialog || !form) return null;

  const update = <K extends keyof DbConnection>(key: K, value: DbConnection[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  function handleEngine(engine: DbEngine) {
    const meta = ENGINES.find((e) => e.value === engine);
    setForm((f) =>
      f ? { ...f, engine, port: meta ? meta.port : f.port } : f,
    );
  }

  function handleSave() {
    if (!form) return;
    const cleaned: DbConnection = {
      ...form,
      name:
        form.name.trim() ||
        (form.engine === "sqlite"
          ? form.database?.split(/[\\/]/).pop() || "SQLite"
          : `${form.host}:${form.port}`),
      database: form.database?.trim() || null,
      options: form.options?.trim() || null,
    };
    save.mutate(
      { connection: cleaned, password: password || null },
      { onSuccess: () => closeDialog() },
    );
  }

  function handleDelete() {
    if (!form) return;
    del.mutate(form.id, {
      onSuccess: () => {
        onRemoved(form.id);
        closeDialog();
      },
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={closeDialog}
    >
      <div
        className="w-[460px] rounded-lg border border-edge bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Database size={16} className="text-accent" />
          <span className="font-semibold">
            {isNew ? "연결 추가" : "연결 편집"}
          </span>
          <div className="flex-1" />
          <button
            onClick={closeDialog}
            className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-[13px]">
          <Field label="이름">
            <input
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="예: NEXUS"
              className={inputCls}
            />
          </Field>

          <Field label="엔진">
            <select
              value={form.engine}
              onChange={(e) => handleEngine(e.target.value as DbEngine)}
              className={inputCls}
            >
              {ENGINES.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          </Field>

          {form.engine === "sqlite" ? (
            // SQLite는 파일 1개 = DB 1개 — 호스트/포트/인증이 아니라 파일 경로가 필요하다.
            <Field label="데이터베이스 파일">
              <div className="flex gap-2">
                <input
                  value={form.database ?? ""}
                  onChange={(e) => update("database", e.target.value)}
                  placeholder="C:\\path\\to\\app.db"
                  className={`${inputCls} flex-1 font-mono`}
                />
                <button
                  type="button"
                  onClick={async () => {
                    const picked = await open({
                      multiple: false,
                      directory: false,
                      title: "SQLite 데이터베이스 파일 선택",
                    });
                    if (typeof picked === "string") update("database", picked);
                  }}
                  className="shrink-0 rounded border border-edge px-3 text-fg-muted hover:bg-raised hover:text-fg"
                >
                  찾아보기
                </button>
              </div>
            </Field>
          ) : (
            <>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Field label="호스트">
                    <input
                      value={form.host}
                      onChange={(e) => update("host", e.target.value)}
                      className={`${inputCls} font-mono`}
                    />
                  </Field>
                </div>
                <div className="w-24">
                  <Field label="포트">
                    <input
                      type="number"
                      min={0}
                      max={65535}
                      value={form.port}
                      onChange={(e) =>
                        update(
                          "port",
                          Math.max(
                            0,
                            Math.min(
                              65535,
                              Math.floor(Number(e.target.value) || 0),
                            ),
                          ),
                        )
                      }
                      className={`${inputCls} font-mono`}
                    />
                  </Field>
                </div>
              </div>

              <div className="flex gap-2">
                <div className="flex-1">
                  <Field label="사용자 (선택)">
                    <input
                      value={form.username}
                      onChange={(e) => update("username", e.target.value)}
                      className={inputCls}
                    />
                  </Field>
                </div>
                <div className="flex-1">
                  <Field
                    label={isNew ? "비밀번호 (선택)" : "비밀번호 (변경 시만)"}
                  >
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={isNew ? "" : "(유지)"}
                      className={inputCls}
                    />
                  </Field>
                </div>
              </div>

              <Field label="기본 DB (선택)">
                <input
                  value={form.database ?? ""}
                  onChange={(e) => update("database", e.target.value)}
                  className={`${inputCls} font-mono`}
                />
              </Field>

              <Field label="옵션 (선택)">
                <input
                  value={form.options ?? ""}
                  onChange={(e) => update("options", e.target.value)}
                  placeholder={
                    form.engine === "mssql"
                      ? "encrypt=false&trustServerCertificate=false"
                      : "authSource=admin&tls=true"
                  }
                  className={`${inputCls} font-mono`}
                />
              </Field>
            </>
          )}

          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={form.readOnly}
              onChange={(e) => update("readOnly", e.target.checked)}
              className="accent-accent"
            />
            <span>읽기 전용 (쓰기 쿼리 차단)</span>
          </label>

          {form.engine !== "mssql" && form.engine !== "sqlite" && (
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={(form.options ?? "").includes("tls=true")}
                onChange={(e) =>
                  update("options", toggleTls(form.options, e.target.checked))
                }
                className="accent-accent"
              />
              <span>TLS 사용 (암호화 연결 — 서버가 지원할 때)</span>
            </label>
          )}

          {form.engine === "mssql" && (
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={(form.options ?? "")
                  .toLowerCase()
                  .includes("trusted_connection=yes")}
                onChange={(e) =>
                  update("options", toggleTrusted(form.options, e.target.checked))
                }
                className="accent-accent"
              />
              <span>Windows 인증 (통합 보안 — 사용자/비밀번호 무시)</span>
            </label>
          )}
          {form.engine !== "sqlite" && (
            <div className="text-[11px] text-fg-dim">
              비밀번호는 OS 키체인(Windows 자격증명 관리자)에 저장됩니다.
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center gap-2">
          {!isNew && (
            <button
              onClick={handleDelete}
              disabled={del.isPending}
              className="flex items-center gap-1.5 rounded px-3 py-1.5 text-danger hover:bg-danger/10"
            >
              <Trash2 size={14} /> 삭제
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={closeDialog}
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
