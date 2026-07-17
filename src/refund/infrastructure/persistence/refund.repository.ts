import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Booking } from "@src/schemas/booking.schema";
import { RefundRequest } from "@src/schemas/refund-request.schema";
import { FilterQuery, Model, Types } from "mongoose";
import type {
  RefundableBooking,
  RefundRequestDocument,
} from "../../domain/types/refund-domain.types";

const REFUNDABLE_BOOKING_PROJECTION =
  "bookingCode userId eventId zoneId quantity totalPrice totalRefunded status paymentStatus stripePaymentIntentId";

@Injectable()
export class RefundRepository {
  constructor(
    @InjectModel(RefundRequest.name)
    private readonly refundRequestModel: Model<RefundRequest>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>
  ) {}

  createRequest(input: Partial<RefundRequest>): Promise<RefundRequest[]> {
    return this.refundRequestModel.create([input]);
  }

  async findMany(
    filter: FilterQuery<RefundRequest>,
    page: number,
    limit: number
  ): Promise<{ rows: RefundRequestDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      this.refundRequestModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<RefundRequestDocument[]>(),
      this.refundRequestModel.countDocuments(filter),
    ]);

    return { rows, total };
  }

  async loadRequestById(id: string): Promise<RefundRequestDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid refund request ID");
    }

    const request = await this.refundRequestModel
      .findOne({ _id: id, isDeleted: false })
      .lean<RefundRequestDocument>();
    if (!request) {
      throw new NotFoundException("Refund request not found");
    }
    return request;
  }

  updateRequestById(
    requestId: Types.ObjectId,
    update: Record<string, unknown>
  ): Promise<RefundRequestDocument | null> {
    return this.refundRequestModel
      .findByIdAndUpdate(requestId, update, { new: true })
      .lean<RefundRequestDocument>();
  }

  conditionalUpdateRequest(
    filter: FilterQuery<RefundRequest>,
    update: Record<string, unknown>
  ): Promise<RefundRequestDocument | null> {
    return this.refundRequestModel
      .findOneAndUpdate(filter, update, { new: true })
      .lean<RefundRequestDocument>();
  }

  updateRequestStatus(
    requestId: Types.ObjectId,
    filterStatus: unknown,
    update: Record<string, unknown>
  ): Promise<{ modifiedCount: number }> {
    return this.refundRequestModel.updateOne(
      { _id: requestId, status: filterStatus },
      update
    );
  }

  async loadBookingByCode(bookingCode: string): Promise<RefundableBooking> {
    const booking = await this.bookingModel
      .findOne({ bookingCode: bookingCode.trim(), isDeleted: false })
      .select(REFUNDABLE_BOOKING_PROJECTION)
      .lean<RefundableBooking>();
    if (!booking) {
      throw new NotFoundException("Booking not found");
    }
    return booking;
  }

  async loadBookingById(bookingId: string): Promise<RefundableBooking> {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw new BadRequestException("Invalid booking ID");
    }

    const booking = await this.bookingModel
      .findOne({ _id: bookingId, isDeleted: false })
      .select(REFUNDABLE_BOOKING_PROJECTION)
      .lean<RefundableBooking>();
    if (!booking) {
      throw new NotFoundException("Booking not found");
    }
    return booking;
  }
}
