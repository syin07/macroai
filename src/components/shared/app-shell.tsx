"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartLine, History, MessageCircle, Settings } from "lucide-react";
import { Brand } from "./brand";

const navigation = [
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/history", label: "History", icon: History },
  { href: "/insights", label: "Insights", icon: ChartLine },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function Navigation({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary navigation"
      className={mobile ? "app-mobile-nav md:hidden" : "mt-12"}
    >
      <ul
        className={
          mobile
            ? "mx-auto flex max-w-md items-center justify-between px-3"
            : "space-y-2"
        }
      >
        {navigation.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className={mobile ? "flex-1" : undefined}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={
                  mobile
                    ? "app-tab group flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium"
                    : "app-nav-link flex min-h-12 items-center gap-3 rounded-xl px-4 text-sm font-medium"
                }
              >
                <span
                  className={
                    mobile
                      ? "app-tab-icon flex h-7 w-12 items-center justify-center rounded-full"
                      : "flex h-5 w-5 items-center justify-center"
                  }
                >
                  <Icon
                    size={20}
                    strokeWidth={active ? 2 : 1.7}
                    aria-hidden="true"
                  />
                </span>
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell min-h-dvh">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="app-sidebar fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-[var(--app-line)] md:flex">
        <Brand />
        <Navigation />
      </aside>
      <div className="app-main-column">
        <main id="main-content" tabIndex={-1} className="focus:outline-none">
          {children}
        </main>
      </div>
      <Navigation mobile />
    </div>
  );
}
