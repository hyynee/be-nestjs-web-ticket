// booking.scheduler.ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BookingService } from './booking.service';
@Injectable()
export class BookingScheduler {
  constructor(private readonly bookingService: BookingService) {}

  @Cron('*/15 * * * *')
  async handleExpireBookings() {
    await this.bookingService.expirePendingBookings();
  }
}
