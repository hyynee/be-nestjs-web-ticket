import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

@Schema({ timestamps: true })
export class EmailVerificationToken extends Document {
  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  /** SHA-256 hash of the raw token emailed to the user — the raw value is never persisted. */
  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ default: false })
  isUsed: boolean;
}

export const EmailVerificationTokenSchema = SchemaFactory.createForClass(
  EmailVerificationToken
);

EmailVerificationTokenSchema.index({ userId: 1 });
EmailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
