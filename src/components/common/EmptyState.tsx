import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  desc,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {Icon && <Icon size={32} className="mb-1 text-fg-dim" strokeWidth={1.5} />}
      <div className="font-medium text-fg-muted">{title}</div>
      {desc && <div className="max-w-80 text-xs leading-5 text-fg-dim">{desc}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
