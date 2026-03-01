
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ExportService } from './export.service';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '@src/guards/role.guard';
import { ExportTicketDto } from './dto/export-ticket.dto';
import type { Response } from 'express';
import { ExportCheckInDto } from './dto/export-checkin.dto';
@ApiBearerAuth()
@Controller('export')
@UseGuards(AuthGuard('jwt'), new RolesGuard(['admin']))
export class ExportController {
  constructor(private readonly exportService: ExportService) { }

  @Get('tickets')
  exportTickets(
    @Query() query: ExportTicketDto,
    @Res() res: Response,
  ) {
    return this.exportService.exportTickets(query, res);
  }

  @Get('checkin-zones')
  exportCheckInZones(
    @Query() query: ExportCheckInDto,
    @Res() res: Response,
  ) {
    return this.exportService.exportCheckInZones(query, res);
  }

}