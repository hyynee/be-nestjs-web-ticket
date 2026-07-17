// user.schema.ts
import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";
import * as bcrypt from "bcrypt";
@Schema({ timestamps: true })
export class User extends Document {
  @Prop({ required: true, unique: true })
  email: string;

  @Prop({ select: false })
  password: string;

  @Prop()
  fullName: string;

  @Prop()
  phoneNumber: string;

  @Prop()
  avatarPublicId: string;

  @Prop({ default: false })
  isVerified: boolean;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({
    default: "user",
    enum: ["user", "organizer", "checkin_staff", "admin"],
  })
  role: string;

  @Prop({ default: false })
  twoFactorEnabled: boolean;

  /** AES-256-GCM encrypted TOTP secret — never stored or returned raw. */
  @Prop({ select: false })
  twoFactorSecret?: string;

  /** SHA-256 hashes of single-use recovery codes — raw codes are shown to the user once, at generation time. */
  @Prop({ type: [String], default: [], select: false })
  twoFactorRecoveryCodes: string[];

  declare comparePassword: (password: string) => Promise<boolean>;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ role: 1 });
UserSchema.index({ isActive: 1 });
UserSchema.index({ isActive: 1, role: 1 });

UserSchema.pre<User>("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.comparePassword = async function (
  password: string
): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(password, this.password);
};
