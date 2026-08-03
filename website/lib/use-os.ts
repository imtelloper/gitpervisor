"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

export type DetectedOS = "windows" | "macos" | "linux" | "unknown";
export type DetectedArch = "arm64" | "x64" | "unknown";

interface UserAgentData {
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ architecture?: string }>;
}

/**
 * `navigator` never changes for the lifetime of the page, so there is nothing
 * to subscribe to — useSyncExternalStore is used purely for its SSR/hydration
 * contract: the server snapshot renders "unknown", the client snapshot reads
 * the real value, and React reconciles without a hydration mismatch.
 */
const noopSubscribe = () => () => {};

function readOS(): DetectedOS {
  const ua = navigator.userAgent.toLowerCase();
  const plat = (navigator.platform || "").toLowerCase();
  // Treat iPad-on-desktop-UA Macs as macOS; touch iOS isn't a download target.
  if (/win/.test(ua) || /win/.test(plat)) return "windows";
  if (/mac/.test(ua) || /mac/.test(plat)) return "macos";
  if (/linux|x11/.test(ua) && !/android/.test(ua)) return "linux";
  return "unknown";
}

function readArchFromUA(): DetectedArch {
  return /aarch64|arm64|armv8/.test(navigator.userAgent.toLowerCase())
    ? "arm64"
    : "x64";
}

const unknownOS = (): DetectedOS => "unknown";
const unknownArch = (): DetectedArch => "unknown";

/**
 * Detect the visitor's OS and CPU architecture so the matching download button
 * can be highlighted. Both resolve to "unknown" during SSR / first paint.
 *
 * Architecture is best-effort: Chromium hardcodes "X11; Linux x86_64" in the UA
 * string even on ARM hardware, so the UA string alone would send every ARM
 * Linux visitor to the amd64 build. UA Client Hints report the real value and
 * override the UA guess once they resolve; Firefox is honest in the UA string
 * and covers the rest. Every button stays visible either way — detection only
 * decides which one is emphasised.
 */
export function useDetectedPlatform(): { os: DetectedOS; arch: DetectedArch } {
  const os = useSyncExternalStore(noopSubscribe, readOS, unknownOS);
  const uaArch = useSyncExternalStore(
    noopSubscribe,
    readArchFromUA,
    unknownArch,
  );
  const [hintedArch, setHintedArch] = useState<DetectedArch | null>(null);

  useEffect(() => {
    let cancelled = false;
    const uaData = (navigator as Navigator & { userAgentData?: UserAgentData })
      .userAgentData;

    uaData
      ?.getHighEntropyValues?.(["architecture"])
      .then(({ architecture }) => {
        if (cancelled || !architecture) return;
        setHintedArch(architecture === "arm" ? "arm64" : "x64");
      })
      .catch(() => {
        /* hint unavailable (permissions policy, older browser) — keep the UA guess */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { os, arch: hintedArch ?? uaArch };
}
