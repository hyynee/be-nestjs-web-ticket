import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, SortOrder, Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CreateAiccKnowledgeDto } from "../dto/create-aicc-knowledge.dto";
import { UpdateAiccKnowledgeDto } from "../dto/update-aicc-knowledge.dto";
import {
  QueryAiccKnowledgeDto,
  SearchAiccKnowledgeDto,
} from "../dto/query-aicc-knowledge.dto";
import {
  AiccKnowledge,
  AiccKnowledgeDocument,
  AiccKnowledgeStatus,
} from "../schemas/aicc-knowledge.schema";
import {
  AiccKnowledgeListResponse,
  AiccKnowledgeResponse,
} from "../aicc.types";
import { KnowledgeSearchResult } from "../tools/aicc-tool.types";
import { AiccKnowledgeTool } from "../tools/knowledge.tool";
import { AiccKnowledgeView, AiccPresenter } from "../presenters/aicc.presenter";

const MAX_SERIALIZED_METADATA_LENGTH = 8000;

@Injectable()
export class AiccKnowledgeService {
  private readonly logger = new Logger(AiccKnowledgeService.name);

  constructor(
    @InjectModel(AiccKnowledge.name)
    private readonly aiccKnowledgeModel: Model<AiccKnowledge>,
    private readonly knowledgeTool: AiccKnowledgeTool,
    private readonly presenter: AiccPresenter
  ) {}

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

    return this.presenter.toKnowledgeResponse(knowledge);
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

    return this.presenter.knowledgeListResponse(items, page, limit, total);
  }

  async getKnowledge(knowledgeId: string): Promise<AiccKnowledgeResponse> {
    const knowledge = await this.findKnowledgeOrThrow(knowledgeId);
    return this.presenter.toKnowledgeResponse(knowledge);
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

    return this.presenter.toKnowledgeResponse(updated);
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

    return this.presenter.toKnowledgeResponse(updated);
  }

  async searchKnowledge(
    dto: SearchAiccKnowledgeDto
  ): Promise<KnowledgeSearchResult> {
    return this.knowledgeTool.searchKnowledge({
      query: dto.query,
      category: dto.category,
      topK: dto.topK,
    });
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

  private getUserObjectId(
    user?: JwtPayload | null
  ): Types.ObjectId | undefined {
    if (!user?.userId) {
      return undefined;
    }

    if (!Types.ObjectId.isValid(user.userId)) {
      this.logger.warn(`Invalid JWT userId for AICC KB update: ${user.userId}`);
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
}
