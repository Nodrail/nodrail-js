// cross-spawn's async API has Node's spawn options and stdio overloads.
export const spawn: typeof import("node:child_process").spawn;
