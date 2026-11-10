// An existing MCP server, with Nodrail added: the two marked lines.
import { guard } from "@nodrail/client"; // 1. import
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "github", version: "1.0.0" });

// 2. guard what registerTool returns, keyed by the tool's name.
guard({
  delete_repo: server.registerTool(
    "delete_repo",
    { description: "Delete a repository", inputSchema: { repo: z.string() } },
    async ({ repo }) => ({ content: [{ type: "text", text: `Deleted ${repo}` }] }),
  ),
});

export { server };
