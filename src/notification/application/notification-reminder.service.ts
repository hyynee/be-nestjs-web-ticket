import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { User } from "@src/schemas/user.schema";
import { Model, Types } from "mongoose";
import { NotificationType } from "@src/schemas/notification.schema";
import {
  EventReminderNotificationEmailPayload,
  SendBookingExpiryReminderJobPayload,
  SendEventReminderJobPayload,
} from "../types/notification.types";
import { NotificationEventService } from "./notification-event.service";

type BookingReminderSource = {
  _id: Types.ObjectId;
  bookingCode: string;
  userId: Types.ObjectId;
  customerEmail: string;
  customerName?: string;
  expiresAt: Date;
  snapshot?: Booking["snapshot"];
};

type EventReminderTicketSource = {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  userId: Types.ObjectId;
  eventId: Types.ObjectId;
};

@Injectable()
export class NotificationReminderService {
  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly events: NotificationEventService
  ) {}

  async processBookingExpiryReminderJob(
    payload: SendBookingExpiryReminderJobPayload
  ): Promise<void> {
    const bookingId = this.toObjectId(payload.bookingId, "Invalid booking ID");
    const booking = await this.bookingModel
      .findOne({
        _id: bookingId,
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        isDeleted: false,
        expiresAt: { $gt: new Date() },
      })
      .select(
        "bookingCode userId customerEmail customerName expiresAt snapshot"
      )
      .lean<BookingReminderSource>();

    if (!booking) {
      return;
    }

    const eventTitle = booking.snapshot?.eventTitle ?? "sự kiện của bạn";
    const idempotencyKey = `booking-expiry-reminder:${booking._id.toString()}`;
    const title = "Booking sắp hết hạn";
    const body = `Booking ${booking.bookingCode} cho ${eventTitle} sắp hết hạn. Vui lòng hoàn tất thanh toán để giữ vé.`;

    await Promise.all([
      this.events.createInAppSafely({
        userId: booking.userId,
        type: NotificationType.BOOKING_EXPIRY_REMINDER,
        title,
        body,
        metadata: {
          idempotencyKey,
          bookingId: booking._id.toString(),
          bookingCode: booking.bookingCode,
        },
      }),
      this.events.queueEmailSafely({
        userId: booking.userId,
        recipientEmail: booking.customerEmail,
        type: NotificationType.BOOKING_EXPIRY_REMINDER,
        title,
        body,
        template: "generic",
        payload: { to: booking.customerEmail, title, body },
        metadata: {
          idempotencyKey: `${idempotencyKey}:email`,
          bookingId: booking._id.toString(),
          bookingCode: booking.bookingCode,
        },
      }),
    ]);
  }

  async processEventReminderJob(
    payload: SendEventReminderJobPayload
  ): Promise<void> {
    const ticketId = this.toObjectId(payload.ticketId, "Invalid ticket ID");
    const ticket = await this.ticketModel
      .findOne({ _id: ticketId, status: "valid", isDeleted: false })
      .select("bookingId userId eventId")
      .lean<EventReminderTicketSource>();

    if (!ticket) {
      return;
    }

    const [event, booking, user] = await Promise.all([
      this.eventModel
        .findOne({
          _id: ticket.eventId,
          status: EventStatus.ACTIVE,
          isDeleted: false,
          startDate: { $gt: new Date() },
        })
        .select("title startDate location")
        .lean<{
          _id: Types.ObjectId;
          title: string;
          startDate: Date;
          location: string;
        }>(),
      this.bookingModel
        .findById(ticket.bookingId)
        .select("bookingCode customerName customerEmail")
        .lean<{
          bookingCode: string;
          customerName?: string;
          customerEmail: string;
        }>(),
      this.userModel
        .findById(ticket.userId)
        .select("email fullName")
        .lean<{ email: string; fullName?: string }>(),
    ]);

    if (!event || !booking || !user?.email) {
      return;
    }

    const idempotencyKey = `event-reminder:${event._id.toString()}:${ticket.userId.toString()}:${payload.reminderWindow}`;
    const title = `Nhắc lịch sự kiện ${payload.reminderWindow}`;
    const body = `Sự kiện ${event.title} sẽ diễn ra vào ${event.startDate.toISOString()} tại ${event.location}.`;
    const emailPayload: EventReminderNotificationEmailPayload = {
      email: user.email,
      customerName: booking.customerName ?? user.fullName ?? "Khách hàng",
      eventTitle: event.title,
      eventDate: event.startDate,
      eventLocation: event.location,
      bookingCode: booking.bookingCode,
    };

    await Promise.all([
      this.events.createInAppSafely({
        userId: ticket.userId,
        type: NotificationType.EVENT_REMINDER,
        title,
        body,
        metadata: {
          idempotencyKey,
          eventId: event._id.toString(),
          bookingCode: booking.bookingCode,
          ticketId: ticket._id.toString(),
          reminderWindow: payload.reminderWindow,
        },
      }),
      this.events.queueEmailSafely({
        userId: ticket.userId,
        recipientEmail: user.email,
        type: NotificationType.EVENT_REMINDER,
        title,
        body,
        template: "event-reminder",
        payload: emailPayload,
        metadata: {
          idempotencyKey: `${idempotencyKey}:email`,
          eventId: event._id.toString(),
          bookingCode: booking.bookingCode,
          ticketId: ticket._id.toString(),
          reminderWindow: payload.reminderWindow,
        },
      }),
    ]);
  }

  private toObjectId(value: string, message: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(message);
    }
    return new Types.ObjectId(value);
  }
}
