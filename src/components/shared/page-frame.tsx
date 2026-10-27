import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowUpRight } from "lucide-react";
import { Brand } from "./brand";

export function PageFrame({
  title,
  description,
  action,
  chat = false,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  chat?: boolean;
  children: React.ReactNode;
}) {
  const width = chat ? "max-w-2xl" : "max-w-3xl";
  return (
    <>
      <header className="app-header border-b border-[var(--app-line)]">
        <div
          className={`mx-auto flex min-h-20 items-center justify-between gap-4 px-5 sm:px-8 ${width}`}
        >
          <Brand />
          {action && <div className="shrink-0">{action}</div>}
        </div>
      </header>
      <div className={`mx-auto px-5 pb-12 pt-8 sm:px-8 sm:pt-10 ${width}`}>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.045em]">
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        )}
        {children}
      </div>
    </>
  );
}

export function HeaderLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="app-text-link inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-medium"
    >
      {children}
      <ArrowUpRight size={14} aria-hidden="true" />
    </Link>
  );
}

export function EmptyPanel({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="mt-8 flex min-h-72 flex-col items-center justify-center rounded-2xl border border-[var(--app-line)] bg-[var(--app-surface)] px-6 py-12 text-center sm:min-h-80">
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--app-accent-soft)] text-[var(--app-accent)]">
        <Icon size={23} strokeWidth={1.6} aria-hidden="true" />
      </div>
      <h2 className="text-base font-medium tracking-tight">{title}</h2>
      <p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </section>
  );
}
