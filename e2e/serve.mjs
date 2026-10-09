// Serves the static export (out/) under /research-fact-base/, like GitHub Pages.
// Usage: node e2e/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const port = Number(process.argv[2] ?? 4173);
const base = process.env.NEXT_PUBLIC_BASE_PATH || "/research-fact-base";
const root = join(process.cwd(), "out");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  let rel = pathname.startsWith(`${base}/`) ? decodeURIComponent(pathname.slice(base.length)) : null;
  if (rel !== null && rel.endsWith("/")) rel += "index.html";
  const file = rel === null ? null : normalize(join(root, rel));
  if (file && file.startsWith(root + sep)) {
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      return res.end(data);
    } catch {
      // fall through to 404
    }
  }
  const notFound = await readFile(join(root, "404.html")).catch(() => "Not found");
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(notFound);
}).listen(port, () => console.log(`serving out/ at http://localhost:${port}${base}/`));
