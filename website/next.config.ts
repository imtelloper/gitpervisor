import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app is an independent package nested in the gitpervisor repo.
  // Pin the workspace root so Next doesn't pick the parent repo's lockfile.
  turbopack: { root: __dirname },
};

export default nextConfig;
