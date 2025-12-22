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

  @UseGuards(new RolesGuard(["admin"]))
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(201)
  @ApiBearerAuth()
  @Get("/getAllUser")
  async getAllUser(
    @Query() query: QueryUserDTO,
  ) {
    return this.userService.getAllUser(query);
  }

  @UseGuards(new RolesGuard(["admin"]))
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(201)
  @ApiBearerAuth()
  @Get("/:id")
  async getUserById(@Param("id") id: string) {
    return this.userService.getUserById(id);
  }


}
