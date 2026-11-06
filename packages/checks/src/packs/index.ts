import type { Platform } from "@mattertest/core";
import { bigcommercePack } from "./bigcommerce";
import type { PlatformPack } from "./types";

export * from "./types";
export { bigcommercePack, bigcommerceTemplate, stencilPageType } from "./bigcommerce";

/** Registered platform packs. Shopify, WordPress, Laravel and Next.js packs plug in here. */
export const PLATFORM_PACKS: Partial<Record<Platform, PlatformPack>> = {
  bigcommerce: bigcommercePack,
};

export function packFor(platform: Platform): PlatformPack | undefined {
  return PLATFORM_PACKS[platform];
}
