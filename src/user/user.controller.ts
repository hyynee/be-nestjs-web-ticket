import {
  Controller,
  Get,
  HttpCode,
  UseGuards,
  Headers,
  Param,
} from "@nestjs/common";
import { UserService } from "./user.service";
import { RolesGuard } from "@src/guards/role.guard";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth } from "@nestjs/swagger";

@Controller("user")
export class UserController {
  constructor(private readonly userService: UserService) {}

  @UseGuards(new RolesGuard(["admin"]))
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(201)
  @ApiBearerAuth()
  @Get("/getAllUser")
  async getAllUser() {
    return this.userService.getAllUser();
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
