// ── GitHub Releases integration ─────────────────────────────────────
// No backend required: binaries live on GitHub Releases (free CDN + download
// counts). This module reads the *latest* release metadata so the site can
// link directly to the correct assets. Asset matching is by extension + arch
// keyword, so it is resilient to Tauri's versioned file names
// (e.g. gitpervisor_0.2.0_x64-setup.exe, gitpervisor_0.2.0_aarch64.dmg).

export const REPO_OWNER = "imtelloper";
export const REPO_NAME = "gitpervisor";
export const REPO = `${REPO_OWNER}/${REPO_NAME}`;

export const GITHUB_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
export const ISSUES_URL = `${GITHUB_URL}/issues`;

// Public site URL (used for OG/canonical metadata).
export const SITE_URL = "https://gitpervisor.aickyway.com";

export type Platform = "windows" | "macos" | "linux";

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  /** git tag, e.g. "v0.2.0" */
  version: string;
  /** release page URL */
  htmlUrl: string;
  publishedAt: string | null;
  downloads: Partial<Record<Platform, ReleaseAsset>>;
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

/**
 * Fetch the latest GitHub release and map its assets to platforms.
 * Cached for 1h via Next ISR on dynamic hosts (Vercel/Netlify); on a static
 * export the data is baked at build time. Returns `null` on any failure
 * (offline build, rate limit, no releases yet) so callers can fall back to
 * the releases page.
 */
export async function getLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        next: { revalidate: 3600 },
      },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string | null;
      assets?: GhAsset[];
    };

    const assets = data.assets ?? [];
    const pick = (re: RegExp): ReleaseAsset | undefined => {
      const a = assets.find((x) => re.test(x.name));
      return a ? { name: a.name, url: a.browser_download_url, size: a.size } : undefined;
    };

    return {
      version: data.tag_name ?? "latest",
      htmlUrl: data.html_url ?? RELEASES_URL,
      publishedAt: data.published_at ?? null,
      downloads: {
        // NSIS installer (Windows builds nsis only — see .github/workflows/release.yml)
        windows: pick(/-setup\.exe$/i) ?? pick(/\.exe$/i) ?? pick(/\.msi$/i),
        // CI ships a single universal .dmg (universal-apple-darwin); fall back
        // to arch-specific or any dmg for resilience to future config changes.
        macos:
          pick(/universal.*\.dmg$/i) ??
          pick(/(aarch64|arm64).*\.dmg$/i) ??
          pick(/(x64|x86_64|intel).*\.dmg$/i) ??
          pick(/\.dmg$/i),
        linux: pick(/\.appimage$/i) ?? pick(/\.deb$/i),
      },
    };
  } catch {
    return null;
  }
}

/** URL to download a platform's asset, falling back to the releases page. */
export function assetUrl(
  release: ReleaseInfo | null,
  platform: Platform,
): string {
  // Fall back to the releases *index* (not /releases/latest): the index always
  // renders for anonymous visitors even with zero or only-draft releases, so
  // buttons never become dead links.
  return release?.downloads[platform]?.url ?? RELEASES_URL;
}
