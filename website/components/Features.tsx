import { LayoutGrid, Columns2, Bot, Send, Globe, Gauge } from "lucide-react";

type Feature = {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
};

const features: Feature[] = [
  {
    icon: LayoutGrid,
    title: "Multi-Project Sidebar",
    description:
      "Organize all your Git repositories in one place. Switch projects instantly — each with its own terminal sessions and state.",
  },
  {
    icon: Columns2,
    title: "Split Terminal Panes",
    description:
      "Run multiple terminals side by side. Resize, split vertically or horizontally. Each pane keeps its own shell session.",
  },
  {
    icon: Bot,
    title: "Live AI Agent Status",
    description:
      "See which projects have AI agents running in real time. Watch Claude work, know when it's done — no tab-switching needed.",
  },
  {
    icon: Send,
    title: "Built-in API Client",
    description:
      "Test HTTP endpoints directly inside the app. Save requests, inspect responses, replay with one click. No Postman needed.",
  },
  {
    icon: Globe,
    title: "Integrated Browser Tabs",
    description:
      "Open documentation, local dev servers, and web previews in native browser tabs right alongside your terminals.",
  },
  {
    icon: Gauge,
    title: "GPU & VRAM Monitor",
    description:
      "Track your discrete GPU usage and VRAM consumption at a glance. Know exactly what your hardware is doing.",
  },
];

export function Features() {
  return (
    <section id="features" className="scroll-mt-20 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">
            FEATURES
          </p>
          <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Everything you need.
            <br />
            Nothing you don&apos;t.
          </h2>
          <p className="mt-4 text-muted leading-relaxed">
            A single app that replaces your terminal multiplexer, API client,
            and project switcher.
          </p>
        </div>

        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="rounded-xl border border-line bg-card p-6 transition hover:border-line-2 hover:bg-card-2"
              >
                <div className="grid h-10 w-10 place-items-center rounded-lg bg-accent/10">
                  <Icon className="h-5 w-5 text-accent" />
                </div>
                <h3 className="mt-4 font-medium text-ink">{feature.title}</h3>
                <p className="mt-2 text-sm text-muted leading-relaxed">
                  {feature.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
