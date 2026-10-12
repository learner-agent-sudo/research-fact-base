"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useChat } from "@/lib/chatStore";

export type Page = "ask" | "documents" | "settings";

const NAV: { page: Page; href: string; label: string }[] = [
  { page: "ask", href: "/", label: "Ask" },
  { page: "documents", href: "/documents/", label: "Documents" },
  { page: "settings", href: "/settings/", label: "Settings" },
];

/** Top bar shared by every page. `children` adds page-specific controls on the right. */
export default function AppHeader({ active, children }: { active: Page; children?: ReactNode }) {
  const { busy } = useChat();
  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <Link href="/" className="text-sm font-semibold">
          Research Fact Base
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 text-sm">
          {NAV.map((n) => (
            <Link
              key={n.page}
              href={n.href}
              aria-current={active === n.page ? "page" : undefined}
              className={`relative rounded-md px-2.5 py-1 ${
                active === n.page ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-500 hover:text-neutral-800"
              }`}
            >
              {n.label}
              {n.page === "ask" && busy && active !== "ask" && (
                <span
                  title="An answer is being prepared"
                  className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-blue-600"
                />
              )}
            </Link>
          ))}
        </nav>
        {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}
