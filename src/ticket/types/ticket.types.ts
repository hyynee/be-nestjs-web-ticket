import { Types } from "mongoose";
import { Ticket } from "@src/schemas/ticket.schema";

export type TicketBroadcastItem = {
  ticketCode: string;
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  seatNumber?: string | null;
  price: number;
  status: string;
};

export type ZoneSeatMode = {
  _id: Types.ObjectId;
  hasSeating?: boolean;
};

export type TicketEventWindow = {
  startDate: Date;
  endDate: Date;
};

export type TicketEventTitle = {
  title?: string;
};

export type TimeSlotWindow = {
  _id: Types.ObjectId;
  label: string;
  startTime: Date;
  endTime: Date;
};

export type TicketInsertPayload = {
  bookingId: Types.ObjectId;
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  areaId?: Types.ObjectId;
  timeSlotId?: Types.ObjectId;
  seatNumber?: string;
  userId: Types.ObjectId;
  ticketCode: string;
  price: number;
  status: "valid";
};

export type TicketReferenceSource =
  | Types.ObjectId
  | string
  | {
      _id?: Types.ObjectId | string;
      id?: string;
      title?: string;
      name?: string;
      email?: string;
      fullName?: string;
      bookingCode?: string;
      startDate?: Date;
      endDate?: Date;
      location?: string;
    }
  | null;

export type TicketViewSource = {
  _id?: Types.ObjectId | string;
  id?: string;
  ticketCode: string;
  bookingId?: TicketReferenceSource;
  userId?: TicketReferenceSource;
  eventId?: TicketReferenceSource;
  zoneId?: TicketReferenceSource;
  areaId?: TicketReferenceSource;
  timeSlotId?: Types.ObjectId | string;
  seatNumber?: string;
  price: number;
  status: Ticket["status"];
  qrCode?: string;
  checkedInAt?: Date;
  checkedInBy?: TicketReferenceSource;
  checkInLocation?: string;
  cancelledAt?: Date;
  cancelledBy?: TicketReferenceSource;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TicketReferenceView = {
  id: string;
  title?: string;
  name?: string;
  email?: string;
  fullName?: string;
  bookingCode?: string;
  startDate?: Date;
  endDate?: Date;
  location?: string;
};

export type TicketListItem = {
  id: string;
  ticketCode: string;
  booking?: TicketReferenceView;
  user?: TicketReferenceView;
  event?: TicketReferenceView;
  zone?: TicketReferenceView;
  area?: TicketReferenceView;
  timeSlotId?: string;
  seatNumber?: string;
  price: number;
  status: Ticket["status"];
  checkedInAt?: Date;
  checkedInBy?: TicketReferenceView;
  checkInLocation?: string;
  cancelledAt?: Date;
  cancelledBy?: TicketReferenceView;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TicketIssuedItem = TicketListItem & {
  qrCode?: string;
};

export type TicketValidationResult = {
  valid: boolean;
  message?: string;
  usedAt?: Date;
  ticket?: TicketListItem;
};

export type TicketCheckInResult = {
  success: true;
  message: string;
  ticket: TicketIssuedItem;
};

export type TicketCancelResult = {
  success: true;
  message: string;
  ticket: {
    ticketCode: string;
    seatNumber?: string;
    zoneId: string;
    areaId: string | null;
  };
};

export type TicketCheckInHistoryAdmin = {
  _id?: Types.ObjectId | string;
  name?: string;
};

export type TicketCheckInHistoryEntry = {
  _id?: Types.ObjectId | string;
  ticketId: Types.ObjectId | string;
  adminId: TicketCheckInHistoryAdmin | null;
  location?: string;
  deviceInfo?: string;
  ipAddress?: string;
  success: boolean;
  message?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

export type TicketCheckInHistoryResult = {
  ticketCode: string;
  eventTitle: string;
  history: TicketCheckInHistoryEntry[];
};

export type TicketEventAccess = TicketEventWindow & {
  timeSlots?: TimeSlotWindow[];
  createdBy: Types.ObjectId;
  organizerIds?: Types.ObjectId[];
  staffIds?: Types.ObjectId[];
};

export type TicketSnapshotLean = {
  eventTitle: string;
  location: string;
  eventStartDate: Date;
  eventEndDate: Date;
  zoneName: string;
  areaName?: string;
};

export type TicketDetailReference =
  Types.ObjectId | Record<string, unknown> | null;

export type TicketDetailLean = Omit<
  Ticket,
  "eventId" | "zoneId" | "areaId" | "bookingId"
> & {
  eventId?: TicketDetailReference;
  zoneId?: TicketDetailReference;
  areaId?: TicketDetailReference;
  bookingId?: { snapshot?: TicketSnapshotLean } | Types.ObjectId | null;
};
