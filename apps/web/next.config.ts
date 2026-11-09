import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@mattertest/core", "@mattertest/db", "@mattertest/report", "@mattertest/checks"],
  serverExternalPackages: ["pg", "bullmq", "ioredis", "playwright", "playwright-core"],
  // Source uploads (PDF, DOCX, transcripts) go through a server action; allow up to MAX_UPLOAD_BYTES plus form overhead.
  experimental: {
    serverActions: { bodySizeLimit: "26mb" },
    proxyClientMaxBodySize: "26mb",
  },
};

export default config;
