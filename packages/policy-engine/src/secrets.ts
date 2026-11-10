/**
 * Where credentials usually live, by file or folder name. The starter packs
 * deny reading and searching these, and a command or search pattern that names
 * one is never judged as a simple, harmless call.
 */
export const SECRET_PLACES = [
  ".env",
  ".envrc",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  "gcloud",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".pgpass",
  ".vault-token",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
] as const;

const secretSet = new Set<string>(SECRET_PLACES);

/**
 * The names a path part answers to: itself, and for a dot file with a suffix,
 * its base too, so .env.staging and .env.local also count as .env.
 */
export function nameForms(part: string): string[] {
  const second = part.startsWith(".") ? part.indexOf(".", 1) : -1;
  return second > 1 ? [part, part.slice(0, second)] : [part];
}

export const isSecretName = (part: string) =>
  nameForms(part).some((form) => secretSet.has(form));

const MAX_GLOB = 256;
const MAX_ALTERNATIVES = 64;

/** {a,b}c → [ac, bc]. Null when there would be too many to check. */
function expandBraces(pattern: string): string[] | null {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open);
  if (close < 0) return [pattern];
  const inner = pattern.slice(open + 1, close);
  if (inner.includes("{")) return null;
  const results: string[] = [];
  for (const choice of inner.split(",")) {
    const rest = expandBraces(
      pattern.slice(0, open) + choice + pattern.slice(close + 1),
    );
    if (!rest) return null;
    results.push(...rest);
    if (results.length > MAX_ALTERNATIVES) return null;
  }
  return results;
}

type Token = { any: true } | { one: true } | { set: string; negate: boolean } | { char: string };

function tokens(pattern: string): Token[] {
  const result: Token[] = [];
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at] ?? "";
    if (char === "*") {
      if (!("any" in (result.at(-1) ?? {}))) result.push({ any: true });
    } else if (char === "?") result.push({ one: true });
    else if (char === "[") {
      const end = pattern.indexOf("]", at + 2);
      if (end < 0) result.push({ char });
      else {
        const body = pattern.slice(at + 1, end);
        const negate = body.startsWith("!") || body.startsWith("^");
        result.push({ set: negate ? body.slice(1) : body, negate });
        at = end;
      }
    } else result.push({ char });
  }
  return result;
}

function inSet(set: string, char: string) {
  for (let at = 0; at < set.length; at += 1) {
    const low = set[at] ?? "";
    if (set[at + 1] === "-" && at + 2 < set.length) {
      const high = set[at + 2] ?? "";
      if (char >= low && char <= high) return true;
      at += 2;
    } else if (char === low) return true;
  }
  return false;
}

/** Glob matching for one path part, in time proportional to both lengths. */
function matchesPart(pattern: Token[], name: string) {
  let row = Array.from({ length: name.length + 1 }, () => false);
  row[0] = true;
  for (const token of pattern) {
    const next = Array.from({ length: name.length + 1 }, () => false);
    if ("any" in token) {
      next[0] = row[0] ?? false;
      for (let at = 1; at <= name.length; at += 1)
        next[at] = (row[at] ?? false) || (next[at - 1] ?? false);
    } else
      for (let at = 1; at <= name.length; at += 1) {
        const char = name[at - 1] ?? "";
        const fits =
          "one" in token ||
          ("set" in token && inSet(token.set, char) !== token.negate) ||
          ("char" in token && token.char === char);
        next[at] = fits && (row[at - 1] ?? false);
      }
    row = next;
  }
  return row[name.length] ?? false;
}

/** Examples of each place, including suffixed forms such as .env.local. */
const secretExamples = SECRET_PLACES.flatMap((place) =>
  place.startsWith(".") ? [place, `${place}.local`] : [place],
);

/**
 * Whether a file pattern could pick out a place where credentials live: a part
 * that names one, or a wildcard part that one would match, such as .env*,
 * *env or {.env,x}. A bare ** walks folders without picking any by name.
 * Anything too complex to check counts as reaching one.
 */
export function globCouldReachSecret(glob: string) {
  if (glob.length > MAX_GLOB) return true;
  const alternatives = expandBraces(glob);
  if (!alternatives) return true;
  return alternatives.some((alternative) =>
    alternative
      .split(/[\\/]/)
      .filter(Boolean)
      .some((part) => {
        // ** walks folders but picks none out by name; the other parts decide.
        if (part === "**") return false;
        if (!/[*?[]/.test(part)) return isSecretName(part);
        const pattern = tokens(part);
        return secretExamples.some((name) => matchesPart(pattern, name));
      }),
  );
}
