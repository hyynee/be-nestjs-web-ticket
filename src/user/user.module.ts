import { Module } from "@nestjs/common";
import { UserService } from "./user.service";
import { UserController } from "./user.controller";
import { MongooseModule } from "@nestjs/mongoose/dist/mongoose.module";
import { UserSchema } from "@src/schemas/user.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import { UserCacheService } from "./infrastructure/cache/user-cache.service";
import { UserRepository } from "./infrastructure/persistence/user.repository";
import { UserPresenter } from "./presenters/user.presenter";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "User", schema: UserSchema },
      { name: Payment.name, schema: PaymentSchema },
    ]),
  ],
  controllers: [UserController],
  providers: [UserService, UserRepository, UserCacheService, UserPresenter],
  exports: [UserService],
})
export class UserModule {}
