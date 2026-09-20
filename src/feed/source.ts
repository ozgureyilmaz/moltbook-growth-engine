import { z } from "zod";

export const FeedItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  createdAt: z.string().datetime({ offset: true }),
});
export type FeedItem = z.infer<typeof FeedItemSchema>;
const PageSchema = z.object({
  data: z.array(FeedItemSchema),
  pagination: z.object({
    page: z.number().int().positive(), limit: z.number().int().positive(),
    total: z.number().int().nonnegative(), pages: z.number().int().nonnegative(),
  }),
});
export const FeedConfigSchema = z.object({
  config_version: z.literal(1),
  first_run: z.enum(["baseline", "latest"]),
  max_pages: z.number().int().min(1).max(100),
  request_timeout_ms: z.number().int().min(100).max(120000),
  max_response_bytes: z.number().int().min(1000).max(10000000),
}).strict();
export type FeedConfig = z.infer<typeof FeedConfigSchema>;

/** Public read adapter: no keys, redirects, model instructions, or publisher access. */
export async function fetchMarxFeed(config: FeedConfig, fetcher: typeof fetch = fetch): Promise<FeedItem[]> {
  const items = new Map<string, FeedItem>();
  let expected: { total: number; pages: number; limit: number } | undefined;
  for (let page = 1; page <= config.max_pages; page += 1) {
    const response = await fetcher(`https://marx.finance/api/posts?sort=new&page=${page}`, {
      redirect: "error", signal: AbortSignal.timeout(config.request_timeout_ms),
      headers: { Accept: "application/json", "User-Agent": "marx-moltbook-growth-engine/0.2" },
    });
    if (!response.ok) throw new Error(`Marx feed read failed: HTTP ${response.status}`);
    if (!response.body) throw new Error("Marx feed response has no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > config.max_response_bytes) throw new Error("Marx feed response exceeds byte limit");
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const parsed = PageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
    const meta = parsed.pagination;
    if (meta.page !== page || meta.pages > config.max_pages) throw new Error("Marx feed pagination incomplete or exceeds max_pages");
    if (parsed.data.length > meta.limit || (meta.total > 0 && meta.pages !== Math.ceil(meta.total / meta.limit)) || (meta.total === 0 && (meta.pages > 1 || parsed.data.length !== 0))) {
      throw new Error("Marx feed pagination metadata is inconsistent");
    }
    expected ??= meta;
    if (meta.total !== expected.total || meta.pages !== expected.pages || meta.limit !== expected.limit) {
      throw new Error("Marx feed changed during pagination; retry on the next poll");
    }
    for (const item of parsed.data) {
      if (items.has(item.id)) throw new Error("Marx feed pagination contains duplicate IDs");
      items.set(item.id, item);
    }
    if (page >= meta.pages) {
      if (items.size !== meta.total) throw new Error("Marx feed pagination count mismatch");
      return [...items.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    }
    if (parsed.data.length === 0) throw new Error("Marx feed pagination returned an empty intermediate page");
  }
  throw new Error("Marx feed pagination incomplete");
}
