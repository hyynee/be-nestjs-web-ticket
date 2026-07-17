import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { InvoiceService } from "./invoice.service";
import { QueryInvoiceDto } from "./dto/query-invoice.dto";

@Controller("invoice")
export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Get("my/:bookingCode")
  async getMyInvoice(
    @CurrentUser() user: JwtPayload,
    @Param("bookingCode") bookingCode: string,
    @Query() query: QueryInvoiceDto,
    @Res({ passthrough: true }) res: Response
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.invoiceService.getInvoicePdf(
      bookingCode,
      user,
      { accessMode: "owner" }
    );
    this.setPdfHeaders(res, filename, query.disposition ?? "attachment");
    return new StreamableFile(buffer);
  }

  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(200)
  @Get("admin/:bookingCode")
  async getAdminInvoice(
    @CurrentUser() user: JwtPayload,
    @Param("bookingCode") bookingCode: string,
    @Query() query: QueryInvoiceDto,
    @Res({ passthrough: true }) res: Response
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.invoiceService.getInvoicePdf(
      bookingCode,
      user,
      { accessMode: "admin" }
    );
    this.setPdfHeaders(res, filename, query.disposition ?? "attachment");
    return new StreamableFile(buffer);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Post(":bookingCode/resend")
  async resendInvoice(
    @CurrentUser() user: JwtPayload,
    @Param("bookingCode") bookingCode: string
  ): ReturnType<InvoiceService["resendInvoice"]> {
    const isAdmin = user.role === "admin";
    return this.invoiceService.resendInvoice(bookingCode, user, {
      accessMode: isAdmin ? "admin" : "owner",
    });
  }

  private setPdfHeaders(
    res: Response,
    filename: string,
    disposition: "attachment" | "inline"
  ): void {
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
    });
  }
}
