
export class DashboardOverviewDto {
  totalRevenue: number;        
  totalTicketsSold: number;    
  totalBookings: number;       
  totalPaidBookings: number;   
  totalCheckedIn: number;      
  totalRefundedAmount: number;
  eventId?: string;
  startDate?: Date;
  endDate?: Date;
}

export class RevenueStatisticsItemDto {
  label: string;    
  revenue: number;
  // { label: '2024-01-01', revenue: 200000 },
}

export class RevenueStatisticsResponseDto {
  data: RevenueStatisticsItemDto[];
}

export class RevenueStatisticsByEventResponseDto {
  eventId: string;
  eventName: string;
  totalRevenue: number
  ticketsSold: number;
}