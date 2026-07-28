/**
 * Knowledge files (training text for the PANDi chatbot) live in two places:
 *   - `apps/viewer/public/knowledge/<slug>.txt` — shipped with the build,
 *     editable in the repo. This is the canonical default content.
 *   - `MANIFEST_KV` under the `knowledge:<slug>` key — runtime overrides
 *     written by the `/ia` editor page. The chat function reads these
 *     first so client edits take effect without a redeploy.
 *
 * `getKnowledgeText` returns whichever is freshest, falling back to the
 * static asset on a KV miss. Slug is validated against an allow-list to
 * keep the KV namespace clean.
 */
export const KNOWLEDGE_KV_PREFIX = "knowledge:";

/**
 * Slugs are constrained to a–z, 0–9 and `-`. This excludes traversal
 * characters and keeps both the KV key space and the asset path safe.
 */
const SLUG_RE = /^[a-z0-9-]{1,40}$/;

export function isValidKnowledgeSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function knowledgeKvKey(slug: string): string {
  return `${KNOWLEDGE_KV_PREFIX}${slug}`;
}

export async function fetchKnowledgeAsset(
  assets: Fetcher,
  requestUrl: string,
  slug: string
): Promise<string | null> {
  const url = new URL(`/knowledge/${slug}.txt`, requestUrl);
  const res = await assets.fetch(url.toString());
  if (!res.ok) return null;
  return res.text();
}

export interface KnowledgeRecord {
  text: string;
  /** Where it came from — useful for the editor UI to show "overridden" state. */
  source: "kv" | "asset";
}

export async function getKnowledgeText(
  kv: KVNamespace,
  assets: Fetcher,
  requestUrl: string,
  slug: string
): Promise<KnowledgeRecord | null> {
  if (!isValidKnowledgeSlug(slug)) return null;
  const override = await kv.get(knowledgeKvKey(slug));
  if (override !== null) return { text: override, source: "kv" };
  const fallback = await fetchKnowledgeAsset(assets, requestUrl, slug);
  if (fallback === null) return null;
  return { text: fallback, source: "asset" };
}
