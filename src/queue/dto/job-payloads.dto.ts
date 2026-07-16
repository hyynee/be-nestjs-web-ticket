import { Type } from "class-transformer";
import {
  IsArray,
  IsDefined,
  IsEmail,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { ExportTicketDto } from "@src/export/dto/export-ticket.dto";
import { ExportCheckInDto } from "@src/export/dto/export-checkin.dto";

export interface BookingConfirmationQueuePayload {
  email: string;
  customerName: string;
  bookingCode: string;
  eventTitle: string;
  eventLocation: string;
  eventDate: Date | string;
  zoneName: string;
  seats: string[];
  quantity: number;
  totalPrice: number;
  currency: string;
  tickets?: Array<{
    ticketCode: string;
    seatNumber?: string;
    qrCode: string;
  }>;
}

export class SendRegisterEmailPayloadDto {
  @IsEmail()
  to: string;

  @IsString()
  @IsNotEmpty()
  fullName: string;
}

export class SendVerificationEmailPayloadDto {
  @IsEmail()
  to: string;

  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @IsNotEmpty()
  fullName: string;
}

export class SendPasswordResetPayloadDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  resetToken: string;

  @IsString()
  @IsNotEmpty()
  fullName: string;
}

class BookingConfirmationTicketDto {
  @IsString()
  @IsNotEmpty()
  ticketCode: string;

  @IsOptional()
  @IsString()
  seatNumber?: string;

  @IsString()
  @IsNotEmpty()
  qrCode: string;
}

/** Shared by `send-booking-confirmation` and `finalize-ticket-delivery` — mirrors BookingConfirmationData. */
export class BookingConfirmationPayloadDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  customerName: string;

  @IsString()
  @IsNotEmpty()
  bookingCode: string;

  @IsString()
  @IsNotEmpty()
  eventTitle: string;

  @IsString()
  @IsNotEmpty()
  eventLocation: string;

  @IsString()
  @IsNotEmpty()
  eventDate: string;

  @IsString()
  @IsNotEmpty()
  zoneName: string;

  @IsArray()
  @IsString({ each: true })
  seats: string[];

  @IsNumber()
  @Min(1)
  quantity: number;

  @IsNumber()
  @Min(0)
  totalPrice: number;

  @IsString()
  @IsNotEmpty()
  currency: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BookingConfirmationTicketDto)
  tickets?: BookingConfirmationTicketDto[];
}

export class RefundFailureAlertPayloadDto {
  @IsString()
  @IsNotEmpty()
  bookingId: string;

  @IsString()
  @IsNotEmpty()
  paymentRef: string;

  @IsIn(["stripe", "paypal"])
  source: "stripe" | "paypal";

  @IsString()
  @IsNotEmpty()
  errorMessage: string;

  @IsString()
  @IsNotEmpty()
  occurredAt: string;
}

export class ExportTicketsJobPayloadDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => ExportTicketDto)
  dto: ExportTicketDto;

  @IsMongoId()
  requestedByUserId: string;
}

export class ExportCheckInZonesJobPayloadDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => ExportCheckInDto)
  dto: ExportCheckInDto;

  @IsMongoId()
  requestedByUserId: string;
}

export type QueueJobPayload =
  | SendRegisterEmailPayloadDto
  | SendVerificationEmailPayloadDto
  | SendPasswordResetPayloadDto
  | BookingConfirmationQueuePayload
  | RefundFailureAlertPayloadDto
  | ExportTicketsJobPayloadDto
  | ExportCheckInZonesJobPayloadDto;
