import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  // Project ref is an identifier, not a secret (all access needs an auth token).
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_rrjpslhcgzocozamwtcu",
  dirs: ["./trigger"],
  maxDuration: 300,
  // Production loads the private pack from R2 (TELL_PACK_R2_PREFIX); the example pack ships as a fallback for dev.
  build: { extensions: [additionalFiles({ files: ["./packs/example-gtm/**"] })] },
});
