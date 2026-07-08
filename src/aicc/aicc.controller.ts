import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthGuard } from "@nestjs/passport";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Roles } from "@src/common/decorators/roles.decorator";
import { OptionalJwtAuthGuard } from "@src/guards/optional.guard";
import { RolesGuard } from "@src/guards/role.guard";
import { AiccService } from "./aicc.service";
import { CreateAiccSessionDto } from "./dto/create-aicc-session.dto";
import { SendAiccMessageDto } from "./dto/send-aicc-message.dto";
import { EndAiccSessionDto } from "./dto/end-aicc-session.dto";
import { CreateAiccTranscriptDto } from "./dto/create-aicc-transcript.dto";
import { CreateAiccHandoffDto } from "./dto/create-aicc-handoff.dto";
import { QueryAiccHandoffDto } from "./dto/query-aicc-handoff.dto";
import { UpdateAiccHandoffDto } from "./dto/update-aicc-handoff.dto";
import { CreateAiccKnowledgeDto } from "./dto/create-aicc-knowledge.dto";
import { UpdateAiccKnowledgeDto } from "./dto/update-aicc-knowledge.dto";
import {
  QueryAiccKnowledgeDto,
  SearchAiccKnowledgeDto,
} from "./dto/query-aicc-knowledge.dto";
import { QueryAiccAnalyticsDto } from "./dto/query-aicc-analytics.dto";
import {
  AiccAnalyticsDashboardResponse,
  AiccApiResponse,
  AiccHandoffListResponse,
  AiccHandoffResponse,
  AiccKnowledgeListResponse,
  AiccKnowledgeResponse,
  AiccMessageResponse,
  AiccSessionResponse,
  AiccTranscriptResponse,
} from "./aicc.types";
import { KnowledgeSearchResult } from "./tools/aicc-tool.types";

@ApiTags("AICC")
@ApiCookieAuth("access_token")
@UseGuards(OptionalJwtAuthGuard)
@Controller("aicc")
export class AiccController {
  constructor(private readonly aiccService: AiccService) {}

  @Throttle({ short: { limit: 20, ttl: 60000 } })
  @Post("sessions")
  createSession(
    @Body() dto: CreateAiccSessionDto,
    @CurrentUser() user?: JwtPayload | null
  ): Promise<AiccApiResponse<AiccSessionResponse>> {
    return this.aiccService.createSession(dto, user);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Get("sessions/:sessionId")
  getSession(
    @Param("sessionId") sessionId: string,
    @CurrentUser() user?: JwtPayload | null
  ): Promise<AiccApiResponse<AiccSessionResponse>> {
    return this.aiccService.getSession(sessionId, user);
  }

  @Throttle({ short: { limit: 30, ttl: 60000 } })
  @Post("sessions/:sessionId/messages")
  sendMessage(
    @Param("sessionId") sessionId: string,
    @Body() dto: SendAiccMessageDto,
    @CurrentUser() user?: JwtPayload | null
  ): Promise<AiccApiResponse<AiccMessageResponse>> {
    return this.aiccService.sendMessage(sessionId, dto, user);
  }

  @Throttle({ short: { limit: 60, ttl: 60000 } })
  @Post("sessions/:sessionId/transcripts")
  createTranscript(
    @Param("sessionId") sessionId: string,
    @Body() dto: CreateAiccTranscriptDto,
    @CurrentUser() user?: JwtPayload | null
  ): Promise<AiccApiResponse<AiccTranscriptResponse>> {
    return this.aiccService.createTranscript(sessionId, dto, user);
  }

  @Throttle({ short: { limit: 20, ttl: 60000 } })
  @Post("sessions/:sessionId/end")
  endSession(
    @Param("sessionId") sessionId: string,
    @Body() dto: EndAiccSessionDto,
    @CurrentUser() user?: JwtPayload | null
  ): Promise<AiccApiResponse<AiccSessionResponse>> {
    return this.aiccService.endSession(sessionId, dto, user);
  }

  @Throttle({ short: { limit: 20, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("handoffs")
  createHandoff(
    @Body() dto: CreateAiccHandoffDto
  ): Promise<AiccApiResponse<AiccHandoffResponse>> {
    return this.aiccService.createHandoff(dto);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("handoffs")
  listHandoffs(
    @Query() query: QueryAiccHandoffDto
  ): Promise<AiccApiResponse<AiccHandoffListResponse>> {
    return this.aiccService.listHandoffs(query);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("handoffs/:handoffId")
  getHandoff(
    @Param("handoffId") handoffId: string
  ): Promise<AiccApiResponse<AiccHandoffResponse>> {
    return this.aiccService.getHandoff(handoffId);
  }

  @Throttle({ short: { limit: 60, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Patch("handoffs/:handoffId")
  updateHandoff(
    @Param("handoffId") handoffId: string,
    @Body() dto: UpdateAiccHandoffDto,
    @CurrentUser() admin?: JwtPayload | null
  ): Promise<AiccApiResponse<AiccHandoffResponse>> {
    return this.aiccService.updateHandoff(handoffId, dto, admin);
  }

  @Throttle({ short: { limit: 20, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("kb")
  createKnowledge(
    @Body() dto: CreateAiccKnowledgeDto,
    @CurrentUser() admin?: JwtPayload | null
  ): Promise<AiccApiResponse<AiccKnowledgeResponse>> {
    return this.aiccService.createKnowledge(dto, admin);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("kb")
  listKnowledge(
    @Query() query: QueryAiccKnowledgeDto
  ): Promise<AiccApiResponse<AiccKnowledgeListResponse>> {
    return this.aiccService.listKnowledge(query);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("kb/:knowledgeId")
  getKnowledge(
    @Param("knowledgeId") knowledgeId: string
  ): Promise<AiccApiResponse<AiccKnowledgeResponse>> {
    return this.aiccService.getKnowledge(knowledgeId);
  }

  @Throttle({ short: { limit: 60, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Patch("kb/:knowledgeId")
  updateKnowledge(
    @Param("knowledgeId") knowledgeId: string,
    @Body() dto: UpdateAiccKnowledgeDto,
    @CurrentUser() admin?: JwtPayload | null
  ): Promise<AiccApiResponse<AiccKnowledgeResponse>> {
    return this.aiccService.updateKnowledge(knowledgeId, dto, admin);
  }

  @Throttle({ short: { limit: 30, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Delete("kb/:knowledgeId")
  archiveKnowledge(
    @Param("knowledgeId") knowledgeId: string,
    @CurrentUser() admin?: JwtPayload | null
  ): Promise<AiccApiResponse<AiccKnowledgeResponse>> {
    return this.aiccService.archiveKnowledge(knowledgeId, admin);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("kb/search")
  searchKnowledge(
    @Body() dto: SearchAiccKnowledgeDto
  ): Promise<AiccApiResponse<KnowledgeSearchResult>> {
    return this.aiccService.searchKnowledge(dto);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("analytics/dashboard")
  getAnalyticsDashboard(
    @Query() query: QueryAiccAnalyticsDto
  ): Promise<AiccApiResponse<AiccAnalyticsDashboardResponse>> {
    return this.aiccService.getAnalyticsDashboard(query);
  }
}
