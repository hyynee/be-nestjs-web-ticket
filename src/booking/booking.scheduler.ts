// booking.scheduler.ts
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { BookingService } from "./booking.service";
@Injectable()
export class BookingScheduler {
  private readonly logger = new Logger(BookingScheduler.name);

  constructor(private readonly bookingService: BookingService) {}

  @Cron("*/15 * * * *")
  async handleExpireBookings() {
    try {
      const result = await this.bookingService.expirePendingBookings();
      this.logger.log(
        `Expired booking cron completed: ${JSON.stringify(result)}`
      );
    } catch (error) {
      this.logger.error(
        `Expired booking cron failed: ${(error as Error)?.message || "unknown error"}`
      );
    }
  }

  @Cron("0 2 * * *")
  async handleCleanupOldBookings() {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30); // xóa booking expired/cancelled > 30 ngày
      await this.bookingService.cleanupOldBookings(cutoff);
      this.logger.log(
        `Cleanup old booking cron completed for cutoff ${cutoff.toISOString()}`
      );
    } catch (error) {
      this.logger.error(
        `Cleanup old booking cron failed: ${(error as Error)?.message || "unknown error"}`
      );
    }
  }
}
