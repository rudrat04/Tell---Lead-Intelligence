import { fileURLToPath } from "node:url";
import { loadPackFromDir } from "./load.js";

/** Frozen copy of the example pack for tests, so editing a real pack can never break CI. */
export const FIXTURE_PACK_DIR = fileURLToPath(new URL("../fixtures/pack", import.meta.url));
export const loadFixturePack = () => loadPackFromDir(FIXTURE_PACK_DIR);
