import type { ArticleEvidenceRef, MarxAgentReply, MarxArticle } from "../schemas";
import type { MoltbookPost } from "../orchestrator/contracts";

export type RelatedMoltbookPost = {
  post: MoltbookPost;
  score: number;
  matchedTerms: string[];
};

function terms(value: string): Set<string> {
  const stopWords = new Set(["the", "and", "for", "with", "from", "this", "that", "one", "than", "said", "may", "are", "was", "were", "have", "has", "not", "but", "they", "their", "into", "while", "what", "would", "will", "more", "only", "over", "under", "about", "also", "just", "its", "our", "your", "how", "why", "all", "can", "could", "should"]);
  return new Set((value.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((term) => !stopWords.has(term)));
}

export function buildArticleSearchQueries(article: MarxArticle): string[] {
  const queries = [
    "Fed Chair Kevin Warsh inflation interest rate hike",
    "Warsh rate hike DeFi yield",
    "FedWatch September 16 rate hike",
    "Warsh Jackson Hole Fed rate hike",
    "PCE inflation September Fed decision",
    "Treasury yields policy repricing growth inflation",
    `${article.title} ${article.topics.slice(0, 3).join(" ")}`,
  ];
  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function chooseMarxEvidence(article: MarxArticle, post: MoltbookPost): ArticleEvidenceRef | undefined {
  const postTerms = terms(post.content);
  const ranked = [...article.agentReplies].sort((left, right) => {
    const leftScore = [...terms(left.body)].filter((term) => postTerms.has(term)).length;
    const rightScore = [...terms(right.body)].filter((term) => postTerms.has(term)).length;
    return rightScore - leftScore || left.agentName.localeCompare(right.agentName);
  });
  const reply: MarxAgentReply | undefined = ranked[0];
  if (!reply || article.evidenceStatus === "unavailable") return undefined;
  return {
    articleId: article.articleId,
    articleUrl: article.sourceUrl,
    replyId: reply.replyId,
    agentId: reply.agentId,
    agentName: reply.agentName,
    quote: reply.quote,
    quoteUrl: reply.sourceUrl,
    evidenceStatus: article.evidenceStatus === "complete" ? "complete" : "partial",
  };
}

export function rankRelatedPosts(article: MarxArticle, posts: MoltbookPost[]): RelatedMoltbookPost[] {
  const sourceTerms = terms(`${article.title} ${article.body} ${article.topics.join(" ")} ${article.tickers.join(" ")}`);
  return posts
    .map((post) => {
      const postTerms = terms(`${post.content} ${post.submolt}`);
      const matchedTerms = [...postTerms].filter((term) => sourceTerms.has(term));
      const topicBoost = /finance|trading|economics|markets|science/i.test(post.submolt) ? 0.14 : 0;
      const directHits = (post.content.match(/warsh|federal reserve|inflation|interest rate|rate hike|pce|treasury|yield|fomc|fedwatch/gi) ?? []).length;
      const directBoost = Math.min(0.45, directHits * 0.1);
      const score = Math.min(1, matchedTerms.length / 20 + topicBoost + directBoost);
      return { post, score, matchedTerms: matchedTerms.slice(0, 12), directHits };
    })
    .filter((item) => item.score >= 0.2 && item.directHits > 0)
    .sort((left, right) => right.score - left.score || left.post.postId.localeCompare(right.post.postId));
}

export function annotateRelatedPost(post: MoltbookPost, article: MarxArticle, evidence?: ArticleEvidenceRef, options: { includeAgentQuotes?: boolean } = {}): MoltbookPost {
  return {
    ...post,
    metadata: {
      ...(post.metadata ?? {}),
      articleContext: {
        articleId: article.articleId,
        title: article.title,
        sourceUrl: article.sourceUrl,
        topics: article.topics,
        tickers: article.tickers,
        evidenceStatus: article.evidenceStatus,
        quoteMode: options.includeAgentQuotes === false ? "disabled" : "enabled",
      },
      ...(evidence ? { marxEvidence: evidence } : {}),
    },
  };
}
