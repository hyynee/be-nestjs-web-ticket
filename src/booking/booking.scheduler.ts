// booking.scheduler.ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BookingService } from './booking.service';
@Injectable()
export class BookingScheduler {
  constructor(private readonly bookingService: BookingService) { }

  @Cron('*/15 * * * *')
  async handleExpireBookings() {
    await this.bookingService.expirePendingBookings();
  }
  @Cron('0 2 * * *')
  async handleCleanupOldBookings() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30); // xóa booking expired/cancelled > 30 ngày
    await this.bookingService.cleanupOldBookings(cutoff);
  }
}
