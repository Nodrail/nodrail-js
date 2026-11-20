// A search service of your own, to swap the handbook connection to:
//   SEARCH_SERVICE_TOKEN=<token> node search-service/server.mjs [port]
// It serves the same ../handbook folder over HTTP, as `nodrail connector
// http-search` expects: POST { collection, query, limit } with
// `Authorization: Bearer <token>`, answered with { matches: [{ source, text }] }.
// Each request adds a line to ../activity/service-reads.jsonl: the collection
// and the sources, never the question. Node's standard library only.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const token = process.env.SEARCH_SERVICE_TOKEN;
if (!token) {
  console.error("Set SEARCH_SERVICE_TOKEN first: the token clients must send.");
  process.exit(2);
}
const port = Number(process.argv[2] ?? 8091);
const words = (text) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);

function search(collection, query, limit) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(collection)) return [];
  let names = [];
  try {
    names = readdirSync(here(`../handbook/${collection}`));
  } catch {
    return [];
  }
  const wanted = words(query);
  const found = [];
  for (const name of names.filter((each) => /\.(md|txt)$/.test(each)))
    for (const paragraph of readFileSync(here(`../handbook/${collection}/${name}`), "utf8").split(/\n\s*\n/)) {
      const score = [...words(paragraph)].filter((word) => wanted.has(word)).length;
      if (score > 0) found.push({ score, source: name.replace(/\.(md|txt)$/, ""), text: paragraph.trim() });
    }
  return found.sort((a, b) => b.score - a.score).slice(0, limit).map(({ source, text }) => ({ source, text }));
}

createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/search") return response.writeHead(404).end();
  if (request.headers.authorization !== `Bearer ${token}`) return response.writeHead(401).end();
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    let input;
    try {
      input = JSON.parse(body);
    } catch {
      return response.writeHead(400).end();
    }
    const matches = search(String(input.collection), String(input.query), Math.min(Number(input.limit) || 5, 20));
    appendFileSync(here("../activity/service-reads.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), collection: input.collection, sources: matches.map((match) => match.source) })}\n`);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ matches }));
  });
}).listen(port, "127.0.0.1", () => console.error(`Search service on http://127.0.0.1:${port}/search`));
