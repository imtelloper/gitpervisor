import { Copy, X } from "lucide-react";

import { fmtDateTime } from "../../i18n/format-locale";
import { useMessages } from "../../i18n/ui-language";
import { copyWithToast } from "../../lib/clipboard";
import { formatBytes } from "../../lib/format";
import type { ExifSummary, FavImageInfo } from "../../lib/ipc";

/** 셔터 속도 표기 — 1초 미만은 사진에서 늘 쓰는 분수(1/120). */
const shutter = (sec: number) => (sec < 1 ? `1/${Math.round(1 / sec)}` : `${+sec.toFixed(1)}`);

/** 제조사·모델 — 모델에 제조사가 이미 들어 있으면(Canon / Canon EOS R5) 한 번만. */
function cameraName(e: ExifSummary): string | undefined {
  if (e.make && e.model) {
    return e.model.toLowerCase().startsWith(e.make.toLowerCase()) ? e.model : `${e.make} ${e.model}`;
  }
  return e.model ?? e.make;
}

/**
 * 사진 뷰어 오른쪽 정보 패널(설계 D6) — 파일(이름·폴더·수정 시각·크기·해상도·형식)과 촬영 정보(EXIF). 값은 고를 수
 * 있게 둔다(select-text) — 경로·렌즈 이름을 일부만 복사하는 일이 흔하다.
 */
export function PhotoInfoPanel({
  path,
  name,
  info,
  error,
  dims,
  onClose,
}: {
  path: string;
  name: string;
  /** null = 읽는 중(또는 실패 — `error`). */
  info: FavImageInfo | null;
  error: string | null;
  /** 보이는 그림의 치수(아래 줄과 같은 값). */
  dims: { w: number; h: number } | null;
  onClose: () => void;
}) {
  const msg = useMessages();
  const t = msg.folder.lightbox.info;
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const exif = info?.exif ?? null;
  const settings = exif
    ? [
        exif.exposure !== undefined ? t.shutter(shutter(exif.exposure)) : null,
        exif.fNumber !== undefined ? `f/${+exif.fNumber.toFixed(1)}` : null,
        exif.iso !== undefined ? `ISO ${exif.iso}` : null,
        exif.focalLength !== undefined ? `${+exif.focalLength.toFixed(1)} mm` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <div data-photo-info className="flex w-72 max-w-[40%] shrink-0 flex-col border-l border-edge bg-panel text-xs">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-edge px-3 text-fg-dim">
        <span className="min-w-0 flex-1 truncate">{t.heading}</span>
        <button onClick={onClose} title={t.close} className="rounded p-1 hover:bg-raised hover:text-fg">
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 select-text overflow-y-auto px-3 py-2">
        <Field label={t.name} value={name} />
        <Field label={t.folder} value={cut > 0 ? path.slice(0, cut) : path} />
        {error ? (
          <div className="py-1 text-danger">{t.failed(error)}</div>
        ) : !info ? (
          <div className="py-1 text-fg-dim">{msg.folder.loading}</div>
        ) : (
          <>
            <Field label={t.modified} value={fmtDateTime(new Date(info.modifiedMs))} />
            <Field label={t.size} value={formatBytes(info.bytes)} />
            <Field label={t.dimensions} value={dims ? `${dims.w} × ${dims.h}` : undefined} />
            <Field label={t.format} value={info.format} />
            <div className="my-2 border-t border-edge" />
            {exif ? (
              <>
                <Field label={t.taken} value={exif.takenAt} />
                <Field label={t.camera} value={cameraName(exif)} />
                <Field label={t.lens} value={exif.lens} />
                <Field label={t.settings} value={settings} />
                <Field
                  label={t.location}
                  value={
                    exif.gpsLat !== undefined && exif.gpsLon !== undefined
                      ? `${exif.gpsLat.toFixed(5)}, ${exif.gpsLon.toFixed(5)}`
                      : undefined
                  }
                />
              </>
            ) : (
              <div className="py-1 text-fg-dim">{t.noExif}</div>
            )}
          </>
        )}
      </div>
      <div className="shrink-0 border-t border-edge px-3 py-2">
        <button
          onClick={() => copyWithToast(path, msg.folder.copyPathDone)}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-edge px-2 py-1.5 text-fg-muted hover:bg-raised hover:text-fg"
        >
          <Copy size={13} /> {msg.folder.menuCopyPath}
        </button>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="py-1">
      <div className="text-[11px] text-fg-dim">{label}</div>
      <div className="break-all leading-5 text-fg">{value}</div>
    </div>
  );
}
