import { GitHubIcon } from "@/components/icons";
import { GITHUB_URL, RELEASES_URL } from "@/lib/github";

export function Footer() {
  return (
    <footer className="border-t border-line px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 sm:justify-start">
          <img src="/logo.png" alt="" width={24} height={24} className="h-6 w-6 rounded-md opacity-90" />
          <span className="font-display font-semibold text-ink">Gitpervisor</span>
          <span className="text-sm text-muted">· MIT License · Made for developers</span>
        </div>

        <nav aria-label="Footer" className="flex items-center gap-6 text-sm">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-muted transition hover:text-ink"
          >
            <GitHubIcon className="h-4 w-4" />
            GitHub
          </a>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted transition hover:text-ink"
          >
            Releases
          </a>
          <a
            href={`${GITHUB_URL}#readme`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted transition hover:text-ink"
          >
            Docs
          </a>
        </nav>
      </div>
    </footer>
  );
}
