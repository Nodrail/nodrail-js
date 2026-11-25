// cross-spawn uses Node's spawn options and overloads.
export const spawn: typeof import("node:child_process").spawn;
export const spawnSync: typeof import("node:child_process").spawnSync;
