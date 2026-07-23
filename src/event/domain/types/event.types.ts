import { Types } from "mongoose";
import { EventStatus } from "@src/schemas/event.schema";

export type EventPrincipalSource =
  | Types.ObjectId
  | string
  | {
      _id?: Types.ObjectId | string;
      id?: string;
      email?: string;
      fullName?: string;
      role?: string;
    };

export interface EventTimeSlotSource {
  _id?: Types.ObjectId | string;
  id?: string;
  label: string;
  startTime: Date;
  endTime: Date;
  capacity?: number;
}

export interface EventViewSource {
  _id?: Types.ObjectId | string;
  id?: string;
  title: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  location: string;
  thumbnail?: string;
  status: EventStatus;
  timeSlots?: EventTimeSlotSource[];
  createdBy?: EventPrincipalSource;
  organizerIds?: EventPrincipalSource[];
  staffIds?: EventPrincipalSource[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface RemovedSlotCheck {
  label: string;
  count: number;
}

export interface EventUserView {
  id: string;
  email?: string;
  fullName?: string;
  role?: string;
}

export interface EventTimeSlotView {
  id: string;
  label: string;
  startTime: Date;
  endTime: Date;
  capacity?: number;
}

export interface EventView {
  id: string;
  title: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  location: string;
  thumbnail?: string;
  status: EventStatus;
  timeSlots: EventTimeSlotView[];
  createdBy?: EventUserView;
  organizerIds: string[];
  staffIds: string[];
  createdAt?: Date;
  updatedAt?: Date;
  isActiveNow: boolean;
}

export interface EventZoneAreaView {
  // Admin callers get the raw `_id` (matches admin-frontend's existing
  // contract); customer-facing callers get `id` — see
  // EventQueryService.getEventZones's isAdmin branch.
  _id?: Types.ObjectId | string;
  id?: string;
  eventId?: Types.ObjectId | string;
  zoneId?: Types.ObjectId | string;
  name: string;
  description?: string;
  rowLabel?: string;
  seatCount?: number;
  seats?: string[];
  isDeleted?: boolean;
  deletedAt?: Date;
  createdBy?: Types.ObjectId | string;
  updatedBy?: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface EventZoneView {
  // Admin callers get the raw `_id` (matches admin-frontend's existing
  // contract); customer-facing callers get `id` — see
  // EventQueryService.getEventZones's isAdmin branch.
  _id?: Types.ObjectId | string;
  id?: string;
  eventId?: Types.ObjectId | string;
  name: string;
  description?: string;
  price: number;
  capacity?: number;
  currentTotalSeats?: number;
  soldCount?: number;
  confirmedSoldCount?: number;
  isDeleted?: boolean;
  deletedAt?: Date;
  hasSeating: boolean;
  saleStartDate?: Date;
  saleEndDate?: Date;
  createdBy?: Types.ObjectId | string;
  updatedBy?: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
  areas: EventZoneAreaView[];
  hasAreas: boolean;
}
