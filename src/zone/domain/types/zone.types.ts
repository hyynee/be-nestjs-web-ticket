import { Types } from "mongoose";

export const ALLOWED_ZONE_SORT_FIELDS = [
  "createdAt",
  "name",
  "price",
  "capacity",
  "soldCount",
  "confirmedSoldCount",
] as const;

export type ZoneSortField = (typeof ALLOWED_ZONE_SORT_FIELDS)[number];

export interface ZoneAreaViewSource {
  _id?: Types.ObjectId | string;
  id?: string;
  name: string;
  description?: string;
  rowLabel?: string;
  seatCount?: number;
  seats?: string[];
}

export interface ZoneViewSource {
  _id?: Types.ObjectId | string;
  id?: string;
  eventId: Types.ObjectId | string;
  name: string;
  description?: string;
  price: number;
  capacity: number;
  currentTotalSeats?: number;
  soldCount?: number;
  confirmedSoldCount?: number;
  hasSeating: boolean;
  saleStartDate?: Date;
  saleEndDate?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  areas?: ZoneAreaViewSource[];
}

export interface ZoneAreaView {
  id: string;
  name: string;
  description?: string;
  rowLabel?: string;
  seatCount: number;
  seats: string[];
}

export interface ZoneView {
  id: string;
  eventId: string;
  name: string;
  description?: string;
  price: number;
  capacity: number;
  currentTotalSeats: number;
  soldCount: number;
  confirmedSoldCount: number;
  hasSeating: boolean;
  saleStartDate?: Date;
  saleEndDate?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ZoneWithAreasView extends ZoneView {
  areas: ZoneAreaView[];
}
