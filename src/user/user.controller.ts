import {
  Controller,
  Get,
  HttpCode,
  UseGuards,
  Body,
  Patch,
  Param,
  Query,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { UserService, UserSpendingResult } from "./user.service";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { AuthGuard } from "@nestjs/passport";
import { ApiCookieAuth } from "@nestjs/swagger";
import { QueryUserDTO } from "./dto/query-user.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { UserSpendingQueryDto } from "./dto/spending-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@Controller("user")
export class UserController {
  constructor(private readonly userService: UserService) {}
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Patch("/update-profile")
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  updateProfileUser(
    @CurrentUser() user: JwtPayload,
    @Body() data: UpdateUserDto
  ): ReturnType<UserService["updateProfileUser"]> {
    return this.userService.updateProfileUser(user.userId, data);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Get("/spending")
  @UseGuards(AuthGuard("jwt"))
  @ApiCookieAuth("access_token")
  getUserSpending(
    @CurrentUser() user: JwtPayload,
    @Query() query: UserSpendingQueryDto
  ): Promise<UserSpendingResult> {
    const userId = user.userId;

    if (query.day) {
      const month = query.month || new Date().getMonth() + 1;
      const year = query.year || new Date().getFullYear();
      return this.userService.getTotalUserSpendingInDay(
        userId,
        query.day,
        month,
        year
      );
    }
    if (query.month) {
      const year = query.year || new Date().getFullYear();
      return this.userService.getTotalUserSpendingInMonth(
        userId,
        query.month,
        year
      );
    }
    if (query.year) {
      return this.userService.getTotalUserSpendingInYear(userId, query.year);
    }

    return this.userService.getTotalUserSpending(userId);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("/getAllUser")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @ApiCookieAuth("access_token")
  @HttpCode(200)
  async getAllUser(
    @Query() query: QueryUserDTO
  ): ReturnType<UserService["getAllUser"]> {
    return this.userService.getAllUser(query);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("/:id")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @ApiCookieAuth("access_token")
  @HttpCode(200)
  async getUserById(
    @Param("id") id: string
  ): ReturnType<UserService["getUserById"]> {
    return this.userService.getUserById(id);
  }
}
