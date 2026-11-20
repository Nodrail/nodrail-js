import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "./mcp-stdio.ts";

const CHANNEL = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A tool with an effect you can count: `publish` writes the text to a new
 * file in `<folder>/<channel>/`, one per publication. A publication the
 * policy denies, or holds for a person, never gets here, so the files in
 * the folder are the publications that happened, whatever an agent says.
 */
export function outboxTool(folder: string): Tool {
  let sequence = 0;
  return {
    name: "publish",
    description:
      "Publish a text to a channel, such as blog or newsletter. Each call publishes once.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Where to publish." },
        text: { type: "string", description: "What to publish." },
      },
      required: ["channel", "text"],
      additionalProperties: false,
    },
    call: async ({ channel, text }) => {
      if (typeof channel !== "string" || !CHANNEL.test(channel))
        return {
          text: "channel must be letters, digits, - or _",
          isError: true,
        };
      if (
        typeof text !== "string" ||
        text.trim() === "" ||
        text.length > 20_000
      )
        return {
          text: "text must be text, up to 20000 characters",
          isError: true,
        };
      mkdirSync(join(folder, channel), { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${++sequence}.md`;
      writeFileSync(join(folder, channel, name), `${text}\n`, { flag: "wx" });
      return { text: JSON.stringify({ published: `${channel}/${name}` }) };
    },
  };
}
