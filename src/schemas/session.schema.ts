import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";
import { User } from "./user.schema";

@Schema({ timestamps: true })
export class Session extends Document {
  @Prop({ type: Types.ObjectId, ref: User.name, required: true, index: true })
  userId: Types.ObjectId;

  /** SHA-256 hash of the raw refresh token (uuid) — the raw value only ever lives in the client's HttpOnly cookie. */
  @Prop({ required: true, unique: true })
  refreshTokenHash: string;

  @Prop()
  deviceInfo?: string;

  @Prop()
  ipAddress?: string;

  @Prop()
  userAgent?: string;

  @Prop({ required: true, default: Date.now })
  lastUsedAt: Date;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  @Prop({ required: true })
  expiresAt: Date;
}

export const SessionSchema = SchemaFactory.createForClass(Session);

SessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: -1 });
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
