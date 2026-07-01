import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

@Schema({ timestamps: true })
export class LoginAttempt extends Document {
  @Prop({ required: true })
  identifier: string; // email // password

  @Prop({ required: true })
  ipAddress: string;

  @Prop({ default: 0 })
  failedCount: number;

  @Prop()
  lastFailedAt: Date;

  @Prop()
  lockedUntil: Date;
}

export const LoginAttemptSchema = SchemaFactory.createForClass(LoginAttempt);

LoginAttemptSchema.index({ identifier: 1, ipAddress: 1 }, { unique: true });
LoginAttemptSchema.index({ lockedUntil: 1 }, { sparse: true });
LoginAttemptSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 3600, name: "idx_ttl_cleanup" }
);
