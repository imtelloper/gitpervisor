# Gitpervisor — Website

Marketing / landing site for **Gitpervisor**. Built with **Next.js 16 (App Router)**,
**React 19**, and **Tailwind CSS v4**. Lives inside the main repo as an independent
package (its own `package.json`), so it never touches the desktop app's build.

## No backend required

Binaries are **not** served by this site. They live on **GitHub Releases** (free CDN
+ download counts). This site only reads the *latest* release metadata to link the
right installer:

- `lib/github.ts` → `getLatestRelease()` fetches `repos/imtelloper/gitpervisor/releases/latest`
  and maps assets to platforms by **extension + arch keyword** (resilient to Tauri's
  versioned filenames like `Gitpervisor_0.2.0_x64-setup.exe`).
- Cached for 1h via Next ISR on dynamic hosts (Vercel/Netlify); on a static export the
  data is baked at build time.
- If the fetch fails (offline build / rate limit / no releases yet), buttons fall back
  to the releases page — nothing breaks.
- `lib/use-os.ts` detects the visitor's OS on the client to highlight the matching button.

The installers themselves are produced by **`../.github/workflows/release.yml`**
(Tauri builds for Windows NSIS, a universal macOS `.dmg`, and Linux AppImage/deb/rpm),
triggered by pushing a version tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

> The workflow creates a **draft** release. The GitHub "latest release" API excludes
> drafts, so after the build finishes you must **publish** the draft (Releases → the
> draft → *Publish release*). Until then the site's buttons gracefully fall back to the
> `/releases` page instead of linking the new installers.

## Develop

```bash
cd website
npm install
npm run dev      # http://localhost:3000
```

## Build

```bash
npm run build
npm start
```

## Deploy (recommended: Vercel or Netlify)

Both have free tiers for open source and support ISR (so the 1h release-metadata
refresh works without rebuilds).

- **Vercel** — Import the repo, set **Root Directory = `website`**. Done.
- **Netlify** — New site from repo, set **Base directory = `website`**, build `npm run build`.
- **GitHub Pages** — possible but static-only: add `output: "export"` to `next.config.ts`
  and trigger a rebuild on each release (the metadata is then baked at build time).

## Configuration

- Repo / URLs: `lib/github.ts` (`REPO_OWNER`, `REPO_NAME`).
- Public site URL (used for OG/metadata): `SITE_URL` in `lib/github.ts` — update once the
  domain is finalized.

## Install notes (unsigned builds)

The desktop app is currently unsigned, so first launch shows a warning:

- **Windows** — SmartScreen → "More info" → "Run anyway".
- **macOS** — Gatekeeper → right-click the app → "Open".

Resolve by code-signing (Windows cert) / Apple notarization later.
