import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, SortOrder, Types } from "mongoose";
import { randomUUID } from "crypto";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CreateAiccSessionDto } from "./dto/create-aicc-session.dto";
import { SendAiccMessageDto } from "./dto/send-aicc-message.dto";
import {
  EndAiccSessionDto,
  EndAiccSessionReason,
} from "./dto/end-aicc-session.dto";
import { CreateAiccTranscriptDto } from "./dto/create-aicc-transcript.dto";
import { QueryAiccAnalyticsDto } from "./dto/query-aicc-analytics.dto";
import {
  AiccChannel,
  AiccOutcome,
  AiccSession,
  AiccSessionDocument,
  AiccSessionPhase,
  AiccSessionStatus,
} from "./schemas/aicc-session.schema";
import { AiccMessage, AiccMessageSpeaker } from "./schemas/aicc-message.schema";
import {
  AiccToolCall,
  AiccToolCallStatus,
} from "./schemas/aicc-tool-call.schema";
import {
  AiccHandoff,
  AiccHandoffDocument,
  AiccHandoffPriority,
  AiccHandoffReason,
  AiccHandoffStatus,
} from "./schemas/aicc-handoff.schema";
import {
  AiccKnowledge,
  AiccKnowledgeDocument,
  AiccKnowledgeStatus,
} from "./schemas/aicc-knowledge.schema";
import { AiccOrchestratorService } from "./orchestrator/aicc-orchestrator.service";
import { CreateAiccHandoffDto } from "./dto/create-aicc-handoff.dto";
import { UpdateAiccHandoffDto } from "./dto/update-aicc-handoff.dto";
import { QueryAiccHandoffDto } from "./dto/query-aicc-handoff.dto";
import { CreateAiccKnowledgeDto } from "./dto/create-aicc-knowledge.dto";
import { UpdateAiccKnowledgeDto } from "./dto/update-aicc-knowledge.dto";
import {
  QueryAiccKnowledgeDto,
  SearchAiccKnowledgeDto,
} from "./dto/query-aicc-knowledge.dto";
import { AiccGateway } from "./aicc.gateway";
import {
  AiccAnalyticsDashboardResponse,
  AiccHandoffListResponse,
  AiccHandoffResponse,
  AiccKnowledgeListResponse,
  AiccKnowledgeResponse,
  AiccMessageResponse,
  AiccSessionResponse,
  AiccTranscriptResponse,
} from "./aicc.types";
import {
  AiccExecutedToolCall,
  KnowledgeSearchResult,
} from "./tools/aicc-tool.types";
import { AiccKnowledgeTool } from "./tools/knowledge.tool";

const MAX_SERIALIZED_METADATA_LENGTH = 8000;
const MAX_ANALYTICS_RANGE_DAYS = 31;

interface TimestampedDocument {
  createdAt?: Date;
  updatedAt?: Date;
}

interface AiccSessionAnalyticsLean {
  sessionId: string;
  status: AiccSessionStatus;
  currentIntent?: string;
  outcome?: AiccOutcome;
}

interface AiccMessageAnalyticsLean {
  speaker: AiccMessageSpeaker;
  intent?: string;
  latencyMs?: number;
}

interface AiccToolCallAnalyticsLean {
  toolName: string;
  status: string;
  durationMs: number;
}

interface AiccHandoffAnalyticsLean {
  reason: string;
  status: AiccHandoffStatus;
}

interface AiccAnalyticsRange {
  from: Date;
  to: Date;
  channel: AiccChannel | "all";
}

type AiccIdValue = Types.ObjectId | string;

interface AiccHandoffView extends TimestampedDocument {
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

interface AiccKnowledgeView extends TimestampedDocument {
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
export class AiccService {
  private readonly logger = new Logger(AiccService.name);

  constructor(
    @InjectModel(AiccSession.name)
    private readonly aiccSessionModel: Model<AiccSession>,
    @InjectModel(AiccMessage.name)
    private readonly aiccMessageModel: Model<AiccMessage>,
    @InjectModel(AiccToolCall.name)
    private readonly aiccToolCallModel: Model<AiccToolCall>,
    @InjectModel(AiccHandoff.name)
    private readonly aiccHandoffModel: Model<AiccHandoff>,
    @InjectModel(AiccKnowledge.name)
    private readonly aiccKnowledgeModel: Model<AiccKnowledge>,
    private readonly orchestrator: AiccOrchestratorService,
    private readonly knowledgeTool: AiccKnowledgeTool,
    private readonly aiccGateway: AiccGateway
  ) {}

