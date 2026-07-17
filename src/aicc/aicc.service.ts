import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
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
import { AiccToolCall } from "./schemas/aicc-tool-call.schema";
import { AiccHandoff, AiccHandoffStatus } from "./schemas/aicc-handoff.schema";
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
import {
  AiccAnalyticsRange,
  AiccHandoffAnalyticsLean,
  AiccMessageAnalyticsLean,
  AiccPresenter,
  AiccSessionAnalyticsLean,
  AiccToolCallAnalyticsLean,
} from "./presenters/aicc.presenter";
import { AiccKnowledgeService } from "./application/aicc-knowledge.service";
import { AiccHandoffService } from "./application/aicc-handoff.service";

const MAX_SERIALIZED_METADATA_LENGTH = 8000;
const MAX_ANALYTICS_RANGE_DAYS = 31;

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
    private readonly orchestrator: AiccOrchestratorService,
    private readonly aiccKnowledgeService: AiccKnowledgeService,
    private readonly aiccHandoffService: AiccHandoffService,
    private readonly presenter: AiccPresenter,
    private readonly aiccGateway: AiccGateway
  ) {}

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

    return this.presenter.toSessionResponse(session);
  }

  async getSession(
    sessionId: string,
    user?: JwtPayload | null
  ): Promise<AiccSessionResponse> {
    const session = await this.findSessionOrThrow(sessionId);
    this.assertSessionAccess(session, user);

    return this.presenter.toSessionResponse(session);
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
          handoffResponse = this.presenter.toHandoffResponse(handoff);
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
      return this.presenter.toSessionResponse(existing);
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
      return this.presenter.toSessionResponse(latest);
    }

    this.logger.log(`AICC session ended: ${sessionId}, status=${status}`);

    return this.presenter.toSessionResponse(ended);
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

    return this.presenter.toTranscriptResponse(message);
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

    return this.presenter.analyticsDashboardResponse(
      range,
      sessionRows,
      messageRows,
      toolRows,
      handoffRows
    );
  }

  async createHandoff(dto: CreateAiccHandoffDto): Promise<AiccHandoffResponse> {
    return this.aiccHandoffService.createHandoff(dto);
  }

  async listHandoffs(
    query: QueryAiccHandoffDto
  ): Promise<AiccHandoffListResponse> {
    return this.aiccHandoffService.listHandoffs(query);
  }

  async getHandoff(handoffId: string): Promise<AiccHandoffResponse> {
    return this.aiccHandoffService.getHandoff(handoffId);
  }

  async updateHandoff(
    handoffId: string,
    dto: UpdateAiccHandoffDto,
    admin?: JwtPayload | null
  ): Promise<AiccHandoffResponse> {
    return this.aiccHandoffService.updateHandoff(handoffId, dto, admin);
  }

  async createKnowledge(
    dto: CreateAiccKnowledgeDto,
    admin?: JwtPayload | null
  ): Promise<AiccKnowledgeResponse> {
    return this.aiccKnowledgeService.createKnowledge(dto, admin);
  }

  async listKnowledge(
    query: QueryAiccKnowledgeDto
  ): Promise<AiccKnowledgeListResponse> {
    return this.aiccKnowledgeService.listKnowledge(query);
  }

  async getKnowledge(knowledgeId: string): Promise<AiccKnowledgeResponse> {
    return this.aiccKnowledgeService.getKnowledge(knowledgeId);
  }

  async updateKnowledge(
    knowledgeId: string,
    dto: UpdateAiccKnowledgeDto,
    admin?: JwtPayload | null
  ): Promise<AiccKnowledgeResponse> {
    return this.aiccKnowledgeService.updateKnowledge(knowledgeId, dto, admin);
  }

  async archiveKnowledge(
    knowledgeId: string,
    admin?: JwtPayload | null
  ): Promise<AiccKnowledgeResponse> {
    return this.aiccKnowledgeService.archiveKnowledge(knowledgeId, admin);
  }

  async searchKnowledge(
    dto: SearchAiccKnowledgeDto
  ): Promise<KnowledgeSearchResult> {
    return this.aiccKnowledgeService.searchKnowledge(dto);
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
