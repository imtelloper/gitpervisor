// 화면 캡쳐·녹화 설정 (DOCS/screen-capture-design.md §5.4). 폴더 null = OS 기본 — placeholder 로 그 경로를 보인다.
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { RefreshCw } from "lucide-react";

import { useMessages } from "../../../i18n/ui-language";
import { errorMessage, ipc } from "../../../lib/ipc";
import { useUi } from "../../../stores/ui";
import { Field, Hl, inputCls, type SectionProps } from "./shared";

const btnCls =
  "shrink-0 rounded border border-edge px-2 py-1 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50";

export function CaptureSection({ form, update, hl }: SectionProps) {
  const t = useMessages().settings.capture;
  const dirs = useQuery({
    queryKey: ["record-default-dirs"],
    queryFn: () => ipc.recordDefaultDirs(),
    staleTime: Infinity,
  });
  // 장치 열거는 ffmpeg 를 한 번 띄운다 — 창 포커스마다 다시 돌리지 않고 [새로고침]으로만.
  const audio = useQuery({
    queryKey: ["record-audio-devices"],
    queryFn: () => ipc.recordAudioDevices(),
    refetchOnWindowFocus: false,
  });
  const devices = audio.data ?? [];
  const device = form.recordAudioDevice;

  return (
    <>
      <div className="text-[11px] text-fg-dim">{t.hotkeys}</div>

      <Hl id="captureAutoSave" hl={hl}>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={form.captureAutoSave}
            onChange={(e) => update("captureAutoSave", e.target.checked)}
            className="accent-accent"
          />
          <span>{t.autoSave}</span>
        </label>
      </Hl>

      <DirField
        k="captureSaveDir"
        label={t.captureDirLabel}
        placeholder={dirs.data?.screenshots ?? t.osDefaultDir}
        form={form}
        update={update}
        hl={hl}
      />
      <DirField
        k="recordSaveDir"
        label={t.recordDirLabel}
        placeholder={dirs.data?.recordings ?? t.osDefaultDir}
        form={form}
        update={update}
        hl={hl}
      />

      <div className="grid grid-cols-3 gap-3">
        <Hl id="recordFps" hl={hl}>
          <Field label={t.fpsLabel}>
            <select
              value={form.recordFps}
              onChange={(e) => update("recordFps", Number(e.target.value))}
              className={inputCls}
            >
              {[30, 60].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </Hl>
        <Hl id="recordCountdownSecs" hl={hl}>
          <Field label={t.countdownLabel}>
            <select
              value={form.recordCountdownSecs}
              onChange={(e) => update("recordCountdownSecs", Number(e.target.value))}
              className={inputCls}
            >
              {[0, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t.countdownNone : t.countdownSecs(n)}
                </option>
              ))}
            </select>
          </Field>
        </Hl>
        <Hl id="recordMaxMinutes" hl={hl}>
          <Field label={t.maxMinutesLabel}>
            <input
              type="number"
              min={1}
              max={120}
              value={form.recordMaxMinutes}
              onChange={(e) => update("recordMaxMinutes", Number(e.target.value))}
              className={inputCls}
            />
          </Field>
        </Hl>
      </div>
      <div className="-mt-2 text-[11px] text-fg-dim">
        {t.fpsHint} · {t.maxMinutesHint}
      </div>

      <Hl id="recordDrawMouse" hl={hl}>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={form.recordDrawMouse}
            onChange={(e) => update("recordDrawMouse", e.target.checked)}
            className="accent-accent"
          />
          <span>{t.drawMouse}</span>
        </label>
      </Hl>

      <Hl id="recordAudioDevice" hl={hl}>
        <Field label={t.audioLabel} hint={t.audioHint}>
          <div className="flex gap-2">
            <select
              value={device ?? ""}
              onChange={(e) => update("recordAudioDevice", e.target.value || null)}
              className={inputCls}
            >
              <option value="">{t.audioNone}</option>
              {devices.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              {/* 저장된 장치가 목록에 없으면(뽑혔거나 목록을 못 읽었다) 그대로 보여 준다 — 없으면 select 가
                  "없음"으로 보이는데 저장값은 장치라, 보이는 것과 실제 녹음이 어긋난다. */}
              {device && !devices.includes(device) && (
                <option value={device}>{audio.isSuccess ? t.audioMissing(device) : device}</option>
              )}
            </select>
            <button
              onClick={() => void audio.refetch()}
              disabled={audio.isFetching}
              title={t.audioRefresh}
              className={btnCls}
            >
              <RefreshCw size={13} className={audio.isFetching ? "animate-spin" : undefined} />
            </button>
          </div>
          {audio.error && (
            <div className="mt-1 text-[11px] text-warn">⚠ {errorMessage(audio.error)}</div>
          )}
        </Field>
      </Hl>
    </>
  );
}

function DirField({
  k,
  label,
  placeholder,
  form,
  update,
  hl,
}: SectionProps & { k: "captureSaveDir" | "recordSaveDir"; label: string; placeholder: string }) {
  const t = useMessages().settings.capture;
  const value = form[k];
  return (
    <Hl id={k} hl={hl}>
      <Field label={label}>
        <div className="flex gap-2">
          {/* 손으로 치는 칸이 아니다 — 오타 난 경로가 저장되면 녹화를 끝낸 뒤에야 실패를 안다. */}
          <input readOnly value={value ?? ""} placeholder={placeholder} className={`${inputCls} font-mono text-[12px]`} />
          <button
            onClick={() =>
              void open({ directory: true, multiple: false, title: t.pickFolderTitle })
                .then((picked) => {
                  if (typeof picked === "string") update(k, picked);
                })
                .catch((e) => useUi.getState().pushToast("error", errorMessage(e)))
            }
            className={btnCls}
          >
            {t.pickFolder}
          </button>
          <button onClick={() => update(k, null)} disabled={value === null} className={btnCls}>
            {t.useDefault}
          </button>
        </div>
      </Field>
    </Hl>
  );
}
