import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Roles } from "@src/common/decorators/roles.decorator";
import { RolesGuard } from "@src/guards/role.guard";
import { VerifiedUserGuard } from "@src/guards/verified-user.guard";
import { CreateRefundRequestDto } from "./dto/create-refund-request.dto";
import { QueryRefundRequestDto } from "./dto/query-refund-request.dto";
import { ReviewRefundRequestDto } from "./dto/review-refund-request.dto";
import { RefundService } from "./refund.service";
import type {
  RefundRequestDetail,
  RefundRequestListResult,
} from "./types/refund.types";

@ApiCookieAuth("access_token")
@Controller("refund-requests")
export class RefundController {
  constructor(private readonly refundService: RefundService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(AuthGuard("jwt"), VerifiedUserGuard)
  async createRefundRequest(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateRefundRequestDto
  ): Promise<RefundRequestDetail> {
    return this.refundService.createRefundRequest(user, dto);
  }

  @Get("my")
  @UseGuards(AuthGuard("jwt"))
  async listMyRefundRequests(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryRefundRequestDto
  ): Promise<RefundRequestListResult> {
    return this.refundService.listMyRefundRequests(user, query);
  }

  @Get("my/:id")
  @UseGuards(AuthGuard("jwt"))
  async getMyRefundRequest(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string
  ): Promise<RefundRequestDetail> {
    return this.refundService.getMyRefundRequest(user, id);
  }

  @Get()
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  async listRefundRequests(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryRefundRequestDto
  ): Promise<RefundRequestListResult> {
    return this.refundService.listRefundRequests(user, query);
  }

  @Get(":id")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  async getRefundRequest(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string
  ): Promise<RefundRequestDetail> {
    return this.refundService.getRefundRequest(user, id);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  async approveRefundRequest(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
    @Body() dto: ReviewRefundRequestDto
  ): Promise<RefundRequestDetail> {
    return this.refundService.approveRefundRequest(user, id, dto);
  }

  @Post(":id/reject")
  @HttpCode(200)
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  async rejectRefundRequest(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string,
    @Body() dto: ReviewRefundRequestDto
  ): Promise<RefundRequestDetail> {
    return this.refundService.rejectRefundRequest(user, id, dto);
  }

  @Post(":id/retry")
  @HttpCode(200)
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  async retryRefundRequest(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string
  ): Promise<RefundRequestDetail> {
    return this.refundService.retryRefundRequest(user, id);
  }

  @Post(":id/reconcile")
  @HttpCode(200)
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  async reconcileRefundRequest(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string
  ): Promise<RefundRequestDetail> {
    return this.refundService.reconcileRefundRequest(user, id);
  }
}
