import {
  Processor,
  WorkerHost,
  OnWorkerEvent,
  InjectQueue,
} from "@nestjs/bullmq";
import { Job, Queue, UnrecoverableError } from "bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { MailService } from "@src/services/mail.service";
import { ExportService } from "@src/export/export.service";
import { TicketService } from "@src/ticket/ticket.service";
import { User } from "@src/schemas/user.schema";
import { ExportTicketDto } from "@src/export/dto/export-ticket.dto";
import { ExportCheckInDto } from "@src/export/dto/export-checkin.dto";
import { FAILED_JOB_ALERT_THRESHOLD } from "./queue.service";
import type { BookingConfirmationData } from "@src/types/booking-modules";

type ExportRow = Record<string, string | number | boolean | null>;

const EXPORT_MAX_ROWS = 50_000;

function toCsvString(rows: ExportRow[]): string {
  if (!rows.length) return "No data";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [
    headers.map(escape).join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(",")),
  ].join("\n");
}

@Processor("default")
@Injectable()
export class QueueProcessor extends WorkerHost {
  private readonly logger = new Logger(QueueProcessor.name);

  constructor(
    private readonly mailService: MailService,
    private readonly exportService: ExportService,
    private readonly ticketService: TicketService,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectQueue("default") private readonly queue: Queue,
    @InjectQueue("dead-letter") private readonly dlqQueue: Queue
  ) {
    super();
  }

  async process(job: Job) {
    try {
      if (!job.data || !job.data.type) {
        throw new Error("Invalid job data");
      }
      const { type, payload } = job.data;
      switch (type) {
        case "send-register-email":
          await this.mailService.deliverRegisterEmail(
            payload.to,
            payload.fullName
          );
          break;
        case "send-password-reset":
          await this.mailService.deliverPasswordResetEmail(
            payload.email,
            payload.resetToken,
            payload.fullName
          );
          break;
        case "send-booking-confirmation":
          await this.mailService.deliverBookingConfirmation(payload);
          break;

        case "finalize-ticket-delivery": {
          const delivery = payload as BookingConfirmationData;
          const tickets =
            await this.ticketService.generateMissingQRCodesForBooking(
              delivery.bookingCode
            );
          await this.mailService.deliverBookingConfirmation({
            ...delivery,
            tickets: tickets.map((ticket) => ({
              ticketCode: ticket.ticketCode,
              seatNumber: ticket.seatNumber,
              qrCode: ticket.qrCode || "",
            })),
          });
          break;
        }

        case "refund-failure-alert": {
          const { bookingId, paymentRef, source, errorMessage, occurredAt } =
            payload as {
              bookingId: string;
              paymentRef: string;
              source: string;
              errorMessage: string;
              occurredAt: string;
            };
          this.logger.error(
            `[REFUND_FAILURE_ALERT] bookingId=${bookingId} paymentRef=${paymentRef} source=${source} occurredAt=${occurredAt} error="${errorMessage}" — MANUAL REFUND REQUIRED`
          );
          const alertEmail = process.env.ALERT_EMAIL;
          if (alertEmail) {
            await this.mailService.deliverRefundFailureAlert({
              to: alertEmail,
              bookingId,
              paymentRef,
              source,
              errorMessage,
              occurredAt,
            });
          } else {
            this.logger.warn(
              "[REFUND_FAILURE_ALERT] ALERT_EMAIL env var not set — email alert skipped. Set ALERT_EMAIL to receive refund failure notifications."
            );
          }
          break;
        }

        case "export-tickets": {
          const { dto, requestedByUserId } = payload as {
            dto: ExportTicketDto;
            requestedByUserId: string;
          };
          const admin = await this.userModel
            .findById(requestedByUserId)
            .select("email")
            .lean<{ email: string }>();
          if (!admin?.email) {
            this.logger.warn(
              `export-tickets: user ${requestedByUserId} not found, skipping`
            );
            break;
          }
          const rows = await this.exportService.getTicketExportData(dto);
          if (rows.length > EXPORT_MAX_ROWS) {
            // UnrecoverableError tells BullMQ not to retry — the dataset is too large
            // and will remain too large on every retry.
            throw new UnrecoverableError(
              `Export quá lớn (${rows.length.toLocaleString()} dòng, tối đa ${EXPORT_MAX_ROWS.toLocaleString()}). Vui lòng lọc theo sự kiện hoặc khoảng thời gian nhỏ hơn.`
            );
          }
          const csv = toCsvString(rows as ExportRow[]);
          await this.mailService.deliverExportReady(
            admin.email,
            "Export vé - Ticket System",
            csv,
            `tickets-export-${Date.now()}.csv`
          );
          break;
        }

        case "export-checkin-zones": {
          const { dto, requestedByUserId } = payload as {
            dto: ExportCheckInDto;
            requestedByUserId: string;
          };
          const admin = await this.userModel
            .findById(requestedByUserId)
            .select("email")
            .lean<{ email: string }>();
          if (!admin?.email) {
            this.logger.warn(
              `export-checkin-zones: user ${requestedByUserId} not found, skipping`
            );
            break;
          }
          const rows = await this.exportService.getCheckInZoneExportData(dto);
          if (rows.length > EXPORT_MAX_ROWS) {
            throw new UnrecoverableError(
              `Export quá lớn (${rows.length.toLocaleString()} dòng, tối đa ${EXPORT_MAX_ROWS.toLocaleString()}).`
            );
          }
          const csv = toCsvString(rows as ExportRow[]);
          await this.mailService.deliverExportReady(
            admin.email,
            "Export check-in zones - Ticket System",
            csv,
            `checkin-zones-export-${Date.now()}.csv`
          );
          break;
        }

        default:
          throw new Error(`Unknown job type: ${job.data?.type as string}`);
      }
      return true;
    } catch (error) {
      this.logger.error(
        `Job failed — id=${job.id}, type=${job.data?.type}, attempt=${job.attemptsMade}: ${(error as Error)?.message}`
      );
      throw error;
    }
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job, error: Error) {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    try {
      await this.dlqQueue.add(
        "dead-letter",
        {
          originalJobId: job.id,
          originalName: job.name,
          originalType: job.data?.type,
          payload: job.data,
          error: error.message,
          stack: error.stack,
          attemptsMade: job.attemptsMade,
          failedAt: new Date().toISOString(),
        },
        {
          jobId: `dead-letter:${job.id ?? `${job.data?.type}:${Date.now()}`}`,
          removeOnComplete: false,
          removeOnFail: false,
        }
      );

      const counts = await this.queue.getJobCounts("failed");
      const failedCount = counts.failed ?? 0;
      if (failedCount > FAILED_JOB_ALERT_THRESHOLD) {
        this.logger.error(
          `[QueueAlert] permanently failed jobs=${failedCount} exceeded threshold=${FAILED_JOB_ALERT_THRESHOLD} — type=${job.data?.type}, jobId=${job.id}, error="${error.message}"`
        );
      } else {
        this.logger.warn(
          `Job permanently failed — id=${job.id}, type=${job.data?.type}, totalFailed=${failedCount}, error="${error.message}"`
        );
      }
    } catch {
      this.logger.warn(
        `Job permanently failed — id=${job.id}, type=${job.data?.type}, error="${error.message}" (failed count unavailable)`
      );
    }
  }
}
