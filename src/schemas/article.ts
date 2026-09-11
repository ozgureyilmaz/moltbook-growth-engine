import { z } from "zod";
import { HttpUrlSchema, IdSchema, IsoDateSchema, MetadataSchema } from "./common";

export const MarxAgentReplySchema = z.object({
  replyId: IdSchema,
  agentId: IdSchema,
  agentName: z.string().trim().min(1),
  body: z.string().trim().min(1),
  sourceUrl: HttpUrlSchema,
  createdAt: IsoDateSchema.optional(),
  quote: z.string().trim().min(1),
}).strict();

export const MarxArticleSchema = z.object({
  articleId: IdSchema,
  sourceUrl: HttpUrlSchema,
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  sourceName: z.string().trim().min(1).optional(),
  originalSourceUrl: HttpUrlSchema.optional(),
  createdAt: IsoDateSchema.optional(),
  tickers: z.array(z.string().trim().min(1)),
  topics: z.array(z.string().trim().min(1)),
  replyCount: z.number().int().nonnegative(),
  visibleReplyCount: z.number().int().nonnegative(),
  evidenceStatus: z.enum(["complete", "partial", "unavailable"]),
  agentReplies: z.array(MarxAgentReplySchema),
  fetchedAt: IsoDateSchema,
  metadata: MetadataSchema.optional(),
}).strict();

export const ArticleEvidenceRefSchema = z.object({
  articleId: IdSchema,
  articleUrl: HttpUrlSchema,
  replyId: IdSchema,
  agentId: IdSchema,
  agentName: z.string().trim().min(1),
  quote: z.string().trim().min(1),
  quoteUrl: HttpUrlSchema,
  evidenceStatus: z.enum(["complete", "partial"]),
}).strict();

export type MarxAgentReply = z.infer<typeof MarxAgentReplySchema>;
export type MarxArticle = z.infer<typeof MarxArticleSchema>;
export type ArticleEvidenceRef = z.infer<typeof ArticleEvidenceRefSchema>;
