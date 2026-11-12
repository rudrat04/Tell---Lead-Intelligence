import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  // Project ref is an identifier, not a secret (all access needs an auth token).
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_rrjpslhcgzocozamwtcu",
  dirs: ["./trigger"],
  maxDuration: 300,
  // Tasks read YAML config at runtime; ship it with the bundle at the same relative path.
  build: { extensions: [additionalFiles({ files: ["./config/**"] })] },
});
