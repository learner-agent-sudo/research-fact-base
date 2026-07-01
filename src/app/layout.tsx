import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research Fact Base — Legal Research",
  description:
    "Grounded, verified legal research: answers drawn only from your documents and the web, checked before you see them.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
