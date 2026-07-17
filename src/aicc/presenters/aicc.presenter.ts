import { Injectable } from "@nestjs/common";
import { Types } from "mongoose";
import {
  AiccChannel,
  AiccOutcome,
  AiccSessionDocument,
  AiccSessionStatus,
} from "../schemas/aicc-session.schema";
import {
  AiccMessage,
  AiccMessageSpeaker,
} from "../schemas/aicc-message.schema";
import { AiccToolCallStatus } from "../schemas/aicc-tool-call.schema";
import {
  AiccHandoffDocument,
  AiccHandoffPriority,
  AiccHandoffReason,
  AiccHandoffStatus,
} from "../schemas/aicc-handoff.schema";
import {
  AiccKnowledge,
  AiccKnowledgeDocument,
  AiccKnowledgeStatus,
} from "../schemas/aicc-knowledge.schema";
import {
  AiccAnalyticsDashboardResponse,
  AiccHandoffListResponse,
  AiccHandoffResponse,
  AiccKnowledgeListResponse,
  AiccKnowledgeResponse,
  AiccSessionResponse,
  AiccTranscriptResponse,
} from "../aicc.types";

interface TimestampedDocument {
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AiccSessionAnalyticsLean {
  sessionId: string;
  status: AiccSessionStatus;
  currentIntent?: string;
  outcome?: AiccOutcome;
}

export interface AiccMessageAnalyticsLean {
  speaker: AiccMessageSpeaker;
  intent?: string;
  latencyMs?: number;
}

export interface AiccToolCallAnalyticsLean {
  toolName: string;
  status: string;
  durationMs: number;
}

export interface AiccHandoffAnalyticsLean {
  reason: string;
  status: AiccHandoffStatus;
}

export interface AiccAnalyticsRange {
  from: Date;
  to: Date;
  channel: AiccChannel | "all";
}

type AiccIdValue = Types.ObjectId | string;

export interface AiccHandoffView extends TimestampedDocument {
  _id: AiccIdValue;
  sessionId: string;
  userId?: AiccIdValue;
  customerEmail?: string;
  customerPhone?: string;
  reason: AiccHandoffReason;
  priority: AiccHandoffPriority;
  summary: string;
  status: AiccHandoffStatus;
  assignedTo?: AiccIdValue;
  pickedAt?: Date;
  resolvedAt?: Date;
  resolutionNote?: string;
  metadata?: Record<string, unknown>;
}

export interface AiccKnowledgeView extends TimestampedDocument {
  _id: AiccIdValue;
  title: string;
  category: AiccKnowledge["category"];
  content: string;
  status: AiccKnowledgeStatus;
  version: number;
  effectiveFrom?: Date;
  updatedBy?: AiccIdValue;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AiccPresenter {
  handoffListResponse(
    items: AiccHandoffView[],
    page: number,
    limit: number,
    total: number
  ): AiccHandoffListResponse {
    const totalPages = Math.ceil(total / limit);
    return {
      items: items.map((item) => this.toHandoffResponse(item)),
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }

  knowledgeListResponse(
    items: AiccKnowledgeView[],
    page: number,
    limit: number,
    total: number
  ): AiccKnowledgeListResponse {
    const totalPages = Math.ceil(total / limit);
    return {
      items: items.map((item) => this.toKnowledgeResponse(item)),
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }

  analyticsDashboardResponse(
    range: AiccAnalyticsRange,
    sessionRows: AiccSessionAnalyticsLean[],
    messages: AiccMessageAnalyticsLean[],
    tools: AiccToolCallAnalyticsLean[],
    handoffs: AiccHandoffAnalyticsLean[]
  ): AiccAnalyticsDashboardResponse {
    const totalSessions = sessionRows.length;
    const completed = this.countByValue(
      sessionRows.map((session) => session.status),
      AiccSessionStatus.COMPLETED
    );
    const handoff = this.countByValue(
      sessionRows.map((session) => session.status),
      AiccSessionStatus.HANDOFF
    );
    const abandoned = this.countByValue(
      sessionRows.map((session) => session.status),
      AiccSessionStatus.ABANDONED
    );
    const active = this.countByValue(
      sessionRows.map((session) => session.status),
      AiccSessionStatus.ACTIVE
    );
    const successfulTools = tools.filter(
      (tool) => tool.status === AiccToolCallStatus.SUCCESS
    ).length;
    const toolDurations = tools
      .map((tool) => tool.durationMs)
      .filter((duration) => Number.isFinite(duration));
    const latencies = messages
      .filter((message) => message.speaker === AiccMessageSpeaker.AI)
      .map((message) => message.latencyMs)
      .filter((latency): latency is number => typeof latency === "number");

    return {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        channel: range.channel,
      },
      sessions: {
        total: totalSessions,
        completed,
        handoff,
        abandoned,
        active,
      },
      containmentRate: this.rate(completed, totalSessions),
      handoffRate: this.rate(handoff, totalSessions),
      topIntents: this.topCounts(
        messages
          .filter((message) => message.speaker === AiccMessageSpeaker.CUSTOMER)
          .map((message) => message.intent)
          .filter((intent): intent is string => Boolean(intent))
      ),
      tools: {
        totalCalls: tools.length,
        successRate: this.rate(successfulTools, tools.length),
        avgDurationMs: this.average(toolDurations),
      },
      handoff: {
        topReasons: this.topCounts(handoffs.map((item) => item.reason)),
        open: this.countByValue(
          handoffs.map((item) => item.status),
          AiccHandoffStatus.OPEN
        ),
        resolved: this.countByValue(
          handoffs.map((item) => item.status),
          AiccHandoffStatus.RESOLVED
        ),
      },
      latency: {
        avgResponseMs: this.average(latencies),
        p95ResponseMs: this.percentile(latencies, 0.95),
      },
      supportCounts: {
        bookingSupport: this.countByValue(
          sessionRows.map((session) => session.outcome),
          AiccOutcome.BOOKING_SUPPORT
        ),
        paymentIssue: handoffs.filter(
          (item) => item.reason === AiccHandoffReason.PAYMENT_ISSUE
        ).length,
        ticketLookup: this.countByValue(
          messages
            .filter(
              (message) => message.speaker === AiccMessageSpeaker.CUSTOMER
            )
            .map((message) => message.intent),
          "ticket_lookup"
        ),
      },
    };
  }

  toSessionResponse(session: AiccSessionDocument): AiccSessionResponse {
    const timestamped = session as AiccSessionDocument & TimestampedDocument;
    const metadata = session.metadata ?? {};

    return {
      sessionId: session.sessionId,
      channel: session.channel,
      status: session.status,
      currentIntent: session.currentIntent,
      phase: session.phase,
      summary: session.summary,
      outcome: session.outcome,
      metadata,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      createdAt: timestamped.createdAt,
      updatedAt: timestamped.updatedAt,
    };
  }

  toHandoffResponse(
    handoff: AiccHandoffDocument | AiccHandoffView
  ): AiccHandoffResponse {
    const timestamped = handoff as TimestampedDocument;
    const id = handoff._id.toString();

    return {
      id,
      sessionId: handoff.sessionId,
      userId: handoff.userId?.toString(),
      customerEmail: handoff.customerEmail,
      customerPhone: handoff.customerPhone,
      reason: handoff.reason,
      priority: handoff.priority,
      summary: handoff.summary,
      status: handoff.status,
      assignedTo: handoff.assignedTo?.toString(),
      pickedAt: handoff.pickedAt,
      resolvedAt: handoff.resolvedAt,
      resolutionNote: handoff.resolutionNote,
      metadata: handoff.metadata ?? {},
      createdAt: timestamped.createdAt,
      updatedAt: timestamped.updatedAt,
    };
  }

  toKnowledgeResponse(
    knowledge: AiccKnowledgeDocument | AiccKnowledgeView
  ): AiccKnowledgeResponse {
    const timestamped = knowledge as TimestampedDocument;
    const id = knowledge._id.toString();

    return {
      id,
      title: knowledge.title,
      category: knowledge.category,
      content: knowledge.content,
      status: knowledge.status,
      version: knowledge.version,
      effectiveFrom: knowledge.effectiveFrom,
      updatedBy: knowledge.updatedBy?.toString(),
      metadata: knowledge.metadata ?? {},
      createdAt: timestamped.createdAt,
      updatedAt: timestamped.updatedAt,
    };
  }

  toTranscriptResponse(message: AiccMessage): AiccTranscriptResponse {
    const timestamped = message as AiccMessage & TimestampedDocument;

    return {
      sessionId: message.sessionId,
      turnNo: message.turnNo,
      speaker: message.speaker,
      text: message.text,
      confidence: message.confidence,
      metadata: message.metadata ?? {},
      createdAt: timestamped.createdAt,
    };
  }

  private countByValue<TValue>(
    values: Array<TValue | undefined>,
    target: TValue
  ): number {
    return values.filter((value) => value === target).length;
  }

  private topCounts(values: string[], limit = 5): Array<[string, number]> {
    const counts = new Map<string, number>();
    for (const value of values) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
      )
      .slice(0, limit);
  }

  private rate(numerator: number, denominator: number): number {
    if (denominator <= 0) {
      return 0;
    }
    return Number((numerator / denominator).toFixed(4));
  }

  private average(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    return Math.round(total / values.length);
  }

  private percentile(values: number[], percentile: number): number {
    if (values.length === 0) {
      return 0;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(percentile * sorted.length) - 1)
    );
    return Math.round(sorted[index]);
  }
}
