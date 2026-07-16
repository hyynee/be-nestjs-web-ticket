import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { Payment } from "@src/schemas/payment.schema";
import { RedisService } from "@src/redis/redis.service";
import { PaymentService } from "./payment.service";

const PAYPAL_RECONCILE_LOCK_KEY = "cron:lock:paypal-reconcile";
const PAYPAL_RECONCILE_LOCK_TTL_SEC = 300;
const PAYPAL_PENDING_AGE_MS = 30 * 60 * 1000; // 30 minutes

const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

type PendingPaypalDoc = {
  _id: unknown;
  paypalOrderId: string;
  userId: string;
};

@Injectable()
export class PaymentScheduler {
  private readonly logger = new Logger(PaymentScheduler.name);

  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    private readonly paymentService: PaymentService,
    private readonly redisService: RedisService
  ) {}

  // Reconcile PayPal orders where user closed the browser after approving the payment.
  // Without a PayPal webhook, this is the recovery path for money-captured-but-not-confirmed.
  @Cron("*/10 * * * *")
  async reconcilePendingPaypalOrders(): Promise<void> {
    const lockValue = uuidv4();
    const acquired = await this.redisService.client
      .set(PAYPAL_RECONCILE_LOCK_KEY, lockValue, {
        NX: true,
        EX: PAYPAL_RECONCILE_LOCK_TTL_SEC,
      })
      .catch((err: unknown) => {
        this.logger.error(
          `paypal-reconcile: lock acquire failed — ${(err as Error)?.message ?? "unknown"}`
        );
        return null;
      });

    if (!acquired) {
      return;
    }

    try {
      const cutoff = new Date(Date.now() - PAYPAL_PENDING_AGE_MS);

      const pendingPayments = await this.paymentModel
        .find({
          paymentMethod: "paypal",
          status: "pending",
          isDeleted: false,
          createdAt: { $lt: cutoff },
        })
        .select("_id paypalOrderId userId")
        .limit(50)
        .lean<PendingPaypalDoc[]>();

      if (!pendingPayments.length) {
        return;
      }

      this.logger.log(
        `paypal-reconcile: checking ${pendingPayments.length} stale pending PayPal orders`
      );

      for (const payment of pendingPayments) {
        if (!payment.paypalOrderId || !payment.userId) continue;

        try {
          await this.paymentService.finalizePaypalTransaction(
            payment.paypalOrderId,
            payment.userId.toString()
          );
          this.logger.log(
            `paypal-reconcile: finalized orderId=${payment.paypalOrderId}`
          );
        } catch (err) {
          // Expected: already finalized, expired, or voided — log at warn, not error
          this.logger.warn(
            `paypal-reconcile: orderId=${payment.paypalOrderId} — ${(err as Error)?.message ?? "unknown"}`
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `paypal-reconcile: failed — ${(error as Error)?.message ?? "unknown"}`
      );
    } finally {
      await this.redisService.client
        .eval(RELEASE_SCRIPT, {
          keys: [PAYPAL_RECONCILE_LOCK_KEY],
          arguments: [lockValue],
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `paypal-reconcile: lock release failed — ${(error as Error)?.message ?? "unknown"}`
          );
        });
    }
  }
}
