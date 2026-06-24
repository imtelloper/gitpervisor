"use client";

import { useEffect, useState } from "react";

export type DetectedOS = "windows" | "macos" | "linux" | "unknown";

/**
 * Detect the visitor's OS on the client so the matching download button can be
 * highlighted. Returns "unknown" during SSR / first paint to avoid hydration
 * mismatch; resolves after mount.
 */
export function useDetectedOS(): DetectedOS {
  const [os, setOs] = useState<DetectedOS>("unknown");

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    const plat = (navigator.platform || "").toLowerCase();
    // Treat iPad-on-desktop-UA Macs as macOS; touch iOS isn't a download target.
    if (/win/.test(ua) || /win/.test(plat)) setOs("windows");
    else if (/mac/.test(ua) || /mac/.test(plat)) setOs("macos");
    else if (/linux|x11/.test(ua) && !/android/.test(ua)) setOs("linux");
    else setOs("unknown");
  }, []);

  return os;
}
