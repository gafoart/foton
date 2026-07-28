/**
 * Server-renders the SPA shell with the live manifest inlined as
 * <script id="manifest-data" type="application/json">…</script>. Saves the
 * client one full round-trip (HTML → parse JS → fetch /api/manifest →
 * parse JSON) — the manifest is parseable the moment the bundle runs.
 *
 * Falls back to serving the static index.html unchanged if KV is empty.
 */
type Env = {
  MANIFEST_KV: KVNamespace;
  ASSETS: Fetcher;
};

const KV_KEY = "manifest";

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const indexUrl = new URL("/index.html", request.url).toString();

  const [htmlRes, manifestStr] = await Promise.all([
    env.ASSETS.fetch(indexUrl),
    env.MANIFEST_KV.get(KV_KEY),
  ]);

  // If the static fetch fails for any reason, just pass it through.
  if (!htmlRes.ok) return htmlRes;
  const html = await htmlRes.text();

  let body = html;
  if (manifestStr) {
    /**
     * Escape `</script>` inside the JSON so the closing tag of any string
     * value can't terminate the surrounding <script>. Replacing inside the
     * string preserves byte-for-byte JSON validity.
     */
    const safe = manifestStr.replace(/<\/script/gi, "<\\/script");
    const inject = `<script id="manifest-data" type="application/json">${safe}</script>`;
    if (html.includes("</head>")) {
      body = html.replace("</head>", `${inject}</head>`);
    } else {
      body = inject + html;
    }
  }

  /**
   * Headers mirror what Cloudflare Pages serves for the static index.html
   * (must-revalidate so manifest updates propagate on next reload) plus the
   * COOP/COEP pair from `_headers` — `_headers` does NOT apply to responses
   * from Pages Functions, so we set them explicitly here.
   */
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, must-revalidate, max-age=0",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    },
  });
};
