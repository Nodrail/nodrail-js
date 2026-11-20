import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { extname, join, sep } from "node:path";
import type { Tool, ToolAnswer } from "./mcp-stdio.ts";

/**
 * The search contract both of Nodrail's search connectors keep: one tool,
 * `search`, that takes a collection and a query and gives back passages
 * with the source each came from. Which implementation runs is a matter of
 * the connection's command line: roles and rules don't change.
 */
export type Match = { collection: string; source: string; text: string };

/** Where passages come from: a search service, or a folder of documents. */
export type Backend = (request: {
  collection: string;
  query: string;
  limit: number;
}) => Promise<Match[]>;

/** A failure the person can act on; never holds a secret. */
export class SearchError extends Error {}

const COLLECTION = /^[A-Za-z0-9_-]{1,64}$/;

export const SEARCH_INPUT = {
  type: "object",
  properties: {
    collection: {
      type: "string",
      description: "The collection to search, such as public or internal.",
    },
    query: { type: "string", description: "What to look for." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "How many passages at most; 5 when left out.",
    },
  },
  required: ["collection", "query"],
  additionalProperties: false,
};

const failed = (text: string): ToolAnswer => ({ text, isError: true });

/** The `search` tool over a backend, with its input checked first. */
export function searchTool(backend: Backend): Tool {
  return {
    name: "search",
    description:
      "Search one named collection and return passages with the source each came from.",
    inputSchema: SEARCH_INPUT,
    call: async ({ collection, query, limit }) => {
      if (typeof collection !== "string" || !COLLECTION.test(collection))
        return failed("collection must be letters, digits, - or _");
      if (
        typeof query !== "string" ||
        query.trim() === "" ||
        query.length > 1000
      )
        return failed("query must be text, up to 1000 characters");
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 20)
      )
        return failed("limit must be a whole number from 1 to 20");
      try {
        const matches = await backend({ collection, query, limit: limit ?? 5 });
        return { text: JSON.stringify({ matches }) };
      } catch (error) {
        if (error instanceof SearchError) return failed(error.message);
        throw error;
      }
    },
  };
}

const SEARCH_TIMEOUT = 10_000;

/**
 * A search service over HTTP: POST `{ collection, query, limit }` to the
 * endpoint, with `Authorization: Bearer <SEARCH_TOKEN>` when that is set,
 * and read `{ matches: [{ source, text }] }` back.
 */
export function httpBackend(
  endpoint: string,
  token: string | undefined,
  send: typeof fetch = fetch,
): Backend {
  return async ({ collection, query, limit }) => {
    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ collection, query, limit }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT),
      });
    } catch {
      throw new SearchError("the search service can't be reached");
    }
    if (!response.ok)
      throw new SearchError(`the search service answered ${response.status}`);
    let body: { matches?: unknown };
    try {
      body = (await response.json()) as { matches?: unknown };
    } catch {
      throw new SearchError(
        "the search service answered something that isn't JSON",
      );
    }
    if (!Array.isArray(body.matches))
      throw new SearchError("the search service's answer has no matches");
    return body.matches.slice(0, limit).flatMap((match: unknown) => {
      const { source, text } = (match ?? {}) as {
        source?: unknown;
        text?: unknown;
      };
      return typeof source === "string" && typeof text === "string"
        ? [{ collection, source, text }]
        : [];
    });
  };
}

const DOCUMENT = new Set([".md", ".txt"]);
const PASSAGE = 1000;

const words = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);

/**
 * A folder of documents, one subfolder per collection: `<folder>/<collection>/
 * <source>.md`. Passages are paragraphs, ranked by how many of the query's
 * words they hold. With a `receipts` folder, each search adds a line to its
 * reads.jsonl naming the
 * collection and the sources it returned, never the query: a count of
 * reads that holds no content.
 */
export function filesBackend(folder: string, receipts?: string): Backend {
  // A folder, so the log is data the project holds, never a file it locks.
  const log = receipts ? join(receipts, "reads.jsonl") : undefined;
  return async ({ collection, query, limit }) => {
    const inside = realpathSync(folder);
    let names: string[];
    try {
      names = readdirSync(join(inside, collection));
    } catch {
      throw new SearchError(`there is no collection ${collection}`);
    }
    const wanted = words(query);
    const scored: (Match & { score: number })[] = [];
    for (const name of names
      .filter((each) => DOCUMENT.has(extname(each)))
      .sort()) {
      const path = realpathSync(join(inside, collection, name));
      // A link out of the folder is skipped, not followed.
      if (!path.startsWith(`${inside}${sep}`)) continue;
      const source = name.slice(0, -extname(name).length);
      for (const paragraph of readFileSync(path, "utf8").split(/\n\s*\n/)) {
        const text = paragraph.trim();
        const found = [...words(text)].filter((word) =>
          wanted.has(word),
        ).length;
        if (found > 0)
          scored.push({
            collection,
            source,
            text: text.slice(0, PASSAGE),
            score: found,
          });
      }
    }
    const matches = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ collection: found, source, text }) => ({
        collection: found,
        source,
        text,
      }));
    if (log) {
      mkdirSync(receipts!, { recursive: true });
      appendFileSync(
        log,
        `${JSON.stringify({ at: new Date().toISOString(), collection, sources: matches.map((match) => match.source) })}\n`,
      );
    }
    return matches;
  };
}
