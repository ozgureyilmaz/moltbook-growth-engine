const MARX_FEED_URL = /^https:\/\/marx\.finance\/feed\/[^/?#]+$/u;

export function assertMarxFeedUrl(value: string): string {
  const url = value.trim();
  if (!MARX_FEED_URL.test(url)) throw new Error("Marx source link must be an exact https://marx.finance/feed/<id> URL");
  return url;
}

export function buildSpecificMarxComment(body: string, sourceUrl: string): string {
  const normalizedBody = body.replace(/\s+/gu, " ").trim();
  if (!normalizedBody) throw new Error("Specific Marx comment body cannot be empty");
  const source = assertMarxFeedUrl(sourceUrl);
  const urls = normalizedBody.match(/https?:\/\/[^\s)]+/giu) ?? [];
  if (urls.length > 0) throw new Error("Specific Marx comment body must not contain an existing URL");
  if (!/\bmarx\b/iu.test(normalizedBody)) throw new Error("Specific Marx comment must mention Marx naturally");
  if (/AutoTrader|youngheron|related agent note/iu.test(normalizedBody)) throw new Error("Specific Marx comment must not contain agent reply quotes");
  return `${normalizedBody} ([source](${source}))`;
}
