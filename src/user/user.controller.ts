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
import { UserService } from "./user.service";
import { RolesGuard } from "@src/guards/role.guard";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth } from "@nestjs/swagger";
import { QueryUserDTO } from "./dto/query-user.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { UserSpendingQueryDto } from "./dto/spending-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@Controller("user")
export class UserController {
  constructor(private readonly userService: UserService) { }
  @Patch("/update-profile")
  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  updateProfileUser(@CurrentUser() user: JwtPayload, @Body() data: UpdateUserDto) {
    return this.userService.updateProfileUser(user.userId, data);
  }

  @Get("/spending")
  @UseGuards(AuthGuard("jwt"))
  @ApiBearerAuth()
  getUserSpending(
    @CurrentUser() user: JwtPayload,
    @Query() query: UserSpendingQueryDto
  ) {
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

  @Get("/getAllUser")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @ApiBearerAuth()
  @HttpCode(200)
  async getAllUser(@Query() query: QueryUserDTO) {
    return this.userService.getAllUser(query);
  }

  @Get("/:id")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @ApiBearerAuth()
  @HttpCode(200)
  async getUserById(@Param("id") id: string) {
    return this.userService.getUserById(id);
  }
}