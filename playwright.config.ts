import { defineConfig, devices } from "@playwright/test";

// Browser tests of the built site (run `npm run build` first, with the same
// NEXT_PUBLIC_* values as the deploy). See e2e/fakes.ts for what's simulated.
const PORT = 4173;
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "/research-fact-base";

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}${BASE_PATH}/`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `node e2e/serve.mjs ${PORT}`,
    url: `http://localhost:${PORT}${BASE_PATH}/`,
    reuseExistingServer: !process.env.CI,
  },
});