  private handoffListResponse(
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

  private knowledgeListResponse(
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

  private analyticsDashboardResponse(
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

  async createSession(
    dto: CreateAiccSessionDto,
    user?: JwtPayload | null
  ): Promise<AiccSessionResponse> {
    const metadata = this.sanitizeMetadata(dto.metadata);
    const userId = this.getUserObjectId(user);
    const session = await this.aiccSessionModel.create({
      sessionId: this.generateSessionId(),
      channel: dto.channel ?? AiccChannel.CHAT,
      userId,
      customerEmail: dto.customerEmail?.trim().toLowerCase(),
      customerPhone: dto.customerPhone?.trim(),
      status: AiccSessionStatus.ACTIVE,
      phase: AiccSessionPhase.GREETING,
      metadata,
      nextTurnNo: 1,
      startedAt: new Date(),
    });

    this.logger.log(`AICC session created: ${session.sessionId}`);

    return this.toSessionResponse(session);
  }

  async getSession(
    sessionId: string,
    user?: JwtPayload | null
  ): Promise<AiccSessionResponse> {
    const session = await this.findSessionOrThrow(sessionId);
    this.assertSessionAccess(session, user);

    return this.toSessionResponse(session);
  }

  async sendMessage(
    sessionId: string,
    dto: SendAiccMessageDto,
    user?: JwtPayload | null
  ): Promise<AiccMessageResponse> {
    const startedAt = Date.now();
    const mongoSession = await this.aiccSessionModel.db.startSession();
    let response: AiccMessageResponse | null = null;
    let handoffToEmit: AiccHandoffResponse | null = null;

    try {
      const activeSession = await this.aiccSessionModel.findOneAndUpdate(
        { sessionId, status: AiccSessionStatus.ACTIVE },
        { $inc: { nextTurnNo: 2 } },
        { new: false }
      );

      if (!activeSession) {
        throw await this.getSessionUnavailableException(sessionId);
      }

      this.assertSessionAccess(activeSession, user);

      const customerTurnNo = activeSession.nextTurnNo;
      const aiTurnNo = customerTurnNo + 1;
      const previousUnknownCount = this.getUnknownIntentCount(
        activeSession.metadata
      );
      const orchestrated = await this.orchestrator.handleMessage({
        sessionId,
        turnNo: customerTurnNo,
        message: dto.message,
        access: {
          userId: activeSession.userId?.toString(),
          customerEmail: activeSession.customerEmail,
          customerPhone: activeSession.customerPhone,
        },
        previousUnknownCount,
      });
      const latencyMs = Date.now() - startedAt;
      const knowledgeTrace = this.extractKnowledgeTrace(orchestrated.toolCalls);
      const unknownIntentCount =
        orchestrated.intent === "unknown" ? previousUnknownCount + 1 : 0;

      await mongoSession.withTransaction(async () => {
        await this.aiccMessageModel.create(
          [
            {
              sessionId,
              turnNo: customerTurnNo,
              speaker: AiccMessageSpeaker.CUSTOMER,
              text: dto.message.trim(),
              intent: orchestrated.intent,
              entities: orchestrated.entities,
              metadata: this.sanitizeMetadata(dto.context),
            },
            {
              sessionId,
              turnNo: aiTurnNo,
              speaker: AiccMessageSpeaker.AI,
              text: orchestrated.reply,
              intent: orchestrated.intent,
              entities: {},
              latencyMs,
              metadata: {
                phase: orchestrated.phase,
                toolNames: orchestrated.toolCalls.map((call) => call.toolName),
                ...knowledgeTrace,
              },
            },
          ],
          // Mongoose requires `ordered: true` when create() is called with a
          // session and more than one document, otherwise it throws.
          { session: mongoSession, ordered: true }
        );

        if (orchestrated.toolCalls.length > 0) {
          await this.aiccToolCallModel.create(orchestrated.toolCalls, {
            session: mongoSession,
            ordered: true,
          });
        }

        let handoffResponse: AiccHandoffResponse | undefined;
        if (orchestrated.handoffRequest) {
          const [handoff] = await this.aiccHandoffModel.create(
            [
              {
                sessionId,
                userId: activeSession.userId,
                customerEmail: activeSession.customerEmail,
                customerPhone: activeSession.customerPhone,
                reason: orchestrated.handoffRequest.reason,
                priority: orchestrated.handoffRequest.priority,
                summary: orchestrated.handoffRequest.summary,
                status: AiccHandoffStatus.OPEN,
                metadata: this.sanitizeMetadata(
                  orchestrated.handoffRequest.metadata
                ),
              },
            ],
            { session: mongoSession }
          );
          handoffResponse = this.toHandoffResponse(handoff);
          handoffToEmit = handoffResponse;
        }

        const sessionUpdate = await this.aiccSessionModel.updateOne(
          { sessionId, status: AiccSessionStatus.ACTIVE },
          {
            $set: {
              currentIntent: orchestrated.intent,
              phase: orchestrated.handoffRequest
                ? AiccSessionPhase.CLOSING
                : orchestrated.phase,
              status: orchestrated.handoffRequest
                ? AiccSessionStatus.HANDOFF
                : AiccSessionStatus.ACTIVE,
              outcome: orchestrated.handoffRequest
                ? AiccOutcome.HANDOFF
                : orchestrated.outcome,
              summary: orchestrated.handoffRequest?.summary,
              "metadata.unknownIntentCount": unknownIntentCount,
            },
          },
          { session: mongoSession }
        );
        if (sessionUpdate.modifiedCount === 0) {
          throw new BadRequestException(
            "Phiên AICC đã thay đổi trạng thái trong lúc xử lý tin nhắn"
          );
        }

        response = {
          sessionId,
          reply: orchestrated.reply,
          intent: orchestrated.intent,
          phase: orchestrated.phase,
          turnNo: aiTurnNo,
          events: [],
          actions: orchestrated.actions,
          toolCalls: orchestrated.toolCalls,
          handoff: handoffResponse,
        };
      });
    } catch (error) {
      if (error instanceof HttpException) {
        this.logger.warn(
          `AICC sendMessage rejected for sessionId=${sessionId}: ${error.message}`
        );
      } else {
        this.logger.error(
          `AICC sendMessage failed for sessionId=${sessionId}: ${
            (error as Error).message
          }`,
          (error as Error).stack
        );
      }
      throw error;
    } finally {
      await mongoSession.endSession();
    }

    if (handoffToEmit) {
      this.aiccGateway.emitHandoffCreated(handoffToEmit);
      this.aiccGateway.emitSessionUpdated(sessionId, AiccSessionStatus.HANDOFF);
    }

    if (!response) {
      throw new BadRequestException("Không thể xử lý tin nhắn AICC");
    }

    return response;
  }

  async endSession(
    sessionId: string,
    dto: EndAiccSessionDto,
    user?: JwtPayload | null
  ): Promise<AiccSessionResponse> {
    const existing = await this.findSessionOrThrow(sessionId);
    this.assertSessionAccess(existing, user);

    if (existing.status !== AiccSessionStatus.ACTIVE) {
      return this.toSessionResponse(existing);
    }

    const status = this.mapEndReasonToStatus(dto.reason);
    const ended = await this.aiccSessionModel.findOneAndUpdate(
      { sessionId, status: AiccSessionStatus.ACTIVE },
      {
        $set: {
          status,
          phase: AiccSessionPhase.CLOSING,
          summary: dto.summary?.trim(),
          outcome:
            status === AiccSessionStatus.HANDOFF
              ? AiccOutcome.HANDOFF
              : existing.outcome,
          endedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!ended) {
      const latest = await this.findSessionOrThrow(sessionId);
      return this.toSessionResponse(latest);
    }

    this.logger.log(`AICC session ended: ${sessionId}, status=${status}`);

    return this.toSessionResponse(ended);
  }

  async createTranscript(
    sessionId: string,
    dto: CreateAiccTranscriptDto,
    user?: JwtPayload | null
  ): Promise<AiccTranscriptResponse> {
    const existing = await this.findSessionOrThrow(sessionId);
    this.assertSessionAccess(existing, user);

    if (
      existing.status !== AiccSessionStatus.ACTIVE &&
      existing.status !== AiccSessionStatus.HANDOFF
    ) {
      throw new BadRequestException(
        `Phiên AICC không nhận transcript ở trạng thái: ${existing.status}`
      );
    }

    const reserved = await this.aiccSessionModel.findOneAndUpdate(
      {
        sessionId,
        status: { $in: [AiccSessionStatus.ACTIVE, AiccSessionStatus.HANDOFF] },
      },
      { $inc: { nextTurnNo: 1 } },
      { new: false }
    );

    if (!reserved) {
      throw await this.getSessionUnavailableException(sessionId);
    }

    const metadata = this.sanitizeMetadata({
      ...(dto.metadata ?? {}),
      transcriptType: "voice_final_transcript",
      externalTurnNo: dto.turnNo,
      startedMs: dto.startedMs,
      endedMs: dto.endedMs,
      sttLatencyMs: dto.sttLatencyMs,
    });

    const [message] = await this.aiccMessageModel.create([
      {
        sessionId,
        turnNo: reserved.nextTurnNo,
        speaker: dto.speaker,
        text: dto.text.trim(),
        confidence: dto.confidence,
        metadata,
      },
    ]);

    return this.toTranscriptResponse(message);
  }

  async getAnalyticsDashboard(
    query: QueryAiccAnalyticsDto
  ): Promise<AiccAnalyticsDashboardResponse> {
    const range = this.resolveAnalyticsRange(query);
    const sessionFilter: FilterQuery<AiccSession> = {
      createdAt: { $gte: range.from, $lte: range.to },
    };
    if (range.channel !== "all") {
      sessionFilter.channel = range.channel;
    }

    const sessionRows = await this.aiccSessionModel
      .find(sessionFilter)
      .select("sessionId status currentIntent outcome")
      .lean<AiccSessionAnalyticsLean[]>()
      .exec();

    const sharedDateFilter: FilterQuery<
      AiccMessage | AiccToolCall | AiccHandoff
    > = {
      createdAt: { $gte: range.from, $lte: range.to },
    };
    if (range.channel !== "all") {
      sharedDateFilter.sessionId = {
        $in: sessionRows.map((session) => session.sessionId),
      };
    }

    const [messageRows, toolRows, handoffRows] = await Promise.all([
      this.aiccMessageModel
        .find(sharedDateFilter)
        .select("speaker intent latencyMs")
        .lean<AiccMessageAnalyticsLean[]>()
        .exec(),
      this.aiccToolCallModel
        .find(sharedDateFilter)
        .select("toolName status durationMs")
        .lean<AiccToolCallAnalyticsLean[]>()
        .exec(),
      this.aiccHandoffModel
        .find(sharedDateFilter)
        .select("reason status")
        .lean<AiccHandoffAnalyticsLean[]>()
        .exec(),
    ]);

    return this.analyticsDashboardResponse(
      range,
      sessionRows,
      messageRows,
      toolRows,
      handoffRows
    );
  }

  async createHandoff(dto: CreateAiccHandoffDto): Promise<AiccHandoffResponse> {
    const session = await this.findSessionOrThrow(dto.sessionId);
    const [handoff] = await this.aiccHandoffModel.create([
      {
        sessionId: dto.sessionId,
        userId: session.userId,
        customerEmail:
          dto.customerEmail?.trim().toLowerCase() ?? session.customerEmail,
        customerPhone: dto.customerPhone?.trim() ?? session.customerPhone,
        reason: dto.reason,
        priority: dto.priority ?? AiccHandoffPriority.NORMAL,
        summary: dto.summary.trim(),
        status: AiccHandoffStatus.OPEN,
        metadata: this.sanitizeMetadata(dto.metadata),
      },
    ]);

    await this.aiccSessionModel.updateOne(
      { sessionId: dto.sessionId },
      {
        $set: {
          status: AiccSessionStatus.HANDOFF,
          outcome: AiccOutcome.HANDOFF,
          phase: AiccSessionPhase.CLOSING,
          summary: dto.summary.trim(),
        },
      }
    );

    const response = this.toHandoffResponse(handoff);
    this.aiccGateway.emitHandoffCreated(response);
    this.aiccGateway.emitSessionUpdated(
      dto.sessionId,
      AiccSessionStatus.HANDOFF
    );

    return response;
  }

  async listHandoffs(
    query: QueryAiccHandoffDto
  ): Promise<AiccHandoffListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const filter: FilterQuery<AiccHandoff> = {};

    if (query.status) {
      filter.status = query.status;
    }
    if (query.assignedTo) {
      filter.assignedTo = new Types.ObjectId(query.assignedTo);
    }

    const [items, total] = await Promise.all([
      this.aiccHandoffModel
        .find(filter)
        .sort({ priority: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<AiccHandoffView[]>()
        .exec(),
      this.aiccHandoffModel.countDocuments(filter).exec(),
    ]);

    return this.handoffListResponse(items, page, limit, total);
  }

  async getHandoff(handoffId: string): Promise<AiccHandoffResponse> {
    const handoff = await this.findHandoffOrThrow(handoffId);
    return this.toHandoffResponse(handoff);
  }

  async updateHandoff(
    handoffId: string,
    dto: UpdateAiccHandoffDto,
    admin?: JwtPayload | null
  ): Promise<AiccHandoffResponse> {
    const existing = await this.findHandoffOrThrow(handoffId);
    const nextStatus = dto.status ?? existing.status;
    const now = new Date();
    const update: Partial<AiccHandoff> = {};

    if (dto.status) {
      update.status = dto.status;
      if (dto.status === AiccHandoffStatus.PICKED && !existing.pickedAt) {
        update.pickedAt = now;
      }
      if (dto.status === AiccHandoffStatus.RESOLVED && !existing.resolvedAt) {
        update.resolvedAt = now;
      }
    }

    if (dto.assignedTo) {
      update.assignedTo = new Types.ObjectId(dto.assignedTo);
    } else if (
      nextStatus === AiccHandoffStatus.PICKED &&
      admin?.userId &&
      Types.ObjectId.isValid(admin.userId) &&
      !existing.assignedTo
    ) {
      update.assignedTo = new Types.ObjectId(admin.userId);
    }

    if (dto.resolutionNote !== undefined) {
      update.resolutionNote = dto.resolutionNote.trim();
    }

    const filter: FilterQuery<AiccHandoff> = {
      _id: new Types.ObjectId(handoffId),
    };
    if (dto.status === AiccHandoffStatus.PICKED) {
      filter.status = AiccHandoffStatus.OPEN;
      filter.assignedTo = { $exists: false };
    } else if (dto.status === AiccHandoffStatus.RESOLVED) {
      filter.status = {
        $in: [AiccHandoffStatus.OPEN, AiccHandoffStatus.PICKED],
      };
    }

    const updated = await this.aiccHandoffModel
      .findOneAndUpdate(filter, { $set: update }, { new: true })
      .exec();

    if (!updated) {
      throw new BadRequestException(
        "Handoff AICC đã được xử lý bởi người khác hoặc không còn hợp lệ"
      );
    }

    const response = this.toHandoffResponse(updated);
    if (response.status === AiccHandoffStatus.PICKED) {
      this.aiccGateway.emitHandoffPicked(response);
    }
    if (response.status === AiccHandoffStatus.RESOLVED) {
      this.aiccGateway.emitHandoffResolved(response);
    }

    return response;
  }

  async createKnowledge(
    dto: CreateAiccKnowledgeDto,
    admin?: JwtPayload | null
  ): Promise<AiccKnowledgeResponse> {
    const [knowledge] = await this.aiccKnowledgeModel.create([
      {
        title: dto.title.trim(),
        category: dto.category,
        content: dto.content.trim(),
        status: dto.status ?? AiccKnowledgeStatus.DRAFT,
        version: dto.version ?? 1,
        effectiveFrom: dto.effectiveFrom
          ? new Date(dto.effectiveFrom)
          : undefined,
        updatedBy: this.getUserObjectId(admin),
        metadata: this.sanitizeMetadata(dto.metadata),
      },
    ]);

    this.logger.log(`AICC KB created: id=${knowledge._id?.toString()}`);

    return this.toKnowledgeResponse(knowledge);
  }

  async listKnowledge(
    query: QueryAiccKnowledgeDto
  ): Promise<AiccKnowledgeListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const search = query.search?.trim();
    const filter: FilterQuery<AiccKnowledge> = {};

    if (query.category) {
      filter.category = query.category;
    }
    if (query.status) {
      filter.status = query.status;
    }
    if (search) {
      filter.$text = { $search: search };
    }

    const sort: Partial<
      Record<"score" | "updatedAt", SortOrder | { $meta: "textScore" }>
    > = search ? { score: { $meta: "textScore" } } : { updatedAt: -1 };

    const [items, total] = await Promise.all([
      this.aiccKnowledgeModel
        .find(filter, search ? { score: { $meta: "textScore" } } : undefined)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean<AiccKnowledgeView[]>()
        .exec(),
      this.aiccKnowledgeModel.countDocuments(filter).exec(),
    ]);

    return this.knowledgeListResponse(items, page, limit, total);
  }

  async getKnowledge(knowledgeId: string): Promise<AiccKnowledgeResponse> {
    const knowledge = await this.findKnowledgeOrThrow(knowledgeId);
    return this.toKnowledgeResponse(knowledge);
  }

  async updateKnowledge(
    knowledgeId: string,
    dto: UpdateAiccKnowledgeDto,
    admin?: JwtPayload | null
  ): Promise<AiccKnowledgeResponse> {
    const existing = await this.findKnowledgeOrThrow(knowledgeId);
    const update: Partial<AiccKnowledge> = {
      updatedBy: this.getUserObjectId(admin),
    };

    if (dto.title !== undefined) {
      update.title = dto.title.trim();
    }
    if (dto.category !== undefined) {
      update.category = dto.category;
    }
    if (dto.content !== undefined) {
      update.content = dto.content.trim();
      update.version = dto.version ?? existing.version + 1;
    } else if (dto.version !== undefined) {
      update.version = dto.version;
    }
    if (dto.status !== undefined) {
      update.status = dto.status;
    }
    if (dto.effectiveFrom !== undefined) {
      update.effectiveFrom = new Date(dto.effectiveFrom);
    }
    if (dto.metadata !== undefined) {
      update.metadata = this.sanitizeMetadata(dto.metadata);
    }

    const updated = await this.aiccKnowledgeModel.findByIdAndUpdate(
      knowledgeId,
      { $set: update },
      { new: true }
    );

    if (!updated) {
      throw new NotFoundException("Không tìm thấy tài liệu KB AICC");
    }

    return this.toKnowledgeResponse(updated);
  }

  async archiveKnowledge(
    knowledgeId: string,
    admin?: JwtPayload | null
  ): Promise<AiccKnowledgeResponse> {
    await this.findKnowledgeOrThrow(knowledgeId);
    const updated = await this.aiccKnowledgeModel.findByIdAndUpdate(
      knowledgeId,
      {
        $set: {
          status: AiccKnowledgeStatus.ARCHIVED,
          updatedBy: this.getUserObjectId(admin),
        },
      },
      { new: true }
    );

    if (!updated) {
      throw new NotFoundException("Không tìm thấy tài liệu KB AICC");
    }

    return this.toKnowledgeResponse(updated);
  }

  async searchKnowledge(
    dto: SearchAiccKnowledgeDto
  ): Promise<KnowledgeSearchResult> {
    const result = await this.knowledgeTool.searchKnowledge({
      query: dto.query,
      category: dto.category,
      topK: dto.topK,
    });

    return result;
  }

  private async findSessionOrThrow(
    sessionId: string
  ): Promise<AiccSessionDocument> {
    const session = await this.aiccSessionModel.findOne({ sessionId }).exec();
    if (!session) {
      throw new NotFoundException("Không tìm thấy phiên AICC");
    }
    return session;
  }

  private async findHandoffOrThrow(
    handoffId: string
  ): Promise<AiccHandoffDocument> {
    if (!Types.ObjectId.isValid(handoffId)) {
      throw new BadRequestException("ID handoff không hợp lệ");
    }

    const handoff = await this.aiccHandoffModel.findById(handoffId).exec();
    if (!handoff) {
      throw new NotFoundException("Không tìm thấy handoff AICC");
    }
    return handoff;
  }

  private async findKnowledgeOrThrow(
    knowledgeId: string
  ): Promise<AiccKnowledgeDocument> {
    if (!Types.ObjectId.isValid(knowledgeId)) {
      throw new BadRequestException("ID tài liệu KB không hợp lệ");
    }

    const knowledge = await this.aiccKnowledgeModel
      .findById(knowledgeId)
      .exec();
    if (!knowledge) {
      throw new NotFoundException("Không tìm thấy tài liệu KB AICC");
    }
    return knowledge;
  }

  private async getSessionUnavailableException(
    sessionId: string
  ): Promise<NotFoundException | BadRequestException> {
    const existing = await this.aiccSessionModel
      .findOne({ sessionId })
      .select("status")
      .lean()
      .exec();

    if (!existing) {
      return new NotFoundException("Không tìm thấy phiên AICC");
    }

    return new BadRequestException(
      `Phiên AICC không còn hoạt động: ${existing.status}`
    );
  }

  private assertSessionAccess(
    session: AiccSessionDocument,
    user?: JwtPayload | null
  ): void {
    if (!session.userId) {
      return;
    }

    if (!user?.userId) {
      throw new ForbiddenException(
        "Bạn không có quyền truy cập phiên AICC này"
      );
    }

    if (session.userId.toString() !== user.userId) {
      throw new ForbiddenException(
        "Bạn không có quyền truy cập phiên AICC này"
      );
    }
  }

  private getUserObjectId(
    user?: JwtPayload | null
  ): Types.ObjectId | undefined {
    if (!user?.userId) {
      return undefined;
    }

    if (!Types.ObjectId.isValid(user.userId)) {
      this.logger.warn(`Invalid JWT userId for AICC session: ${user.userId}`);
      return undefined;
    }

    return new Types.ObjectId(user.userId);
  }

  private sanitizeMetadata(
    metadata?: Record<string, unknown>
  ): Record<string, unknown> {
    if (!metadata) {
      return {};
    }

    const serialized = JSON.stringify(metadata);
    if (serialized.length > MAX_SERIALIZED_METADATA_LENGTH) {
      throw new BadRequestException("Metadata vượt quá giới hạn cho phép");
    }

    return metadata;
  }

  private generateSessionId(): string {
    return `aicc_${randomUUID()}`;
  }

  private mapEndReasonToStatus(
    reason?: EndAiccSessionReason
  ): AiccSessionStatus {
    if (reason === EndAiccSessionReason.ABANDONED) {
      return AiccSessionStatus.ABANDONED;
    }
    if (reason === EndAiccSessionReason.HANDOFF) {
      return AiccSessionStatus.HANDOFF;
    }
    return AiccSessionStatus.COMPLETED;
  }

  private toSessionResponse(session: AiccSessionDocument): AiccSessionResponse {
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

  private toHandoffResponse(
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

  private toKnowledgeResponse(
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

  private toTranscriptResponse(message: AiccMessage): AiccTranscriptResponse {
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

  private resolveAnalyticsRange(
    query: QueryAiccAnalyticsDto
  ): AiccAnalyticsRange {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 6 * 24 * 60 * 60 * 1000);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException("Khoảng ngày analytics không hợp lệ");
    }

    const normalizedFrom = new Date(from);
    normalizedFrom.setHours(0, 0, 0, 0);
    const normalizedTo = new Date(to);
    normalizedTo.setHours(23, 59, 59, 999);

    if (normalizedFrom > normalizedTo) {
      throw new BadRequestException("Ngày bắt đầu phải trước ngày kết thúc");
    }

    const rangeDays =
      (normalizedTo.getTime() - normalizedFrom.getTime()) /
      (24 * 60 * 60 * 1000);
    if (rangeDays > MAX_ANALYTICS_RANGE_DAYS) {
      throw new BadRequestException(
        `Analytics chỉ hỗ trợ tối đa ${MAX_ANALYTICS_RANGE_DAYS} ngày mỗi lần`
      );
    }

    return {
      from: normalizedFrom,
      to: normalizedTo,
      channel: query.channel ?? "all",
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

  private extractKnowledgeTrace(
    toolCalls: AiccExecutedToolCall[]
  ): Record<string, unknown> {
    const knowledgeDocIds: string[] = [];
    const knowledgeVersions: number[] = [];

    for (const call of toolCalls) {
      const result = call.result as Partial<KnowledgeSearchResult>;
      if (!Array.isArray(result.documents)) {
        continue;
      }

      for (const document of result.documents) {
        if (document.id) {
          knowledgeDocIds.push(document.id);
        }
        if (typeof document.version === "number") {
          knowledgeVersions.push(document.version);
        }
      }
    }

    if (knowledgeDocIds.length === 0) {
      return {};
    }

    return {
      knowledgeDocIds,
      knowledgeVersions,
    };
  }

  private getUnknownIntentCount(metadata?: Record<string, unknown>): number {
    const value = metadata?.unknownIntentCount;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
}
