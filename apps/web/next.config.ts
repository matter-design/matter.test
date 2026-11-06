import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@mattertest/core", "@mattertest/db", "@mattertest/report", "@mattertest/checks"],
  serverExternalPackages: ["pg", "bullmq", "ioredis", "playwright", "playwright-core"],
};

export default config;
