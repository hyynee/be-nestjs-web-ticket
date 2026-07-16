import {
  AiccChannel,
  AiccOutcome,
  AiccSessionPhase,
  AiccSessionStatus,
} from "./schemas/aicc-session.schema";
import { AiccMessageSpeaker } from "./schemas/aicc-message.schema";
import {
  AiccExecutedToolCall,
  CheckoutAction,
  EventSummary,
} from "./tools/aicc-tool.types";
import {
  AiccHandoffPriority,
  AiccHandoffReason,
  AiccHandoffStatus,
} from "./schemas/aicc-handoff.schema";
import {
  AiccKnowledgeCategory,
  AiccKnowledgeStatus,
} from "./schemas/aicc-knowledge.schema";

export interface AiccSessionResponse {
  sessionId: string;
  channel: AiccChannel;
  status: AiccSessionStatus;
  currentIntent?: string;
  phase: AiccSessionPhase;
  summary?: string;
  outcome?: AiccOutcome;
  metadata: Record<string, unknown>;
  startedAt: Date;
  endedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AiccMessageResponse {
  sessionId: string;
  reply: string;
  intent: string;
  phase: AiccSessionPhase;
  turnNo: number;
  events: EventSummary[];
  actions: CheckoutAction[];
  toolCalls: AiccExecutedToolCall[];
  handoff?: AiccHandoffResponse;
}

export interface AiccHandoffResponse {
  id: string;
  sessionId: string;
  userId?: string;
  customerEmail?: string;
  customerPhone?: string;
  reason: AiccHandoffReason;
  priority: AiccHandoffPriority;
  summary: string;
  status: AiccHandoffStatus;
  assignedTo?: string;
  pickedAt?: Date;
  resolvedAt?: Date;
  resolutionNote?: string;
  metadata: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AiccHandoffListResponse {
  items: AiccHandoffResponse[];
  meta: {
    currentPage: number;
    itemsPerPage: number;
    totalItems: number;
    totalPages: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
}

export interface AiccKnowledgeResponse {
  id: string;
  title: string;
  category: AiccKnowledgeCategory;
  content: string;
  status: AiccKnowledgeStatus;
  version: number;
  effectiveFrom?: Date;
  updatedBy?: string;
  metadata: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AiccKnowledgeListResponse {
  items: AiccKnowledgeResponse[];
  meta: {
    currentPage: number;
    itemsPerPage: number;
    totalItems: number;
    totalPages: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
}

export interface AiccTranscriptResponse {
  sessionId: string;
  turnNo: number;
  speaker: AiccMessageSpeaker;
  text: string;
  confidence?: number;
  metadata: Record<string, unknown>;
  createdAt?: Date;
}

export interface AiccAnalyticsDashboardResponse {
  range: {
    from: string;
    to: string;
    channel: AiccChannel | "all";
  };
  sessions: {
    total: number;
    completed: number;
    handoff: number;
    abandoned: number;
    active: number;
  };
  containmentRate: number;
  handoffRate: number;
  topIntents: Array<[string, number]>;
  tools: {
    totalCalls: number;
    successRate: number;
    avgDurationMs: number;
  };
  handoff: {
    topReasons: Array<[string, number]>;
    open: number;
    resolved: number;
  };
  latency: {
    avgResponseMs: number;
    p95ResponseMs: number;
  };
  supportCounts: {
    bookingSupport: number;
    paymentIssue: number;
    ticketLookup: number;
  };
}
