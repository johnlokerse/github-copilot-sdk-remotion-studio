import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "esbuild",
    "@github/copilot-sdk",
    "@github/copilot",
    "vscode-jsonrpc"
  ],
  experimental: {
    staleTimes: {
      dynamic: 0,
      static: 0
    }
  }
};

export default nextConfig;
