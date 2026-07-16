import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

@Schema({ timestamps: true })
export class Ticket {
  // Mã vé unique (dùng để sinh QR code)
  @Prop({ required: true, unique: true })
  ticketCode: string; // VD: TK202412190001

  @Prop({ type: Types.ObjectId, ref: "Booking", required: true })
  bookingId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Event", required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Zone", required: true })
  zoneId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Area" })
  areaId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  timeSlotId?: Types.ObjectId;

  @Prop({ type: String })
  seatNumber?: string;
  @Prop({ type: Number, required: true, min: 0 })
  price: number;

  @Prop({
    type: String,
    enum: ["valid", "used", "cancelled", "expired"],
    default: "valid",
  })
  status: "valid" | "used" | "cancelled" | "expired";

  // QR Code (base64 hoặc URL)
  @Prop({ type: String })
  qrCode?: string;

  @Prop({ type: Date })
  checkedInAt?: Date;

  @Prop({ type: Types.ObjectId, ref: "User" })
  checkedInBy?: Types.ObjectId;

  @Prop({ type: String })
  checkInLocation?: string;

  @Prop({ type: Object })
  metadata?: {
    deviceInfo?: string;
    ipAddress?: string;
    extra?: Record<string, unknown>;
  };

  @Prop({ type: Date })
  cancelledAt?: Date;

  @Prop({ type: Types.ObjectId, ref: "User" })
  cancelledBy?: Types.ObjectId;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const TicketSchema = SchemaFactory.createForClass(Ticket);

TicketSchema.virtual("isValid").get(function () {
  return this.status === "valid" && !this.isDeleted;
});

TicketSchema.index({ eventId: 1, status: 1, isDeleted: 1 });
TicketSchema.index({ userId: 1, isDeleted: 1 });
TicketSchema.index({ bookingId: 1 });
TicketSchema.index({ status: 1, isDeleted: 1 });
TicketSchema.index({ createdAt: -1 });
TicketSchema.index({ status: 1, isDeleted: 1, createdAt: -1 });
TicketSchema.index({ eventId: 1, status: 1, isDeleted: 1, createdAt: -1 });

TicketSchema.index(
  { bookingId: 1, seatNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { seatNumber: { $type: "string" } },
    name: "idx_unique_booking_seat",
  }
);

TicketSchema.index(
  { ticketCode: 1 },
  { unique: true, name: "idx_ticketcode_unique" }
);

TicketSchema.index(
  { eventId: 1, zoneId: 1, status: 1, isDeleted: 1 },
  { name: "idx_event_zone_status_deleted" }
);
TicketSchema.index(
  { timeSlotId: 1, status: 1, isDeleted: 1 },
  { sparse: true, name: "idx_timeslot_status_deleted" }
);
