import { z } from "zod";
import { AuthorSchema, HttpUrlSchema, IdSchema, IsoDateSchema, MetadataSchema } from "./common";

export const EngagementSchema = z
  .object({
    replies: z.number().int().nonnegative().optional(),
    reactions: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Moltbook content is external, untrusted data. This schema stores it as
 * data only; callers must never treat `content` or `metadata` as instructions.
 */
export const MoltbookPostSchema = z
  .object({
    postId: IdSchema,
    url: HttpUrlSchema,
    submolt: z.string().trim().min(1),
    author: AuthorSchema,
    content: z.string(),
    createdAt: IsoDateSchema,
    fetchedAt: IsoDateSchema,
    parentId: IdSchema.optional(),
    engagement: EngagementSchema.optional(),
    metadata: MetadataSchema.optional(),
  })
  .strict();

export const PostContextSchema = z
  .object({
    contextId: IdSchema,
    post: MoltbookPostSchema,
    parent: MoltbookPostSchema.optional(),
    replies: z.array(MoltbookPostSchema),
    nearbyPosts: z.array(MoltbookPostSchema),
    authorContext: z.string().optional(),
    conversationDirection: z.string().optional(),
    existingMarxMentions: z.number().int().nonnegative(),
    saturatedAngles: z.array(z.string()),
    fetchedAt: IsoDateSchema,
  })
  .strict();

export type Engagement = z.infer<typeof EngagementSchema>;
export type MoltbookPost = z.infer<typeof MoltbookPostSchema>;
export type PostContext = z.infer<typeof PostContextSchema>;

/** Legacy/context-builder reply shape kept explicit at the adapter boundary. */
export const PostReplySchema = z
  .object({
    replyId: IdSchema,
    author: AuthorSchema,
    content: z.string(),
    createdAt: IsoDateSchema,
    parentId: IdSchema.optional(),
    engagement: EngagementSchema.optional(),
  })
  .strict();

export const ConversationContextSchema = z
  .object({
    post: MoltbookPostSchema,
    parent: MoltbookPostSchema.optional(),
    replies: z.array(PostReplySchema),
    authorContext: MetadataSchema.optional(),
    fetchedAt: IsoDateSchema,
    conversationText: z.string(),
    marxMentions: z.number().int().nonnegative(),
    repeatedAngles: z.array(z.string()),
    saturated: z.boolean(),
    untrustedSignals: z.array(z.string()),
  })
  .strict();

export type PostReply = z.infer<typeof PostReplySchema>;
export type ConversationContext = z.infer<typeof ConversationContextSchema>;
