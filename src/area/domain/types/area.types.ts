import { Types } from "mongoose";

export interface AreaViewSource {
  _id?: Types.ObjectId | string;
  id?: string;
  eventId: Types.ObjectId | string;
  zoneId: Types.ObjectId | string;
  name: string;
  description?: string;
  rowLabel?: string;
  seatCount?: number;
  seats?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AreaView {
  id: string;
  eventId: string;
  zoneId: string;
  name: string;
  description?: string;
  rowLabel?: string;
  seatCount: number;
  seats: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AreaZoneMutationSource {
  _id?: Types.ObjectId;
  eventId: Types.ObjectId;
  hasSeating: boolean;
}
