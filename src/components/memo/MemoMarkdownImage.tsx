import { useEffect, useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { memoImagePngFallbackUrl, memoImageUrl } from "../../lib/memo-image-pipeline";
import { parseMemoImageUrl } from "../../lib/memo-tokens";

/**
 * 메모장 MD 보기의 `<img>` — 본문의 `memo-img/<id>.avif#w=320` 을 앱 데이터의 이미지로 푼다.
 * 메모 이미지가 아닌 주소는 손대지 않고 그대로 그린다. 크기 조절은 편집 화면에서만 한다.
 */
export function MemoMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const msg = useMessages();
  const memoImage = typeof src === "string" ? parseMemoImageUrl(src) : null;
  const id = memoImage?.id ?? null;
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [triedPng, setTriedPng] = useState(false);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setUrl(null);
    setMissing(false);
    setTriedPng(false);
    memoImageUrl(id).then(
      (u) => alive && setUrl(u),
      () => alive && setMissing(true),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  if (!id) return <img src={src} alt={alt} />;
  if (missing)
    return <span className="text-[12px] text-fg-dim">{msg.notes.memoPanel.imageMissing}</span>;
  if (!url)
    return <span className="text-[12px] text-fg-dim">{msg.notes.memoPanel.imageLoading}</span>;
  return (
    <img
      src={url}
      alt={alt}
      style={memoImage?.width ? { width: memoImage.width } : undefined}
      // AVIF 를 못 그리는 웹뷰(배포판 WebKitGTK) — 한 번만 PNG 로 풀어 본다.
      onError={() => {
        if (triedPng) return setMissing(true);
        setTriedPng(true);
        memoImagePngFallbackUrl(id).then(setUrl, () => setMissing(true));
      }}
    />
  );
}
