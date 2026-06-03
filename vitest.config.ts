import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Tests drive a real HyperSync data-source, which requires ENVIO_API_TOKEN.
// vitest does not read .env into process.env automatically, so load it here.
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    // Run test files sequentially: HyperSync rate-limits/times out when 8 test
    // files open concurrent sessions, which surfaced as 30s timeouts.
    fileParallelism: false,
  },
});
