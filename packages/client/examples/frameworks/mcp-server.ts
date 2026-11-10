// An existing MCP server, with Nodrail added: the two marked lines.
import { guardMcpServer } from "@nodrail/client"; // 1. import
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// 2. guard the server before registering tools.
export const server = guardMcpServer(
  new McpServer({ name: "github", version: "1.0.0" }),
);

server.registerTool(
  "delete_repo",
  { description: "Delete a repository", inputSchema: { repo: z.string() } },
  async ({ repo }) => ({
    content: [{ type: "text", text: `Deleted ${repo}` }],
  }),
);
