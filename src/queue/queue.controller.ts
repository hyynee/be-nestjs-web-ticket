import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiCookieAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { QueueService } from "./queue.service";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { AdminAddJobDto } from "./dto/add-job.dto";
import { QueryJobDto } from "./dto/query-job.dto";
import { MoveToDeadLetterDto } from "./dto/move-to-dead-letter.dto";

@ApiCookieAuth("access_token")
@Controller("queue")
@Roles("admin")
@UseGuards(AuthGuard("jwt"), RolesGuard)
export class QueueController {
  constructor(
    private readonly queueService: QueueService,
    private readonly auditService: AuditService
  ) {}

  @Get("stats")
  async getStats() {
    return this.queueService.getQueueStats();
  }

  @Get("jobs")
  async listJobs(@Query() query: QueryJobDto) {
    return this.queueService.listJobs(query);
  }

  @Get("jobs/:id")
  async getJob(@Param("id") id: string) {
    return this.queueService.getJob(id);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @Post("admin/jobs")
  async addAdminJob(
    @Body() dto: AdminAddJobDto,
    @CurrentUser() user: JwtPayload
  ) {
    const job = await this.queueService.addAdminJob(dto);
    await this.auditService.record({
      action: AuditAction.QUEUE_JOB_ADD,
      actorId: user.userId,
      actorRole: user.role,
      metadata: { jobId: job.id, type: dto.type },
    });
    return { message: "Job added to queue", jobId: job.id };
  }

  @Throttle({ short: { limit: 20, ttl: 60000 } })
  @Post("jobs/:id/retry")
  async retryJob(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    const result = await this.queueService.retryJob(id);
    await this.auditService.record({
      action: AuditAction.QUEUE_JOB_RETRY,
      actorId: user.userId,
      actorRole: user.role,
      metadata: { jobId: id },
    });
    return result;
  }

  @Throttle({ short: { limit: 20, ttl: 60000 } })
  @Post("jobs/:id/move-to-dead-letter")
  async moveToDeadLetter(
    @Param("id") id: string,
    @Body() dto: MoveToDeadLetterDto,
    @CurrentUser() user: JwtPayload
  ) {
    const result = await this.queueService.moveToDeadLetter(id, dto.reason);
    await this.auditService.record({
      action: AuditAction.QUEUE_JOB_DEAD_LETTER,
      actorId: user.userId,
      actorRole: user.role,
      reason: dto.reason,
      metadata: { jobId: id },
    });
    return result;
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @Delete("jobs/:id")
  async removeJob(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    const result = await this.queueService.removeJob(id);
    await this.auditService.record({
      action: AuditAction.QUEUE_JOB_REMOVE,
      actorId: user.userId,
      actorRole: user.role,
      metadata: { jobId: id },
    });
    return result;
  }
}
