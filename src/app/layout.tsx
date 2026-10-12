import type { Metadata } from "next";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research Fact Base — Legal Research",
  description:
    "Grounded legal research: answers drawn only from your own documents, with every citation and quote checked before you see them.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The theme script sets class="dark" before React loads, hence suppressHydrationWarning.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
