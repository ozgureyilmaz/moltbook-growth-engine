/**
 * Contracts shared by the intelligence vertical slice.
 *
 * The domain and persistence packages are owned by other build workers.  The
 * type-only imports keep this slice coupled to their public modules without
 * creating a runtime dependency on a particular storage implementation.
 */
import type * as SharedDomain from "../domain";
import type * as SharedPersistence from "../persistence";
import type { ModelRunRecord, Outcome, Publication, StrategyStatistics } from "../schemas";

export type DomainExports = typeof SharedDomain;
export type PersistenceExports = typeof SharedPersistence;

export type Author = {
  id?: string;
  name?: string;
  type?: string;
};

export type MoltbookPost = {
  postId: string;
  url: string;
  submolt: string;
  author: Author;
  content: string;
  createdAt: string;
  fetchedAt: string;
  parentId?: string;
  engagement?: { replies?: number; reactions?: number };
  metadata?: Record<string, unknown>;
};

export type PostReply = {
  replyId: string;
  author: Author;
  content: string;
  createdAt: string;
  parentId?: string;
  engagement?: { replies?: number; reactions?: number };
};

export type PostContext = {
  post: MoltbookPost;
  parent?: MoltbookPost;
  replies: PostReply[];
  authorContext?: Record<string, unknown>;
  fetchedAt: string;
};

export type ConversationContext = PostContext & {
  conversationText: string;
  marxMentions: number;
  repeatedAngles: string[];
  saturated: boolean;
  untrustedSignals: string[];
};

/** Attribution carried by decision-learning artifacts when available. */
export type DecisionAttribution = {
  runId?: string;
  sourcePostId?: string;
};

export type DiscoveryRequest = {
  limit?: number;
  lookbackHours?: number;
  now?: string;
  includeSubmolts?: string[];
  excludeSubmolts?: string[];
};

export type ScoreComponents = {
  semanticRelevance: number;
  marxBridgeStrength: number;
  agentAttentionProbability: number;
  conversationFit: number;
  engagementPotential: number;
  novelty: number;
  timing: number;
  targetQuality: number;
  spamRisk: number;
  repetitionRisk: number;
  contextMismatch: number;
};

export type Opportunity = DecisionAttribution & {
  opportunityId: string;
  runId?: string;
  sourcePostId?: string;
  post: MoltbookPost;
  context: ConversationContext;
  scores: ScoreComponents;
  finalScore: number;
  reason: string;
  recommendedStrategies: StrategyFamily[];
};

export type StrategyFamily =
  | "contextual_insight"
  | "agent_question"
  | "agent_challenge"
  | "provenance"
  | "consensus_failure"
  | "signal_validation"
  | "coordination"
  | "counter_evidence"
  | "research_extension"
  | "marx_discussion_bridge"
  | "marx_experiment"
  | "capability_bridge"
  | "comparative_reasoning";

export type GeneratedCandidate = DecisionAttribution & {
  candidateId: string;
  opportunityId: string;
  runId?: string;
  sourcePostId?: string;
  strategyFamily: StrategyFamily;
  hookFamily: string;
  comment: string;
  promptVersion: string;
  modelVersion: string;
};

export type EvaluatorRecommendation = "PUBLISH" | "REGENERATE" | "NO_ACTION";

export type EvaluationScores = {
  contextFit: number;
  agentInterestProbability: number;
  marxRelevance: number;
  novelty: number;
  usefulness: number;
  naturalness: number;
  conversationContribution: number;
  nonSpamQuality: number;
  brandFit: number;
  likelihoodOfAgentFollowup: number;
  likelihoodOfMarxInvestigation: number;
  genericness: number;
  promotionIntensity: number;
  repetition: number;
  unsupportedClaimRisk: number;
};

export type EvaluationResult = DecisionAttribution & {
  candidateId: string;
  runId?: string;
  sourcePostId?: string;
  scores: EvaluationScores;
  overallScore: number;
  confidence: number;
  recommendation: EvaluatorRecommendation;
  reasons: string[];
  modelVersion: string;
  promptVersion?: string;
  qa?: QAResult;
};

export type QAResult = DecisionAttribution & {
  passed: boolean;
  checks: Record<string, boolean>;
  reasons: string[];
  marxMentionCount: number;
  runId?: string;
  sourcePostId?: string;
};

export type ActionPayload = {
  schemaVersion: "1.0";
  actionId: string;
  action: "COMMENT";
  platform: "moltbook";
  target: {
    postId: string;
    postUrl: string;
    submolt: string;
    agentId?: string;
    agentName?: string;
  };
  content: {
    comment: string;
    strategyFamily: StrategyFamily;
    hookFamily: string;
  };
  decision: {
    opportunityScore: number;
    evaluationScore: number;
    confidence: number;
  };
  experiment: {
    experimentId: string;
    promptVersion: string;
    modelVersion: string;
  };
  metadata: { createdAt: string; runId: string };
};

