import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Roles } from "@src/common/decorators/roles.decorator";
import { RolesGuard } from "@src/guards/role.guard";
import { OptionalJwtAuthGuard } from "@src/guards/optional.guard";
import { CreatePromotionDto } from "./dto/create-promotion.dto";
import { QueryPromotionDto } from "./dto/query-promotion.dto";
import { UpdatePromotionDto } from "./dto/update-promotion.dto";
import { ValidatePromotionDto } from "./dto/validate-promotion.dto";
import { PromotionService } from "./promotion.service";
import type {
  PromotionDetail,
  PromotionDisableResult,
  PromotionListResult,
  PromotionValidationResult,
} from "./types/promotion.types";

@ApiTags("promotion")
@Controller("promotions")
export class PromotionController {
  constructor(private readonly promotionService: PromotionService) {}

  @Post()
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  createPromotion(
    @CurrentUser() currentUser: JwtPayload,
    @Body() dto: CreatePromotionDto
  ): Promise<PromotionDetail> {
    return this.promotionService.createPromotion(currentUser, dto);
  }

  @Get()
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  listPromotions(
    @CurrentUser() currentUser: JwtPayload,
    @Query() query: QueryPromotionDto
  ): Promise<PromotionListResult> {
    return this.promotionService.listPromotions(currentUser, query);
  }

  @Get(":id")
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  getPromotion(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string
  ): Promise<PromotionDetail> {
    return this.promotionService.getPromotion(currentUser, id);
  }

  @Patch(":id")
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  updatePromotion(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() dto: UpdatePromotionDto
  ): Promise<PromotionDetail> {
    return this.promotionService.updatePromotion(currentUser, id, dto);
  }

  @Post(":id/disable")
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  disablePromotion(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string
  ): Promise<PromotionDisableResult> {
    return this.promotionService.disablePromotion(currentUser, id);
  }

  @Post("validate")
  @UseGuards(OptionalJwtAuthGuard)
  validatePromotion(
    @CurrentUser() currentUser: JwtPayload | null,
    @Body() dto: ValidatePromotionDto
  ): Promise<PromotionValidationResult> {
    return this.promotionService.validatePromotion(dto, currentUser?.userId);
  }

  @Post("apply")
  @UseGuards(OptionalJwtAuthGuard)
  previewApplyPromotion(
    @CurrentUser() currentUser: JwtPayload | null,
    @Body() dto: ValidatePromotionDto
  ): Promise<PromotionValidationResult> {
    return this.promotionService.validatePromotion(dto, currentUser?.userId);
  }
}
