import type { NextConfig } from "next";

/**
 * The browser talks to Next.js, Next proxies /api/* to the FastAPI backend.
 * Override the target with BACKEND_URL when the API runs elsewhere.
 */
const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:8080";

/**
 * `next dev` and `next build` must never share a build directory: a production
 * build rewrites the server chunks that a running dev server still holds in
 * memory, which surfaces as `Cannot find module './NNN.js'`.
 *
 * So `npm run dev` uses `.next`, while `npm run build` / `npm start` use
 * `.next-build`. Either can be overridden with NEXT_DIST_DIR. On Vercel the
 * build always uses the default `.next`, because the platform's Next.js
 * preset expects it.
 */
const onVercel = process.env.VERCEL === "1";
const lifecycle = process.env.npm_lifecycle_event;
const isProductionCommand = lifecycle === "build" || lifecycle === "start";
const distDir = onVercel
  ? ".next"
  : process.env.NEXT_DIST_DIR ?? (isProductionCommand ? ".next-build" : ".next");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default nextConfig;
