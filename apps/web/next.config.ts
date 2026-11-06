import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@mattertest/core", "@mattertest/db"],
  serverExternalPackages: ["pg", "bullmq", "ioredis"],
};

export default config;
