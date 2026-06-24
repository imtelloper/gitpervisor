import { Command, Star } from "lucide-react";

import { GitHubIcon } from "@/components/icons";
import { GITHUB_URL } from "@/lib/github";

export function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-line bg-base/70 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent/15">
            <Command className="h-4 w-4 text-accent" />
          </span>
          <span className="font-display font-semibold text-ink">Gitpervisor</span>
        </a>

        <nav aria-label="Primary" className="hidden items-center gap-7 md:flex">
          <a
            href="#features"
            className="text-sm text-muted transition hover:text-ink"
          >
            Features
          </a>
          <a
            href="#download"
            className="text-sm text-muted transition hover:text-ink"
          >
            Download
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-muted transition hover:text-ink"
          >
            GitHub
          </a>
        </nav>

        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-card px-3.5 py-2 text-sm font-medium text-ink transition hover:border-line-2 hover:bg-card-2"
        >
          <GitHubIcon className="h-4 w-4" />
          Star on GitHub
          <Star className="hidden h-3.5 w-3.5 text-yellow sm:block" />
        </a>
      </div>
    </header>
  );
}
