import { Check } from "lucide-react";

const bullets: string[] = [
  "No telemetry or data collection",
  "MIT License — fork it, modify it, own it",
  "Runs entirely on your local machine",
  "Contribute on GitHub — PRs welcome",
];

type Stat = { label: string; value: string };

const stats: Stat[] = [
  { label: "Free & Open Source", value: "100%" },
  { label: "Telemetry & Tracking", value: "0" },
  { label: "License", value: "MIT" },
  { label: "Platforms Supported", value: "3" },
];

export function OpenSource() {
  return (
    <section className="border-y border-line bg-base-2 px-6 py-24">
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
            OPEN SOURCE
          </p>
          <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Built in the open.
            <br />
            Owned by you.
          </h2>
          <p className="mt-4 text-muted leading-relaxed">
            Gitpervisor is MIT-licensed and free forever. No telemetry, no
            accounts, no vendor lock-in. Your machine, your data, your rules.
          </p>
          <ul className="mt-8 space-y-3">
            {bullets.map((item) => (
              <li key={item} className="flex items-center gap-3">
                <Check className="h-5 w-5 text-green shrink-0" />
                <span className="text-muted">{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-line bg-card p-2">
          <ul className="divide-y divide-line">
            {stats.map((stat) => (
              <li
                key={stat.label}
                className="flex items-center justify-between px-4 py-4"
              >
                <span className="text-sm text-muted">{stat.label}</span>
                <span className="font-display text-2xl font-semibold text-accent">
                  {stat.value}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
