import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Browser-level smoke over the deployed portal (E2E_BASE_URL overrides;
// default: production). These catch what app.fetch never can: CSP,
// layout, prerendering, and the rendered document itself.
export default defineConfig({
  testDir: path.join(fileURLToPath(import.meta.url), ".."),
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://cla.ribose.com",
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
