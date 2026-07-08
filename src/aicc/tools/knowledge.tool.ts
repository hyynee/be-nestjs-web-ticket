import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model } from "mongoose";
import {
  AiccKnowledge,
  AiccKnowledgeCategory,
  AiccKnowledgeStatus,
} from "../schemas/aicc-knowledge.schema";
import {
  KnowledgeDocumentSummary,
  KnowledgeSearchArgs,
  KnowledgeSearchResult,
} from "./aicc-tool.types";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;
const SNIPPET_LENGTH = 360;

interface ScoredKnowledgeDocument {
  _id: unknown;
  title: string;
  category: AiccKnowledgeCategory;
  content: string;
  version: number;
  score?: number;
}

@Injectable()
export class AiccKnowledgeTool {
  private readonly logger = new Logger(AiccKnowledgeTool.name);

  constructor(
    @InjectModel(AiccKnowledge.name)
    private readonly knowledgeModel: Model<AiccKnowledge>
  ) {}

  async searchKnowledge(
    args: KnowledgeSearchArgs
  ): Promise<KnowledgeSearchResult> {
    const query = args.query.trim();
    const topK = Math.min(Math.max(args.topK ?? DEFAULT_TOP_K, 1), MAX_TOP_K);
    const now = new Date();
    const filter: FilterQuery<AiccKnowledge> = {
      status: AiccKnowledgeStatus.ACTIVE,
      $or: [
        { effectiveFrom: { $exists: false } },
        { effectiveFrom: { $lte: now } },
      ],
    };

    if (args.category) {
      filter.category = args.category;
    }

    if (query.length >= 2) {
      filter.$text = { $search: query };
    }

    try {
      const projection =
        query.length >= 2 ? { score: { $meta: "textScore" } } : undefined;

      const documents = await this.knowledgeModel
        .find(filter, projection)
        .sort(
          query.length >= 2
            ? { score: { $meta: "textScore" } }
            : { updatedAt: -1 }
        )
        .limit(topK)
        .lean<ScoredKnowledgeDocument[]>()
        .exec();

      return {
        documents: documents.map((document) => this.toSummary(document, query)),
        belowThreshold: documents.length === 0,
      };
    } catch (error) {
      this.logger.error(
        `AICC knowledge search failed: ${(error as Error).message}`,
        (error as Error).stack
      );
      throw error;
    }
  }

  private toSummary(
    document: ScoredKnowledgeDocument,
    query: string
  ): KnowledgeDocumentSummary {
    return {
      id: document._id?.toString() ?? "",
      title: document.title,
      category: document.category,
      version: document.version,
      contentSnippet: this.buildSnippet(document.content, query),
      score: document.score,
    };
  }

  private buildSnippet(content: string, query: string): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    if (normalized.length <= SNIPPET_LENGTH) {
      return normalized;
    }

    const keyword = query
      .split(/\s+/)
      .find((part) => part.length >= 4)
      ?.toLowerCase();
    const lowerContent = normalized.toLowerCase();
    const hitIndex = keyword ? lowerContent.indexOf(keyword) : -1;
    const start = hitIndex > 80 ? hitIndex - 80 : 0;
    const snippet = normalized.slice(start, start + SNIPPET_LENGTH).trim();

    return `${start > 0 ? "... " : ""}${snippet}${
      start + SNIPPET_LENGTH < normalized.length ? " ..." : ""
    }`;
  }
}
