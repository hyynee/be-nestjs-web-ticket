import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

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

export const LoginAttemptSchema =
  SchemaFactory.createForClass(LoginAttempt);