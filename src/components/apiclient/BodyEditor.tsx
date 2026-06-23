import type {
  ApiRequestBody,
  BodyMode,
  FormRow,
  FormType,
  KvRow,
} from "../../stores/apiclient";
import { KeyValueEditor } from "./KeyValueEditor";
import { MonacoBox } from "./MonacoBox";

const MODES: { mode: BodyMode; label: string }[] = [
  { mode: "none", label: "none" },
  { mode: "json", label: "json" },
  { mode: "form", label: "form" },
  { mode: "raw", label: "raw" },
  { mode: "binary", label: "binary" },
];

/**
 * 바디 편집기(§8.5). 세그먼트[none/json/form/raw/binary].
 * - json → MonacoBox(편집), form → KeyValueEditor(+formType 토글), raw → textarea, binary → 파일/base64.
 */
export function BodyEditor({
  body,
  onChange,
}: {
  body: ApiRequestBody;
  onChange: (patch: Partial<ApiRequestBody>) => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-3 py-1.5">
        {MODES.map((m) => (
          <button
            key={m.mode}
            onClick={() => onChange({ mode: m.mode })}
            className={`rounded px-2 py-0.5 text-[12px] ${
              body.mode === m.mode
                ? "bg-raised text-fg"
                : "text-fg-muted hover:bg-raised/60 hover:text-fg"
            }`}
          >
            {m.label}
          </button>
        ))}
        {body.mode === "form" && (
          <>
            <div className="mx-1 h-4 w-px bg-edge" />
            <FormTypeToggle
              value={body.formType}
              onChange={(formType) => onChange({ formType })}
            />
          </>
        )}
        {body.mode === "raw" && (
          <input
            value={body.rawType}
            onChange={(e) => onChange({ rawType: e.target.value })}
            placeholder="Content-Type"
            className="ml-auto w-48 rounded border border-edge bg-base px-2 py-0.5 text-[12px] font-mono outline-none focus:border-accent"
          />
        )}
      </div>

      <div className="min-h-0 flex-1">
        {body.mode === "none" && (
          <div className="flex h-full items-center justify-center text-[13px] text-fg-dim">
            본문 없음
          </div>
        )}
        {body.mode === "json" && (
          <MonacoBox
            language="json"
            value={body.text}
            onChange={(text) => onChange({ text })}
          />
        )}
        {body.mode === "raw" && (
          <textarea
            value={body.text}
            onChange={(e) => onChange({ text: e.target.value })}
            placeholder="원문 본문…"
            spellCheck={false}
            className="h-full w-full resize-none bg-base px-3 py-2 font-mono text-[13px] text-fg outline-none"
          />
        )}
        {body.mode === "form" && (
          <FormBody
            form={body.form}
            formType={body.formType}
            onChange={(form) => onChange({ form })}
          />
        )}
        {body.mode === "binary" && (
          <BinaryBody body={body} onChange={onChange} />
        )}
      </div>
    </div>
  );
}

