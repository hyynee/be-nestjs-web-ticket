import { Module } from "@nestjs/common";
import { UserService } from "./user.service";
import { UserController } from "./user.controller";
import { MongooseModule } from "@nestjs/mongoose/dist/mongoose.module";
import { UserSchema } from "@src/schemas/user.schema";
import { Payment,PaymentSchema } from "@src/schemas/payment.schema";

@Module({
  imports: [MongooseModule.forFeature([{ name: "User", schema: UserSchema },{name:Payment.name,schema:PaymentSchema}])],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
