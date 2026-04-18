export interface BookingConfirmationData {
  email: string;
  customerName: string;
  bookingCode: string;
  eventTitle: string;
  eventLocation: string;
  eventDate: Date;
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