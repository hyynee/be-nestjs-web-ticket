import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { UserSchema } from "@src/schemas/user.schema";
import { TwoFactorService } from "./two-factor.service";
import { TwoFactorController } from "./two-factor.controller";

@Module({
  imports: [MongooseModule.forFeature([{ name: "User", schema: UserSchema }])],
  controllers: [TwoFactorController],
  providers: [TwoFactorService],
  exports: [TwoFactorService],
})
export class TwoFactorModule {}
