import { Controller, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiCookieAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { AuditService } from "./audit.service";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { QueryAuditLogDto } from "./dto/query-audit-log.dto";

@ApiCookieAuth("access_token")
@Controller("audit")
@Roles("admin")
@UseGuards(AuthGuard("jwt"), RolesGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  findAll(
    @Query() query: QueryAuditLogDto
  ): ReturnType<AuditService["findAll"]> {
    return this.auditService.findAll(query);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Get("export")
  async export(
    @Query() query: QueryAuditLogDto,
    @Res() res: Response
  ): Promise<void> {
    const csv = await this.auditService.exportCsv(query);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=audit-log-export-${Date.now()}.csv`
    );
    res.send(csv);
  }

  @Get(":id")
  findById(@Param("id") id: string): ReturnType<AuditService["findById"]> {
    return this.auditService.findById(id);
  }
}
