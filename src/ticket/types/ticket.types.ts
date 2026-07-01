import { Types } from "mongoose";

export type TicketBroadcastItem = {
  ticketCode: string;
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  seatNumber?: string | null;
  price: number;
  status: string;
};

export type ZoneSeatMode = {
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