function FormTypeToggle({
  value,
  onChange,
}: {
  value: FormType;
  onChange: (v: FormType) => void;
}) {
  return (
    <div className="flex items-center gap-1 text-[12px]">
      {(["urlencoded", "multipart"] as FormType[]).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`rounded px-1.5 py-0.5 ${
            value === t
              ? "bg-accent/20 text-accent"
              : "text-fg-dim hover:bg-raised/60 hover:text-fg"
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

/** form 행 — KeyValueEditor를 FormRow로 어댑트. multipart일 때 partKind/file 필드 노출. */
function FormBody({
  form,
  formType,
  onChange,
}: {
  form: FormRow[];
  formType: FormType;
  onChange: (rows: FormRow[]) => void;
}) {
  // urlencoded는 text 행만 — KeyValueEditor로 충분(KvRow 어댑트).
  if (formType === "urlencoded") {
    const rows: KvRow[] = form.map((f) => ({
      id: f.id,
      enabled: f.enabled,
      key: f.key,
      value: f.value,
    }));
    return (
      <div className="overflow-auto">
        <KeyValueEditor
          rows={rows}
          onChange={(next) =>
            onChange(
              next.map((r) => {
                const prev = form.find((f) => f.id === r.id);
                return {
                  ...r,
                  partKind: prev?.partKind ?? "text",
                  filePath: prev?.filePath,
                  fileName: prev?.fileName,
                  contentType: prev?.contentType,
                };
              }),
            )
          }
        />
      </div>
    );
  }

  // multipart — 행마다 text/file 토글.
  const update = (id: string, patch: Partial<FormRow>) =>
    onChange(form.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const remove = (id: string) => onChange(form.filter((f) => f.id !== id));
  const addRow = (patch: Partial<FormRow>) =>
    onChange([
      ...form,
      {
        id: crypto.randomUUID(),
        enabled: true,
        key: "",
        value: "",
        partKind: "text",
        ...patch,
      },
    ]);

  return (
    <div className="overflow-auto text-[13px]">
      {form.map((f) => (
        <div
          key={f.id}
          className="flex items-center gap-2 border-b border-edge/50 px-3 py-1"
        >
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => update(f.id, { enabled: e.target.checked })}
            className="shrink-0 accent-accent"
          />
          <select
            value={f.partKind}
            onChange={(e) =>
              update(f.id, { partKind: e.target.value as "text" | "file" })
            }
            className="shrink-0 rounded border border-edge bg-base px-1 py-1 text-[12px] outline-none focus:border-accent"
          >
            <option value="text">text</option>
            <option value="file">file</option>
          </select>
          <input
            value={f.key}
            onChange={(e) => update(f.id, { key: e.target.value })}
            placeholder="field"
            className="w-1/4 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
          />
          {f.partKind === "file" ? (
            <input
              value={f.filePath ?? ""}
              onChange={(e) => update(f.id, { filePath: e.target.value })}
              placeholder="파일 경로"
              className="min-w-0 flex-1 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
            />
          ) : (
            <input
              value={f.value}
              onChange={(e) => update(f.id, { value: e.target.value })}
              placeholder="value"
              className="min-w-0 flex-1 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
            />
          )}
          <button
            onClick={() => remove(f.id)}
            title="행 삭제"
            className="shrink-0 text-fg-dim hover:text-danger"
          >
            ✕
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 px-3 py-1 opacity-60">
        <input type="checkbox" checked={false} disabled className="shrink-0 accent-accent" />
        <span className="shrink-0 text-[12px] text-fg-dim">text</span>
        <input
          value=""
          onChange={(e) => addRow({ key: e.target.value })}
          placeholder="field"
          className="w-1/4 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
        />
        <input
          value=""
          onChange={(e) => addRow({ value: e.target.value })}
          placeholder="value"
          className="min-w-0 flex-1 rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
        />
        <span className="w-3 shrink-0" />
      </div>
    </div>
  );
}

/** binary 바디 — 파일 경로(우선) 또는 인라인 base64 + Content-Type(§2 Standard). */
function BinaryBody({
  body,
  onChange,
}: {
  body: ApiRequestBody;
  onChange: (patch: Partial<ApiRequestBody>) => void;
}) {
  return (
    <div className="space-y-3 p-3 text-[13px]">
      <label className="block">
        <div className="mb-0.5 text-[12px] text-fg-muted">파일 경로 (우선)</div>
        <input
          value={body.binaryPath ?? ""}
          onChange={(e) => onChange({ binaryPath: e.target.value })}
          placeholder="C:/path/to/file.bin"
          className="w-full rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
        />
      </label>
      <label className="block">
        <div className="mb-0.5 text-[12px] text-fg-muted">또는 인라인 base64</div>
        <textarea
          value={body.binaryBase64 ?? ""}
          onChange={(e) => onChange({ binaryBase64: e.target.value })}
          placeholder="base64 데이터…"
          spellCheck={false}
          className="h-24 w-full resize-none rounded border border-edge bg-base px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
        />
      </label>
      <label className="block">
        <div className="mb-0.5 text-[12px] text-fg-muted">Content-Type</div>
        <input
          value={body.binaryContentType ?? ""}
          onChange={(e) => onChange({ binaryContentType: e.target.value })}
          placeholder="application/octet-stream"
          className="w-full rounded border border-edge bg-base px-2 py-1 font-mono outline-none focus:border-accent"
        />
      </label>
    </div>
  );
}
