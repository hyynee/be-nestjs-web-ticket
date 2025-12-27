import {
  Controller,
  Get,
  HttpCode,
  UseGuards,
  Headers,
  Param,
  Query,
} from "@nestjs/common";
import { UserService } from "./user.service";
import { RolesGuard } from "@src/guards/role.guard";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth } from "@nestjs/swagger";
import { QueryUserDTO } from "./dto/query-user.dto";

@Controller("user")
export class UserController {
  constructor(private readonly userService: UserService) {}

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"),new RolesGuard(["admin"]))
  @HttpCode(200)
  @Get("/getAllUser")
  async getAllUser(
    @Query() query: QueryUserDTO,
  ) {
    return this.userService.getAllUser(query);
  }

  @UseGuards(AuthGuard("jwt"),new RolesGuard(["admin"]))
  @HttpCode(200)
  @ApiBearerAuth()
  @Get("/:id")
  async getUserById(@Param("id") id: string) {
    return this.userService.getUserById(id);
  }


}
