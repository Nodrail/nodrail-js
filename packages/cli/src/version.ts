import manifest from "../package.json" with { type: "json" };

/** Follow the package version selected by the release PR. */
export const VERSION = manifest.version;
