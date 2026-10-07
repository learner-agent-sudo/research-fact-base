/**
 * Static export for GitHub Pages. The site is purely client-side: document
 * search, the AI models and the grounding checks all run in the `research-api`
 * Supabase Edge Function (supabase/functions/research-api).
 *
 * NEXT_PUBLIC_BASE_PATH is the repository path on github.io, e.g.
 * "/research-fact-base". Leave it empty for local development.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
