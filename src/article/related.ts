import type { ArticleEvidenceRef, MarxAgentReply, MarxArticle } from "../schemas";
import type { MoltbookPost } from "../orchestrator/contracts";
import { extractArticleTerms } from "./source";

export type RelatedMoltbookPost = {
  post: MoltbookPost;
  score: number;
  matchedTerms: string[];
};

function terms(value: string): Set<string> {
  return new Set(extractArticleTerms(value));
}

const GENERIC_MATCH_TERMS = new Set([
  "agreement", "security", "control", "permanent", "president", "international", "global", "geopolitical", "market", "markets", "economic", "economy", "finance", "trading", "inflation", "interest", "rate", "rates", "yield", "treasury", "policy", "growth", "data", "risk", "risks", "energy", "oil", "world", "government", "official", "officials", "news", "report", "brief", "force", "presence", "base", "statement", "statements", "administration", "american", "announced", "announces", "gives", "take", "military", "defense", "europe", "north", "atlantic", "strategic", "national", "war", "move", "member", "general", "russia", "china", "beijing",
]);

function isStrongAnchor(term: string): boolean {
  return term.length >= 6 && !GENERIC_MATCH_TERMS.has(term);
}

export function buildArticleSearchQueries(article: MarxArticle): string[] {
  const topics = article.topics.filter(Boolean);
  const anchorTopics = topics.slice(4, 8);
  const anchorPairs = anchorTopics.slice(0, -1).map((topic, index) => `${topic} ${anchorTopics[index + 1]}`);
  const queries = [
    article.title,
    topics.slice(0, 4).join(" "),
    topics.slice(4, 8).join(" "),
    `${article.title} ${topics.slice(0, 2).join(" ")}`,
    ...anchorPairs,
  ];
  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function chooseMarxEvidence(article: MarxArticle, post: MoltbookPost): ArticleEvidenceRef | undefined {
  if (rankRelatedPosts(article, [post]).length === 0) return undefined;
  const postTerms = terms(post.content);
  const articleTerms = terms(`${article.title} ${article.topics.join(" ")}`);
  const ranked = [...article.agentReplies].sort((left, right) => {
    const leftScore = [...terms(left.body)].filter((term) => postTerms.has(term) && articleTerms.has(term)).length;
    const rightScore = [...terms(right.body)].filter((term) => postTerms.has(term) && articleTerms.has(term)).length;
    return rightScore - leftScore || left.agentName.localeCompare(right.agentName);
  });
  const reply: MarxAgentReply | undefined = ranked.find((candidate) => {
    const overlap = [...terms(candidate.body)].filter((term) => postTerms.has(term) && articleTerms.has(term));
    return overlap.length >= 2 || overlap.some(isStrongAnchor);
  });
  if (!reply || article.evidenceStatus === "unavailable") return undefined;
  return {
    articleId: article.articleId,
    articleUrl: article.sourceUrl,
    replyId: reply.replyId,
    agentId: reply.agentId,
    agentName: reply.agentName,
    ...(reply.quote ? { quote: reply.quote } : {}),
    quoteUrl: reply.sourceUrl,
    evidenceStatus: article.evidenceStatus === "complete" ? "complete" : "partial",
  };
}

export function rankRelatedPosts(article: MarxArticle, posts: MoltbookPost[]): RelatedMoltbookPost[] {
  const sourceTerms = terms(`${article.title} ${article.body} ${article.topics.join(" ")} ${article.tickers.join(" ")}`);
  const titleTerms = terms(article.title);
  return posts
    .map((post) => {
      const postTerms = terms(`${post.content} ${post.submolt}`);
      const matchedTerms = [...postTerms].filter((term) => sourceTerms.has(term));
      const titleHits = matchedTerms.filter((term) => titleTerms.has(term));
      const articleAnchors = new Set([...terms(`${article.title} ${article.topics.join(" ")}`)].filter(isStrongAnchor));
      const score = Math.min(1, matchedTerms.length / 12 + titleHits.length * 0.15);
      const hasDirectTopicAnchor = matchedTerms.some((term) => articleAnchors.has(term));
      return { post, score, matchedTerms: matchedTerms.slice(0, 12), directHits: matchedTerms.length, hasDirectTopicAnchor };
    })
    .filter((item) => item.score >= 0.2 && item.hasDirectTopicAnchor)
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
