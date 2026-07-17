import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CreateRefundRequestUseCase } from "./application/create-refund-request.use-case";
import { RefundQueryService } from "./application/refund-query.service";
import { ReviewRefundRequestUseCase } from "./application/review-refund-request.use-case";
import { CreateRefundRequestDto } from "./dto/create-refund-request.dto";
import { QueryRefundRequestDto } from "./dto/query-refund-request.dto";
import { ReviewRefundRequestDto } from "./dto/review-refund-request.dto";
import type {
  RefundRequestDetail,
  RefundRequestListResult,
} from "./types/refund.types";

@Injectable()
export class RefundService {
  constructor(
    private readonly createRefundRequestUseCase: CreateRefundRequestUseCase,
    private readonly refundQueries: RefundQueryService,
    private readonly reviewRefundRequestUseCase: ReviewRefundRequestUseCase
  ) {}

  createRefundRequest(
    user: JwtPayload,
    dto: CreateRefundRequestDto
  ): Promise<RefundRequestDetail> {
    return this.createRefundRequestUseCase.execute(user, dto);
  }

  listMyRefundRequests(
    user: JwtPayload,
    query: QueryRefundRequestDto
  ): Promise<RefundRequestListResult> {
    return this.refundQueries.listMyRefundRequests(user, query);
  }

  getMyRefundRequest(
    user: JwtPayload,
    id: string
  ): Promise<RefundRequestDetail> {
    return this.refundQueries.getMyRefundRequest(user, id);
  }

  listRefundRequests(
    user: JwtPayload,
    query: QueryRefundRequestDto
  ): Promise<RefundRequestListResult> {
    return this.refundQueries.listRefundRequests(user, query);
  }

  getRefundRequest(user: JwtPayload, id: string): Promise<RefundRequestDetail> {
    return this.refundQueries.getRefundRequest(user, id);
  }

  approveRefundRequest(
    user: JwtPayload,
    id: string,
    dto: ReviewRefundRequestDto
  ): Promise<RefundRequestDetail> {
    return this.reviewRefundRequestUseCase.approve(user, id, dto);
  }

  rejectRefundRequest(
    user: JwtPayload,
    id: string,
    dto: ReviewRefundRequestDto
  ): Promise<RefundRequestDetail> {
    return this.reviewRefundRequestUseCase.reject(user, id, dto);
  }

  retryRefundRequest(
    user: JwtPayload,
    id: string
  ): Promise<RefundRequestDetail> {
    return this.reviewRefundRequestUseCase.retry(user, id);
  }
}
