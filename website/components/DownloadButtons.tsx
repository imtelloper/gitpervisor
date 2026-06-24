"use client";

import { GitHubIcon } from "@/components/icons";
import {
  assetUrl,
  GITHUB_URL,
  RELEASES_URL,
  type Platform,
  type ReleaseInfo,
} from "@/lib/github";
import { useDetectedOS, type DetectedOS } from "@/lib/use-os";

/* ── Brand glyphs (lucide has no OS brand icons) ───────────────────── */
function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  );
}
function AppleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.114.07-2.383 1.39-2.383 4.18 0 3.26 2.854 4.42 2.955 4.45z" />
    </svg>
  );
}
function LinuxIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2c-2.1 0-3.5 1.8-3.5 4 0 .9.2 1.6.2 2.4 0 .8-1 2-1.8 3.5-.9 1.6-1.7 3.4-1.7 4.9 0 1.3.5 2.3 1.4 2.9-.2.5-.3 1-.3 1.4 0 .9.7 1.5 1.9 1.5.8 0 1.4-.3 1.9-.7.5.1 1.1.2 1.8.2s1.3-.1 1.8-.2c.5.4 1.1.7 1.9.7 1.2 0 1.9-.6 1.9-1.5 0-.4-.1-.9-.3-1.4.9-.6 1.4-1.6 1.4-2.9 0-1.5-.8-3.3-1.7-4.9-.8-1.5-1.8-2.7-1.8-3.5 0-.8.2-1.5.2-2.4 0-2.2-1.4-4-3.5-4zm-1.4 5.1c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zm2.8 0c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9zm-1.4 2.3c.7 0 1.6.5 1.6.9 0 .3-.9.8-1.6.8s-1.6-.5-1.6-.8c0-.4.9-.9 1.6-.9z" />
    </svg>
  );
}

const PLATFORMS: {
  os: DetectedOS;
  platform: Platform;
  label: string;
  ext: string;
  Icon: (p: { className?: string }) => React.ReactElement;
}[] = [
  { os: "windows", platform: "windows", label: "Windows", ext: ".exe", Icon: WindowsIcon },
  { os: "macos", platform: "macos", label: "macOS", ext: ".dmg · universal", Icon: AppleIcon },
  { os: "linux", platform: "linux", label: "Linux", ext: ".AppImage", Icon: LinuxIcon },
];

/* ── Hero download buttons (one per platform, detected OS highlighted) ── */
export function DownloadButtons({ release }: { release: ReleaseInfo | null }) {
  const detected = useDetectedOS();
  // Default to highlighting Windows until detection resolves (matches design).
  const primary: DetectedOS = detected === "unknown" ? "windows" : detected;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex flex-wrap items-stretch justify-center gap-3">
        {PLATFORMS.map(({ os, platform, label, ext, Icon }) => {
          const isPrimary = os === primary;
          return (
            <a
              key={platform}
              href={assetUrl(release, platform)}
              className={[
                "group inline-flex items-center gap-3 rounded-xl px-5 py-3 text-sm font-medium transition",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base",
                isPrimary
                  ? "bg-accent-strong text-white shadow-[0_8px_30px_-6px] shadow-accent/50 hover:brightness-110"
                  : "border border-line bg-card text-ink hover:border-line-2 hover:bg-card-2",
              ].join(" ")}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="flex flex-col items-start leading-tight">
                <span>Download for {label}</span>
                <span
                  className={[
                    "font-mono text-[11px]",
                    isPrimary ? "text-white/90" : "text-muted",
                  ].join(" ")}
                >
                  {ext}
                </span>
              </span>
            </a>
          );
        })}

        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-medium text-muted transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <GitHubIcon className="h-5 w-5" />
          View Source
        </a>
      </div>

      <p className="text-xs text-muted">
        Free &amp; open source · Universal macOS · Windows 10+ · Linux ·{" "}
        <a
          href={RELEASES_URL}
          className="text-ink underline decoration-line-2 underline-offset-2 hover:text-accent"
        >
          all downloads &amp; checksums
        </a>
      </p>
    </div>
  );
}

/* ── Compact CTA: single primary download + GitHub (reused in CTA section) ── */
export function DownloadCta({ release }: { release: ReleaseInfo | null }) {
  const detected = useDetectedOS();
  const primary = PLATFORMS.find((p) => p.os === detected) ?? PLATFORMS[0];

  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <a
        href={assetUrl(release, primary.platform)}
        className="inline-flex items-center gap-2 rounded-xl bg-accent-strong px-6 py-3 text-sm font-medium text-white shadow-[0_8px_30px_-6px] shadow-accent/50 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <primary.Icon className="h-5 w-5" />
        Download for Free
      </a>
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-xl border border-line bg-card px-6 py-3 text-sm font-medium text-ink transition hover:border-line-2 hover:bg-card-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <GitHubIcon className="h-5 w-5" />
        View on GitHub
      </a>
    </div>
  );
}
