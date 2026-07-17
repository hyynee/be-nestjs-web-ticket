export interface InvoiceData {
  bookingCode: string;
  customerName: string;
  customerEmail: string;
  eventTitle: string;
  eventDate?: Date | string;
  location: string;
  zoneName: string;
  areaName?: string;
  seats: string[];
  quantity: number;
  unitPrice: number;
  discount: number;
  totalPrice: number;
  currency: string;
  paidAt?: Date | string;
  paymentMethod?: string;
  paymentProvider?: "stripe" | "paypal";
  paymentStatus: string;
  refundedAmount: number;
}
