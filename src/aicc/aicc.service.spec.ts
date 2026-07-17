import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Model, Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AiccService } from "./aicc.service";
import { AiccOrchestratorService } from "./orchestrator/aicc-orchestrator.service";
import { AiccIntent } from "./orchestrator/aicc-intents";
import {
  AiccChannel,
  AiccOutcome,
  AiccSession,
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
  AiccHandoffPriority,
  AiccHandoffReason,
  AiccHandoffStatus,
} from "./schemas/aicc-handoff.schema";
import {
  AiccKnowledge,
  AiccKnowledgeCategory,
  AiccKnowledgeStatus,
} from "./schemas/aicc-knowledge.schema";
import { AiccToolName } from "./tools/aicc-tool.types";
import { AiccKnowledgeTool } from "./tools/knowledge.tool";
import { AiccGateway } from "./aicc.gateway";
import { AiccPresenter } from "./presenters/aicc.presenter";
import { AiccKnowledgeService } from "./application/aicc-knowledge.service";
import { AiccHandoffService } from "./application/aicc-handoff.service";

type SessionRecord = AiccSession & {
  createdAt?: Date;
  updatedAt?: Date;
};

type MessageRecord = AiccMessage & {
  createdAt?: Date;
  updatedAt?: Date;
};

type ToolCallRecord = AiccToolCall & {
  createdAt?: Date;
  updatedAt?: Date;
};

type HandoffRecord = AiccHandoff & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

type KnowledgeRecord = AiccKnowledge & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

interface QueryMock<T> {
  exec: () => Promise<T>;
  lean: () => QueryMock<T>;
  select: () => QueryMock<T>;
}

function createQueryMock<T>(value: T): QueryMock<T> {
  return {
    exec: () => Promise.resolve(value),
    lean: () => createQueryMock(value),
    select: () => createQueryMock(value),
  };
}

function createCollectionQueryMock<T>(items: T[]) {
  return {
    exec: () => Promise.resolve(items),
    lean: () => createCollectionQueryMock(items),
    select: () => createCollectionQueryMock(items),
    sort: () => createCollectionQueryMock(items),
    skip: (count: number) => createCollectionQueryMock(items.slice(count)),
    limit: (count: number) => createCollectionQueryMock(items.slice(0, count)),
    populate: () => createCollectionQueryMock(items),
  };
}

function matchesFilter<T extends Record<string, unknown>>(
  record: T,
  filter?: Record<string, unknown>
): boolean {
  if (!filter) {
    return true;
  }

  for (const [key, expected] of Object.entries(filter)) {
    const actual = record[key];
    if (expected && typeof expected === "object") {
      const expectedRecord = expected as Record<string, unknown>;
      if ("$gte" in expectedRecord || "$lte" in expectedRecord) {
        const actualTime =
          actual instanceof Date
            ? actual.getTime()
            : new Date(String(actual)).getTime();
        const gte = expectedRecord.$gte as Date | undefined;
        const lte = expectedRecord.$lte as Date | undefined;
        if (gte && actualTime < gte.getTime()) {
          return false;
        }
        if (lte && actualTime > lte.getTime()) {
          return false;
        }
        continue;
      }
      if ("$in" in expectedRecord) {
        const values = expectedRecord.$in as unknown[];
        if (!values.some((value) => value?.toString() === actual?.toString())) {
          return false;
        }
        continue;
      }
    }

    if (actual?.toString() !== expected?.toString()) {
      return false;
    }
  }

  return true;
}

function cloneSession(session: SessionRecord): SessionRecord {
  return {
    ...session,
    metadata: { ...session.metadata },
    userId: session.userId ? new Types.ObjectId(session.userId) : undefined,
  };
}

