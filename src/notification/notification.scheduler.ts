import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { QueueService } from "@src/queue/queue.service";
import { RedisService } from "@src/redis/redis.service";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import type {
  EventReminderWindow,
  SendBookingExpiryReminderJobPayload,
  SendEventReminderJobPayload,
} from "./types/notification.types";

const BOOKING_EXPIRY_REMINDER_LOCK = "cron:lock:notification-booking-expiry";
const EVENT_REMINDER_LOCK = "cron:lock:notification-event-reminder";
const REMINDER_LOCK_TTL_SEC = 240;
const BOOKING_EXPIRY_LOOKAHEAD_MIN_MS = 5 * 60 * 1000;
const BOOKING_EXPIRY_LOOKAHEAD_MAX_MS = 10 * 60 * 1000;
const EVENT_REMINDER_SCAN_WINDOW_MS = 5 * 60 * 1000;
const BOOKING_EXPIRY_BATCH_LIMIT = 200;
const EVENT_BATCH_LIMIT = 100;
const TICKET_BATCH_LIMIT = 1000;

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

interface ReminderBookingRow {
  _id: Types.ObjectId;
}

interface ReminderEventRow {
  _id: Types.ObjectId;
}

interface ReminderTicketRow {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  userId: Types.ObjectId;
}

@Injectable()
export class NotificationScheduler {
  private readonly logger = new Logger(NotificationScheduler.name);

  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    private readonly queueService: QueueService,
    private readonly redisService: RedisService
  ) {}

  @Cron("*/5 * * * *")
  async enqueueBookingExpiryReminders(): Promise<void> {
    await this.withLock(BOOKING_EXPIRY_REMINDER_LOCK, async () => {
      const now = Date.now();
      const lowerBound = new Date(now + BOOKING_EXPIRY_LOOKAHEAD_MIN_MS);
      const upperBound = new Date(now + BOOKING_EXPIRY_LOOKAHEAD_MAX_MS);
      const bookings = await this.bookingModel
        .find({
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
          isDeleted: false,
          expiresAt: { $gte: lowerBound, $lte: upperBound },
        })
        .select("_id")
        .sort({ expiresAt: 1 })
        .limit(BOOKING_EXPIRY_BATCH_LIMIT)
        .lean<ReminderBookingRow[]>();

      await Promise.all(
        bookings.map((booking) =>
          this.queueService.addJob(
            {
              type: "send-booking-expiry-reminder",
              payload: {
                bookingId: booking._id.toString(),
              } satisfies SendBookingExpiryReminderJobPayload,
              requestedAt: new Date().toISOString(),
            },
            {
              jobId: `send-booking-expiry-reminder-${booking._id.toString()}`,
            }
          )
        )
      );

      if (bookings.length > 0) {
        this.logger.log(`booking-expiry-reminder: enqueued=${bookings.length}`);
      }
    });
  }

  @Cron("*/5 * * * *")
  async enqueueEventReminders(): Promise<void> {
    await this.withLock(EVENT_REMINDER_LOCK, async () => {
      await Promise.all([
        this.enqueueEventReminderWindow("24h", 24 * 60 * 60 * 1000),
        this.enqueueEventReminderWindow("2h", 2 * 60 * 60 * 1000),
      ]);
    });
  }

  private async enqueueEventReminderWindow(
    reminderWindow: EventReminderWindow,
    offsetMs: number
  ): Promise<void> {
    const now = Date.now();
    const lowerBound = new Date(now + offsetMs);
    const upperBound = new Date(now + offsetMs + EVENT_REMINDER_SCAN_WINDOW_MS);
    const events = await this.eventModel
      .find({
        status: EventStatus.ACTIVE,
        isDeleted: false,
        startDate: { $gte: lowerBound, $lt: upperBound },
      })
      .select("_id")
      .limit(EVENT_BATCH_LIMIT)
      .lean<ReminderEventRow[]>();

    if (events.length === 0) {
      return;
    }

    const tickets = await this.ticketModel
      .find({
        eventId: { $in: events.map((event) => event._id) },
        status: "valid",
        isDeleted: false,
      })
      .select("_id eventId userId")
      .limit(TICKET_BATCH_LIMIT)
      .lean<ReminderTicketRow[]>();

    const seen = new Set<string>();
    const jobs = tickets.flatMap((ticket) => {
      const key = `${ticket.eventId.toString()}:${ticket.userId.toString()}:${reminderWindow}`;
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [
        this.queueService.addJob(
          {
            type: "send-event-reminder",
            payload: {
              ticketId: ticket._id.toString(),
              reminderWindow,
            } satisfies SendEventReminderJobPayload,
            requestedAt: new Date().toISOString(),
          },
          { jobId: `send-event-reminder-${key}` }
        ),
      ];
    });

    await Promise.all(jobs);
    if (jobs.length > 0) {
      this.logger.log(
        `event-reminder: window=${reminderWindow}, enqueued=${jobs.length}`
      );
    }
  }

  private async withLock(
    lockKey: string,
    callback: () => Promise<void>
  ): Promise<void> {
    const lockValue = uuidv4();
    const acquired = await this.redisService.client
      .set(lockKey, lockValue, { NX: true, EX: REMINDER_LOCK_TTL_SEC })
      .catch((error: unknown) => {
        this.logger.error(
          `${lockKey}: lock acquire failed: ${getErrorMessage(error)}`
        );
        return null;
      });

    if (!acquired) {
      return;
    }

    try {
      await callback();
    } catch (error) {
      this.logger.error(`${lockKey}: failed: ${getErrorMessage(error)}`);
    } finally {
      await this.redisService.client
        .eval(RELEASE_LOCK_SCRIPT, {
          keys: [lockKey],
          arguments: [lockValue],
        })
        .catch((error: unknown) =>
          this.logger.error(
            `${lockKey}: lock release failed: ${getErrorMessage(error)}`
          )
        );
    }
  }
}