export type NoActionDecision = {
  schemaVersion: "1.0";
  actionId: string;
  action: "NO_ACTION";
  reason:
    | "LOW_RELEVANCE"
    | "WEAK_MARX_BRIDGE"
    | "GENERIC_COMMENT"
    | "THREAD_SATURATED"
    | "DUPLICATE"
    | "LOW_INFORMATION_VALUE"
    | "PROMOTIONAL_ONLY"
    | "UNSUPPORTED_CLAIM"
    | "CONTEXT_MISSING"
    | "PLATFORM_RESTRICTION"
    | "PUBLISHING_RISK"
    | "QUALITY_BELOW_THRESHOLD";
  target?: { postId: string; postUrl?: string };
  metadata: { createdAt: string; runId: string };
};

export type ExperimentRecord = {
  experimentId: string;
  runId: string;
  sourcePlatform: "moltbook";
  sourceSubmolt: string;
  sourcePostId: string;
  sourceUrl: string;
  targetAgentId?: string;
  targetAgentName?: string;
  hookFamily: string;
  strategyFamily: StrategyFamily;
  model: string;
  modelVersion: string;
  promptVersion: string;
  templateVersion: string;
  commentHash: string;
  semanticCluster: string;
  opportunityScore: number;
  generatorScores?: Record<string, number>;
  evaluatorScores?: Record<string, number>;
  publicationTimestamp?: string;
  publisherStatus: "pending" | "acknowledged" | "published" | "failed";
  createdAt?: string;
  outcome?: ExperimentOutcome;
};

export type ExperimentOutcome = {
  replyReceived?: boolean;
  replyLatencyMs?: number;
  reactionCount?: number;
  targetAgentEngaged?: boolean;
  marxMentionedByTargetAfterward?: boolean;
  /** North-star progression: the target investigated Marx after publication. */
  marxInvestigationSignal?: boolean;
  /** @deprecated Use marxInvestigationSignal; retained for telemetry compatibility. */
  marxDiscussionVisitSignal?: boolean;
  marxInteractionSignal?: boolean;
  marxUsageSignal?: boolean;
};

export const NORTH_STAR_OUTCOME_FIELDS = [
  "marxInvestigationSignal",
  "marxInteractionSignal",
  "marxUsageSignal",
] as const;

export type NorthStarOutcomeField = (typeof NORTH_STAR_OUTCOME_FIELDS)[number];

export type StrategyPrior = {
  strategyFamily: StrategyFamily;
  successes: number;
  trials: number;
  prior: number;
  posterior: number;
};

export type RunSummary = {
  runId: string;
  startTime: string;
  endTime?: string;
  discovered: number;
  deduplicated: number;
  analyzed: number;
  qualified: number;
  generated: number;
  passedEvaluator: number;
  actionsEmitted: number;
  rejected: number;
  errors: number;
  modelCalls: number;
  workerCalls: number;
  dryRun: boolean;
  retries?: number;
  errorMessages?: string[];
  failureReceipts?: Array<{ kind: string; message: string; stage?: string; subjectId?: string }>;
  resourceMetadata?: Record<string, unknown>;
};

/** The only runtime Luna worker roles. Keep this union intentionally closed. */
export type RuntimeWorkerRole = "discovery_context" | "opportunity_analysis" | "strategy_generation";

/** Compact report contract shared with the persistence WorkerReport schema. */
export type WorkerReport = {
  reportId: string;
  runId: string;
  taskId: string;
  worker: RuntimeWorkerRole;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  summary: string;
  findings: string[];
  artifacts: string[];
  metrics?: Record<string, unknown>;
  errors: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type PersistenceLike = {
  savePost?: (post: MoltbookPost) => Promise<void> | void;
  saveContext?: (context: ConversationContext) => Promise<void> | void;
  saveOpportunity?: (opportunity: Opportunity) => Promise<void> | void;
  saveCandidate?: (candidate: GeneratedCandidate) => Promise<void> | void;
  saveEvaluation?: (evaluation: EvaluationResult) => Promise<void> | void;
  saveAction?: (action: ActionPayload | NoActionDecision) => Promise<void> | void;
  saveExperiment?: (experiment: ExperimentRecord) => Promise<void> | void;
  getRecentComments?: (limit?: number) => Promise<string[]> | string[];
  getExperiments?: () => Promise<ExperimentRecord[]> | ExperimentRecord[];
  saveRun?: (run: RunSummary) => Promise<void> | void;
  saveWorkerReport?: (report: WorkerReport) => Promise<void> | void;
  savePublication?: (publication: Publication) => Promise<void> | void;
  saveOutcome?: (outcome: Outcome) => Promise<void> | void;
  saveStrategyStatistics?: (statistics: StrategyStatistics) => Promise<void> | void;
  saveModelRun?: (modelRun: ModelRunRecord) => Promise<void> | void;
  getRun?: (runId: string) => Promise<RunSummary | undefined> | RunSummary | undefined;
  listRuns?: (limit?: number) => Promise<RunSummary[]> | RunSummary[];
};

export const asPromise = async <T>(value: T | Promise<T>): Promise<T> => value;
