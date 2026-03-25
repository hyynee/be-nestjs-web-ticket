import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable } from '@nestjs/common';
import { MailService } from '@src/services/mail.service';
import { ExportService } from '@src/export/export.service';

@Processor('default')
@Injectable()
export class QueueProcessor extends WorkerHost {
  constructor(
    private readonly mailService: MailService,
    private readonly exportService: ExportService,
  ) {
    super();
  }

  async process(job: Job) {
    const { type, payload } = job.data;
    switch (type) {
      case 'send-register-email':
        await this.mailService.sendRegisterEmail(payload.to, payload.fullName);
        break;
      case 'send-booking-confirmation':
        // await this.mailService.sendBookingConfirmation(...)
        break;
      case 'export-tickets':
        // await this.exportService.exportTickets(payload, ...)
        break;
      case 'export-checkin-zones':
        // await this.exportService.exportCheckInZones(payload, ...)
        break;
      default:
        console.log('Unknown job type:', type);
    }
    return true;
  }
}