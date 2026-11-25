const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Canonical origin for sending control-plane credentials and binding local state. */
export function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    if (!/^https?:\/\//i.test(value)) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" is not a URL.`);
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      `Use a Nodrail origin without a path or sign-in details (${url.origin}).`,
    );
  if (url.protocol === "http:" && !loopback.has(url.hostname))
    throw new Error(
      `Nodrail must be reached over https (${url.origin}); only localhost may use http.`,
    );
  return url.origin;
}
