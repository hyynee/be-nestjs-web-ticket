import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { FilterQuery, Model, Types } from "mongoose";
import { AiccHandoffListResponse, AiccHandoffResponse } from "../aicc.types";
import { AiccGateway } from "../aicc.gateway";
import { CreateAiccHandoffDto } from "../dto/create-aicc-handoff.dto";
import { QueryAiccHandoffDto } from "../dto/query-aicc-handoff.dto";
import { UpdateAiccHandoffDto } from "../dto/update-aicc-handoff.dto";
import { AiccHandoffView, AiccPresenter } from "../presenters/aicc.presenter";
import {
  AiccHandoff,
  AiccHandoffDocument,
  AiccHandoffPriority,
  AiccHandoffStatus,
} from "../schemas/aicc-handoff.schema";
import {
  AiccOutcome,
  AiccSession,
  AiccSessionDocument,
  AiccSessionPhase,
  AiccSessionStatus,
} from "../schemas/aicc-session.schema";

const MAX_SERIALIZED_METADATA_LENGTH = 8000;

@Injectable()
export class AiccHandoffService {
  constructor(
    @InjectModel(AiccSession.name)
    private readonly aiccSessionModel: Model<AiccSession>,
    @InjectModel(AiccHandoff.name)
    private readonly aiccHandoffModel: Model<AiccHandoff>,
    private readonly presenter: AiccPresenter,
    private readonly aiccGateway: AiccGateway
  ) {}

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

    const response = this.presenter.toHandoffResponse(handoff);
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

    return this.presenter.handoffListResponse(items, page, limit, total);
  }

  async getHandoff(handoffId: string): Promise<AiccHandoffResponse> {
    const handoff = await this.findHandoffOrThrow(handoffId);
    return this.presenter.toHandoffResponse(handoff);
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

    const response = this.presenter.toHandoffResponse(updated);
    if (response.status === AiccHandoffStatus.PICKED) {
      this.aiccGateway.emitHandoffPicked(response);
    }
    if (response.status === AiccHandoffStatus.RESOLVED) {
      this.aiccGateway.emitHandoffResolved(response);
    }

    return response;
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
}
