import { Types } from "mongoose";

export type RevenueGroupBy = "day" | "month";
export type TopSellingMetric = "tickets" | "revenue";

export interface HotEventByRevenue {
  id: Types.ObjectId;
  title: string;
  thumbnail?: string;
  totalRevenue: number;
  totalPayments: number;
}

export interface CheckInZoneStatistics {
  zoneId: Types.ObjectId;
  zoneName: string;
  price: number;
  totalTickets: number;
  checkedInCount: number;
  notCheckedIn: number;
  checkInRate: number;
}

export interface TopPotentialCustomer {
  userId: Types.ObjectId;
  name: string;
  email: string;
  totalBookings: number;
  totalAmountSpent: number;
}

export interface RevenueStatisticsResult {
  data: Array<{
    label: string;
    revenue: number;
    count: number;
  }>;
}
