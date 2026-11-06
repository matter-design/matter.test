import type { Platform } from "@mattertest/core";
import { bigcommercePack } from "./bigcommerce";
import { shopifyPack } from "./shopify";
import type { PlatformPack } from "./types";

export * from "./types";
export { bigcommercePack, bigcommerceTemplate, stencilPageType } from "./bigcommerce";
export { shopifyPack, shopifyPageType, shopifyTemplate } from "./shopify";

/** Registered platform packs. WordPress, Laravel and Next.js packs plug in here. */
export const PLATFORM_PACKS: Partial<Record<Platform, PlatformPack>> = {
  bigcommerce: bigcommercePack,
  shopify: shopifyPack,
};

export function packFor(platform: Platform): PlatformPack | undefined {
  return PLATFORM_PACKS[platform];
}
