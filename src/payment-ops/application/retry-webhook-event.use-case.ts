import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { Inject, forwardRef } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { PaymentService } from "@src/payment/payment.service";
import { PaymentWebhookEventStatus } from "@src/schemas/payment-webhook-event.schema";
import { PaymentWebhookDispatcherService } from "./payment-webhook-dispatcher.service";
import { PaymentWebhookQueryService } from "./payment-webhook-query.service";
import { PaymentWebhookStateService } from "./payment-webhook-state.service";
import { PaymentWebhookEventRepository } from "../infrastructure/persistence/payment-webhook-event.repository";
import type { PaymentWebhookRetryResult } from "../types/payment-ops.types";

@Injectable()
export class RetryWebhookEventUseCase {
  private readonly logger = new Logger(RetryWebhookEventUseCase.name);

  constructor(
    private readonly repository: PaymentWebhookEventRepository,
    private readonly dispatcher: PaymentWebhookDispatcherService,
    private readonly state: PaymentWebhookStateService,
    private readonly queries: PaymentWebhookQueryService,
    @Inject(forwardRef(() => PaymentService))
    private readonly paymentService: PaymentService,
    private readonly auditService: AuditService
  ) {}

  async execute(
    id: string,
    admin: JwtPayload
  ): Promise<PaymentWebhookRetryResult> {
    const row = await this.repository.loadById(id);
    if (row.status !== PaymentWebhookEventStatus.FAILED) {
      throw new ConflictException("Only failed webhook events can be retried");
    }

    await this.repository.markRetrying(row._id);

    try {
      const handled = await this.dispatcher.dispatchStripeEvent(row);
      if (handled) {
        await this.state.markSucceeded(row.provider, row.eventId);
      } else {
        await this.state.markIgnored(row.provider, row.eventId);
      }
      await this.paymentService.markWebhookSucceeded(row.eventId);
      await this.auditService.record({
        action: AuditAction.PAYMENT_WEBHOOK_RETRY,
        actorId: admin.userId,
        actorRole: admin.role,
        metadata: {
          provider: row.provider,
          eventId: row.eventId,
          eventType: row.eventType,
        },
      });
    } catch (error) {
      await this.state.markFailed(row.provider, row.eventId, error);
      this.logger.error(
        `retryWebhookEvent failed: id=${id}, eventId=${row.eventId}, error=${this.getErrorMessage(error)}`
      );
      throw error;
    }

    return { event: await this.queries.findById(id) };
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
