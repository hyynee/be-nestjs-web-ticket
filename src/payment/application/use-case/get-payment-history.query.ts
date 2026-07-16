import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Payment } from "@src/schemas/payment.schema";
import { Model, Types } from "mongoose";
import type { QueryPaymentHistoryDto } from "@src/payment/dto/query-payment-history.dto";
import type {
  PaymentHistoryResult,
  PaymentHistorySource,
} from "@src/payment/types/payment.types";
import { PaymentPresenter } from "@src/payment/presenters/payment.presenter";

@Injectable()
export class GetPaymentHistoryQuery {
  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    private readonly paymentPresenter: PaymentPresenter
  ) {}

  async execute(
    userId: string,
    query: QueryPaymentHistoryDto = {}
  ): Promise<PaymentHistoryResult> {
    const {
      page = 1,
      limit = 10,
      status,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;

    const allowedStatuses = new Set([
      "pending",
      "processing",
      "succeeded",
      "failed",
      "canceled",
      "refunded",
    ]);
    const allowedSortFields = new Set(["createdAt", "paidAt", "updatedAt"]);

    if (status && !allowedStatuses.has(status)) {
      throw new BadRequestException("Invalid payment status filter");
    }

    if (!allowedSortFields.has(sortBy)) {
      throw new BadRequestException("Invalid sortBy field");
    }

    const currentPage =
      Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const itemsPerPage =
      Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), 100)
        : 10;
    const skip = (currentPage - 1) * itemsPerPage;

    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const sort: Record<string, 1 | -1> = { [sortBy]: sortDirection };

    const filter: {
      userId: Types.ObjectId;
      isDeleted: boolean;
      status?: string;
    } = {
      userId: new Types.ObjectId(userId),
      isDeleted: false,
    };

    if (status) {
      filter.status = status;
    }

    const [payments, totalItems] = await Promise.all([
      this.paymentModel
        .find(filter)
        .populate({
          path: "bookingId",
          populate: [
            { path: "eventId", select: "title location startDate" },
            { path: "zoneId", select: "name price" },
          ],
        })
        .sort(sort)
        .skip(skip)
        .limit(itemsPerPage)
        .lean<PaymentHistorySource[]>()
        .exec(),
      this.paymentModel.countDocuments(filter),
    ]);

    return this.paymentPresenter.paymentHistoryResult({
      payments,
      currentPage,
      itemsPerPage,
      totalItems,
    });
  }
}
