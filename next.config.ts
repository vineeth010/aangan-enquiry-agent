import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (local-only DB) is loaded dynamically and must not be bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