describe("AiccService", () => {
  let service: AiccService;
  let sessions: Map<string, SessionRecord>;
  let messages: MessageRecord[];
  let toolCalls: ToolCallRecord[];
  let handoffs: Map<string, HandoffRecord>;
  let knowledgeItems: Map<string, KnowledgeRecord>;
  let orchestrator: { handleMessage: jest.Mock };
  let knowledgeTool: { searchKnowledge: jest.Mock };
  let gateway: {
    emitHandoffCreated: jest.Mock;
    emitHandoffPicked: jest.Mock;
    emitHandoffResolved: jest.Mock;
    emitSessionUpdated: jest.Mock;
  };

  beforeEach(() => {
    sessions = new Map<string, SessionRecord>();
    messages = [];
    toolCalls = [];
    handoffs = new Map<string, HandoffRecord>();
    knowledgeItems = new Map<string, KnowledgeRecord>();
    orchestrator = {
      handleMessage: jest.fn(
        async (input: { sessionId: string; turnNo: number }) => ({
          intent: AiccIntent.BOOKING_LOOKUP,
          phase: AiccSessionPhase.EXECUTING,
          outcome: AiccOutcome.BOOKING_SUPPORT,
          reply: "Booking BK202607060001 đang ở trạng thái pending.",
          entities: { bookingCode: "BK202607060001" },
          toolCalls: [
            {
              sessionId: input.sessionId,
              turnNo: input.turnNo,
              toolName: AiccToolName.LOOKUP_BOOKING,
              args: { bookingCode: "BK202607060001" },
              result: { found: true },
              status: AiccToolCallStatus.SUCCESS,
              durationMs: 5,
            },
          ],
        })
      ),
    };
    gateway = {
      emitHandoffCreated: jest.fn(),
      emitHandoffPicked: jest.fn(),
      emitHandoffResolved: jest.fn(),
      emitSessionUpdated: jest.fn(),
    };
    knowledgeTool = {
      searchKnowledge: jest.fn().mockResolvedValue({
        documents: [],
        belowThreshold: true,
      }),
    };

    const transactionSession = {
      withTransaction: async (callback: () => Promise<void>) => callback(),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    const sessionModel = {
      db: {
        startSession: jest.fn().mockResolvedValue(transactionSession),
      },
      create: jest.fn(
        async (input: Partial<SessionRecord>): Promise<SessionRecord> => {
          const now = new Date();
          const record: SessionRecord = {
            sessionId: input.sessionId ?? "aicc_test",
            channel: input.channel ?? AiccChannel.CHAT,
            userId: input.userId,
            customerEmail: input.customerEmail,
            customerPhone: input.customerPhone,
            status: input.status ?? AiccSessionStatus.ACTIVE,
            currentIntent: input.currentIntent,
            phase: input.phase ?? AiccSessionPhase.GREETING,
            summary: input.summary,
            outcome: input.outcome,
            metadata: input.metadata ?? {},
            nextTurnNo: input.nextTurnNo ?? 1,
            startedAt: input.startedAt ?? now,
            endedAt: input.endedAt,
            createdAt: now,
            updatedAt: now,
          };
          sessions.set(record.sessionId, record);
          return cloneSession(record);
        }
      ),
      findOne: jest.fn((filter: { sessionId: string }) => {
        const found = sessions.get(filter.sessionId);
        return createQueryMock(found ? cloneSession(found) : null);
      }),
      find: jest.fn((filter?: Record<string, unknown>) =>
        createCollectionQueryMock(
          [...sessions.values()].filter((session) =>
            matchesFilter(session as unknown as Record<string, unknown>, filter)
          )
        )
      ),
      findOneAndUpdate: jest.fn(
        async (
          filter: {
            sessionId: string;
            status?: AiccSessionStatus | { $in: AiccSessionStatus[] };
          },
          update: {
            $inc?: { nextTurnNo?: number };
            $set?: Partial<SessionRecord>;
          },
          options?: { new?: boolean }
        ): Promise<SessionRecord | null> => {
          const current = sessions.get(filter.sessionId);
          if (!current) {
            return null;
          }
          if (filter.status) {
            if (
              typeof filter.status === "object" &&
              "$in" in filter.status &&
              !filter.status.$in.includes(current.status)
            ) {
              return null;
            }
            if (
              typeof filter.status === "string" &&
              current.status !== filter.status
            ) {
              return null;
            }
          }

          const before = cloneSession(current);
          if (update.$inc?.nextTurnNo) {
            current.nextTurnNo += update.$inc.nextTurnNo;
          }
          if (update.$set) {
            Object.assign(current, update.$set, { updatedAt: new Date() });
          }

          return options?.new ? cloneSession(current) : before;
        }
      ),
      updateOne: jest.fn(
        async (
          filter: { sessionId: string },
          update: { $set?: Partial<SessionRecord> }
        ) => {
          const current = sessions.get(filter.sessionId);
          if (current && update.$set) {
            Object.assign(current, update.$set, { updatedAt: new Date() });
          }
          return { acknowledged: true, modifiedCount: current ? 1 : 0 };
        }
      ),
    };

    const messageModel = {
      create: jest.fn(
        async (records: MessageRecord[]): Promise<MessageRecord[]> => {
          const created = records.map((record) => ({
            ...record,
            createdAt: record.createdAt ?? new Date(),
            updatedAt: record.updatedAt ?? new Date(),
          }));
          messages.push(...created);
          return created;
        }
      ),
      find: jest.fn((filter?: Record<string, unknown>) =>
        createCollectionQueryMock(
          messages.filter((message) =>
            matchesFilter(message as unknown as Record<string, unknown>, filter)
          )
        )
      ),
    };

    const toolCallModel = {
      create: jest.fn(
        async (records: ToolCallRecord[]): Promise<ToolCallRecord[]> => {
          const created = records.map((record) => ({
            ...record,
            createdAt: record.createdAt ?? new Date(),
            updatedAt: record.updatedAt ?? new Date(),
          }));
          toolCalls.push(...created);
          return created;
        }
      ),
      find: jest.fn((filter?: Record<string, unknown>) =>
        createCollectionQueryMock(
          toolCalls.filter((toolCall) =>
            matchesFilter(
              toolCall as unknown as Record<string, unknown>,
              filter
            )
          )
        )
      ),
    };

    const handoffModel = {
      create: jest.fn(async (records: Array<Partial<HandoffRecord>>) =>
        records.map((record) => {
          const now = new Date();
          const handoff: HandoffRecord = {
            _id: new Types.ObjectId(),
            sessionId: record.sessionId!,
            userId: record.userId,
            customerEmail: record.customerEmail,
            customerPhone: record.customerPhone,
            reason: record.reason!,
            priority: record.priority ?? AiccHandoffPriority.NORMAL,
            summary: record.summary!,
            status: record.status ?? AiccHandoffStatus.OPEN,
            assignedTo: record.assignedTo,
            pickedAt: record.pickedAt,
            resolvedAt: record.resolvedAt,
            resolutionNote: record.resolutionNote,
            metadata: record.metadata ?? {},
            createdAt: now,
            updatedAt: now,
          };
          handoffs.set(handoff._id.toString(), handoff);
          return handoff;
        })
      ),
      findById: jest.fn((id: string) =>
        createQueryMock(handoffs.get(id) ?? null)
      ),
      findByIdAndUpdate: jest.fn(
        async (
          id: string,
          update: { $set?: Partial<HandoffRecord> },
          options?: { new?: boolean }
        ) => {
          void options;
          const current = handoffs.get(id);
          if (!current) {
            return null;
          }
          if (update.$set) {
            Object.assign(current, update.$set, { updatedAt: new Date() });
          }
          return current;
        }
      ),
      findOneAndUpdate: jest.fn(
        (
          filter: {
            _id: Types.ObjectId;
            status?: AiccHandoffStatus | { $in: AiccHandoffStatus[] };
            assignedTo?: { $exists: boolean };
          },
          update: { $set?: Partial<HandoffRecord> },
          options?: { new?: boolean }
        ) => {
          void options;
          const current = handoffs.get(filter._id.toString());
          if (!current) {
            return createQueryMock(null);
          }

          if (filter.status) {
            if (
              typeof filter.status === "object" &&
              "$in" in filter.status &&
              !filter.status.$in.includes(current.status)
            ) {
              return createQueryMock(null);
            }
            if (
              typeof filter.status === "string" &&
              current.status !== filter.status
            ) {
              return createQueryMock(null);
            }
          }

          if (
            filter.assignedTo?.$exists === false &&
            current.assignedTo !== undefined
          ) {
            return createQueryMock(null);
          }

          if (update.$set) {
            Object.assign(current, update.$set, { updatedAt: new Date() });
          }
          return createQueryMock(current);
        }
      ),
      find: jest.fn((filter?: Record<string, unknown>) =>
        createCollectionQueryMock(
          [...handoffs.values()].filter((handoff) =>
            matchesFilter(handoff as unknown as Record<string, unknown>, filter)
          )
        )
      ),
      countDocuments: jest.fn(() => ({
        exec: () => Promise.resolve(handoffs.size),
      })),
    };

    const knowledgeModel = {
      create: jest.fn(async (records: Array<Partial<KnowledgeRecord>>) =>
        records.map((record) => {
          const now = new Date();
          const knowledge: KnowledgeRecord = {
            _id: new Types.ObjectId(),
            title: record.title!,
            category: record.category!,
            content: record.content!,
            status: record.status ?? AiccKnowledgeStatus.DRAFT,
            version: record.version ?? 1,
            effectiveFrom: record.effectiveFrom,
            updatedBy: record.updatedBy,
            metadata: record.metadata ?? {},
            createdAt: now,
            updatedAt: now,
          };
          knowledgeItems.set(knowledge._id.toString(), knowledge);
          return knowledge;
        })
      ),
      findById: jest.fn((id: string) =>
        createQueryMock(knowledgeItems.get(id) ?? null)
      ),
      findByIdAndUpdate: jest.fn(
        async (
          id: string,
          update: { $set?: Partial<KnowledgeRecord> },
          options?: { new?: boolean }
        ) => {
          void options;
          const current = knowledgeItems.get(id);
          if (!current) {
            return null;
          }
          if (update.$set) {
            Object.assign(current, update.$set, { updatedAt: new Date() });
          }
          return current;
        }
      ),
      find: jest.fn((filter?: Record<string, unknown>) =>
        createCollectionQueryMock(
          [...knowledgeItems.values()].filter((knowledge) =>
            matchesFilter(
              knowledge as unknown as Record<string, unknown>,
              filter
            )
          )
        )
      ),
      countDocuments: jest.fn(() => ({
        exec: () => Promise.resolve(knowledgeItems.size),
      })),
    };

    const presenter = new AiccPresenter();
    const aiccKnowledgeService = new AiccKnowledgeService(
      knowledgeModel as unknown as Model<AiccKnowledge>,
      knowledgeTool as unknown as AiccKnowledgeTool,
      presenter
    );
    const aiccHandoffService = new AiccHandoffService(
      sessionModel as unknown as Model<AiccSession>,
      handoffModel as unknown as Model<AiccHandoff>,
      presenter,
      gateway as unknown as AiccGateway
    );

    service = new AiccService(
      sessionModel as unknown as Model<AiccSession>,
      messageModel as unknown as Model<AiccMessage>,
      toolCallModel as unknown as Model<AiccToolCall>,
      handoffModel as unknown as Model<AiccHandoff>,
      orchestrator as unknown as AiccOrchestratorService,
      aiccKnowledgeService,
      aiccHandoffService,
      presenter,
      gateway as unknown as AiccGateway
    );
  });

  it("creates an active chat session", async () => {
    const result = await service.createSession(
      { channel: AiccChannel.CHAT, customerEmail: "USER@EXAMPLE.COM" },
      null
    );

    expect(result.status).toBe(AiccSessionStatus.ACTIVE);
    expect(result.phase).toBe(AiccSessionPhase.GREETING);
    expect(sessions.get(result.sessionId)?.customerEmail).toBe(
      "user@example.com"
    );
  });

  it("stores customer and AI messages in one turn pair", async () => {
    const created = await service.createSession({}, null);

    const result = await service.sendMessage(
      created.sessionId,
      { message: "Toi muon kiem tra booking BK123" },
      null
    );

    expect(result.intent).toBe("booking_lookup");
    expect(result.turnNo).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe(AiccToolName.LOOKUP_BOOKING);
    expect(messages[0].speaker).toBe(AiccMessageSpeaker.CUSTOMER);
    expect(messages[0].turnNo).toBe(1);
    expect(messages[1].speaker).toBe(AiccMessageSpeaker.AI);
    expect(sessions.get(created.sessionId)?.nextTurnNo).toBe(3);
    expect(sessions.get(created.sessionId)?.outcome).toBe(
      AiccOutcome.BOOKING_SUPPORT
    );
  });

  it("creates handoff from orchestrator and updates session", async () => {
    orchestrator.handleMessage.mockResolvedValueOnce({
      intent: AiccIntent.HUMAN_REQUEST,
      phase: AiccSessionPhase.COLLECTING,
      outcome: AiccOutcome.HANDOFF,
      reply: "Mình đã chuyển yêu cầu cho nhân viên.",
      entities: {},
      toolCalls: [],
      handoffRequest: {
        reason: AiccHandoffReason.HUMAN_REQUEST,
        priority: AiccHandoffPriority.NORMAL,
        summary:
          "Khách yêu cầu gặp nhân viên thật. Cần nhân viên tiếp nhận và hỗ trợ tiếp.",
        metadata: { source: "test" },
      },
    });
    const created = await service.createSession({}, null);

    const result = await service.sendMessage(
      created.sessionId,
      { message: "Toi muon gap nhan vien" },
      null
    );

    expect(result.handoff?.reason).toBe(AiccHandoffReason.HUMAN_REQUEST);
    expect(handoffs.size).toBe(1);
    expect(sessions.get(created.sessionId)?.status).toBe(
      AiccSessionStatus.HANDOFF
    );
    expect(sessions.get(created.sessionId)?.outcome).toBe(AiccOutcome.HANDOFF);
    expect(gateway.emitHandoffCreated).toHaveBeenCalledTimes(1);
    expect(gateway.emitSessionUpdated).toHaveBeenCalledWith(
      created.sessionId,
      AiccSessionStatus.HANDOFF
    );
  });

  it("stores knowledge document trace in AI message metadata", async () => {
    orchestrator.handleMessage.mockResolvedValueOnce({
      intent: AiccIntent.REFUND_POLICY,
      phase: AiccSessionPhase.EXECUTING,
      outcome: AiccOutcome.PAYMENT_SUPPORT,
      reply:
        'Theo tài liệu "Chính sách hoàn tiền" v2: Yêu cầu hoàn tiền cần admin kiểm tra.',
      entities: {},
      toolCalls: [
        {
          sessionId: "aicc_trace",
          turnNo: 1,
          toolName: AiccToolName.SEARCH_KNOWLEDGE,
          args: {
            query: "Toi co duoc hoan tien khong?",
            category: AiccKnowledgeCategory.REFUND_POLICY,
          },
          result: {
            documents: [
              {
                id: "507f1f77bcf86cd799439099",
                title: "Chính sách hoàn tiền",
                category: AiccKnowledgeCategory.REFUND_POLICY,
                version: 2,
                contentSnippet: "Yêu cầu hoàn tiền cần admin kiểm tra.",
              },
            ],
            belowThreshold: false,
          },
          status: AiccToolCallStatus.SUCCESS,
          durationMs: 3,
        },
      ],
    });
    const created = await service.createSession({}, null);

    await service.sendMessage(
      created.sessionId,
      { message: "Toi co duoc hoan tien khong?" },
      null
    );

    expect(messages[1].metadata).toMatchObject({
      knowledgeDocIds: ["507f1f77bcf86cd799439099"],
      knowledgeVersions: [2],
    });
  });

  it("updates handoff status and emits picked/resolved events", async () => {
    const created = await service.createSession({}, null);
    const handoff = await service.createHandoff({
      sessionId: created.sessionId,
      reason: AiccHandoffReason.PAYMENT_ISSUE,
      priority: AiccHandoffPriority.HIGH,
      summary:
        "Khách báo đã thanh toán nhưng booking vẫn unpaid. Cần admin kiểm tra giao dịch.",
    });

    const picked = await service.updateHandoff(
      handoff.id,
      { status: AiccHandoffStatus.PICKED },
      {
        userId: new Types.ObjectId().toString(),
        role: "admin",
        iat: 1,
        exp: 2,
      }
    );
    const resolved = await service.updateHandoff(handoff.id, {
      status: AiccHandoffStatus.RESOLVED,
      resolutionNote: "Đã gọi lại cho khách.",
    });

    expect(picked.status).toBe(AiccHandoffStatus.PICKED);
    expect(resolved.status).toBe(AiccHandoffStatus.RESOLVED);
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(gateway.emitHandoffPicked).toHaveBeenCalledTimes(1);
    expect(gateway.emitHandoffResolved).toHaveBeenCalledTimes(1);
  });

  it("manages knowledge base documents with versioning and soft archive", async () => {
    const admin: JwtPayload = {
      userId: new Types.ObjectId().toString(),
      role: "admin",
      iat: 1,
      exp: 2,
    };
    const created = await service.createKnowledge(
      {
        title: "Chính sách thanh toán",
        category: AiccKnowledgeCategory.PAYMENT_POLICY,
        content:
          "Sau khi thanh toán thành công, hệ thống sẽ ghi nhận giao dịch và phát hành vé theo trạng thái booking.",
        status: AiccKnowledgeStatus.ACTIVE,
      },
      admin
    );

    const updated = await service.updateKnowledge(
      created.id,
      {
        content:
          "Sau khi thanh toán thành công, khách cần kiểm tra email và mục vé của tài khoản để nhận QR.",
      },
      admin
    );
    const archived = await service.archiveKnowledge(created.id, admin);
    await service.searchKnowledge({
      query: "thanh toán xong nhận vé ở đâu",
      category: AiccKnowledgeCategory.PAYMENT_POLICY,
      topK: 3,
    });

    expect(created.status).toBe(AiccKnowledgeStatus.ACTIVE);
    expect(updated.version).toBe(2);
    expect(archived.status).toBe(AiccKnowledgeStatus.ARCHIVED);
    expect(knowledgeTool.searchKnowledge).toHaveBeenCalledWith({
      query: "thanh toán xong nhận vé ở đâu",
      category: AiccKnowledgeCategory.PAYMENT_POLICY,
      topK: 3,
    });
  });

  it("stores voice transcript with an internally reserved turn number", async () => {
    const created = await service.createSession(
      {
        channel: AiccChannel.VOICE,
        metadata: { telcoCallId: "call_001" },
      },
      null
    );

    const transcript = await service.createTranscript(
      created.sessionId,
      {
        turnNo: 12,
        speaker: AiccMessageSpeaker.CUSTOMER,
        text: "toi muon kiem tra booking",
        confidence: 0.91,
        startedMs: 41200,
        endedMs: 44100,
        sttLatencyMs: 180,
      },
      null
    );

    expect(transcript.turnNo).toBe(1);
    expect(transcript.metadata).toMatchObject({
      transcriptType: "voice_final_transcript",
      externalTurnNo: 12,
      sttLatencyMs: 180,
    });
    expect(sessions.get(created.sessionId)?.nextTurnNo).toBe(2);
  });

  it("builds AICC analytics dashboard metrics", async () => {
    const completed = await service.createSession({}, null);
    await service.sendMessage(
      completed.sessionId,
      { message: "Kiem tra booking BK202607060001" },
      null
    );
    await service.endSession(
      completed.sessionId,
      { reason: "completed" },
      null
    );

    const handoffSession = await service.createSession({}, null);
    const handoff = await service.createHandoff({
      sessionId: handoffSession.sessionId,
      reason: AiccHandoffReason.PAYMENT_ISSUE,
      priority: AiccHandoffPriority.HIGH,
      summary:
        "Khách báo đã thanh toán nhưng booking vẫn unpaid. Cần admin kiểm tra giao dịch.",
    });
    await service.updateHandoff(handoff.id, {
      status: AiccHandoffStatus.RESOLVED,
      resolutionNote: "Đã xử lý.",
    });

    const abandoned = await service.createSession({}, null);
    await service.endSession(
      abandoned.sessionId,
      { reason: "abandoned" },
      null
    );

    toolCalls.push({
      sessionId: completed.sessionId,
      turnNo: 99,
      toolName: AiccToolName.SEARCH_KNOWLEDGE,
      args: {},
      result: {},
      status: AiccToolCallStatus.FAILED,
      errorCode: "TEST_FAILURE",
      durationMs: 15,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const dashboard = await service.getAnalyticsDashboard({
      from: "2026-07-01",
      to: "2026-07-31",
      channel: "all",
    });

    expect(dashboard.sessions).toMatchObject({
      total: 3,
      completed: 1,
      handoff: 1,
      abandoned: 1,
    });
    expect(dashboard.containmentRate).toBe(0.3333);
    expect(dashboard.handoffRate).toBe(0.3333);
    expect(dashboard.topIntents[0]).toEqual(["booking_lookup", 1]);
    expect(dashboard.tools.totalCalls).toBe(2);
    expect(dashboard.tools.successRate).toBe(0.5);
    expect(dashboard.handoff.resolved).toBe(1);
    expect(dashboard.supportCounts.bookingSupport).toBe(1);
    expect(dashboard.supportCounts.paymentIssue).toBe(1);
  });

  it("rejects messages after a session ends", async () => {
    const created = await service.createSession({}, null);
    await service.endSession(created.sessionId, { reason: "completed" }, null);

    await expect(
      service.sendMessage(
        created.sessionId,
        { message: "Co su kien nao sap dien ra?" },
        null
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("prevents a different user from reading a user-owned session", async () => {
    const ownerId = new Types.ObjectId();
    const otherId = new Types.ObjectId();
    const owner: JwtPayload = {
      userId: ownerId.toString(),
      role: "user",
      iat: 1,
      exp: 2,
    };
    const other: JwtPayload = {
      userId: otherId.toString(),
      role: "user",
      iat: 1,
      exp: 2,
    };
    const created = await service.createSession({}, owner);

    await expect(
      service.getSession(created.sessionId, other)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
