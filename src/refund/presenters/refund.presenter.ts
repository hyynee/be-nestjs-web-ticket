import { Injectable } from "@nestjs/common";
import type { RefundRequestDocument } from "../domain/types/refund-domain.types";
import type { RefundRequestDetail } from "../types/refund.types";

@Injectable()
export class RefundPresenter {
  toDetail(row: RefundRequestDocument): RefundRequestDetail {
    return {
      id: row._id.toString(),
      bookingId: row.bookingId.toString(),
      userId: row.userId.toString(),
      eventId: row.eventId.toString(),
      amount: row.amount,
      reason: row.reason,
      status: row.status,
      ...(row.reviewedBy ? { reviewedBy: row.reviewedBy.toString() } : {}),
      ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}),
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.providerRefundId
        ? { providerRefundId: row.providerRefundId }
        : {}),
      ...(row.failureReason ? { failureReason: row.failureReason } : {}),
      ...(row.metadata ? { metadata: row.metadata } : {}),
      ...(row.createdAt ? { createdAt: row.createdAt.toISOString() } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
    };
  }
}
