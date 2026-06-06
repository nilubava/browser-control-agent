import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright", "playwright-core"],
  experimental: {
    // Playwright needs Node.js APIs unavailable in the Edge runtime
  },
};

export default nextConfig;
