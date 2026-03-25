import { Controller, Post, Body } from '@nestjs/common';
import { QueueService } from './queue.service';

@Controller('queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Post('add')
  async addJob(@Body() data: any) {
    await this.queueService.addJob(data);
    return { message: 'Job added to queue' };
  }
}
