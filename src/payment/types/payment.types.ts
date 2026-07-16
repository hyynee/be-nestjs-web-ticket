import { Types } from "mongoose";

export type PaypalLink = {
  rel?: string;
  href?: string;
};

export type PaypalCapture = {
  id: string;
  status: string;
};

export type PaypalOrderCreateResponse = {
  id: string;
  links: PaypalLink[];
};

export type PaypalOrderCaptureResponse = {
  id: string;
  status: string;
  purchase_units: Array<{
    payments: {
      captures: PaypalCapture[];
    };
  }>;
};

export type PaypalOrderCreateBody = {
  intent: "CAPTURE";
  purchase_units: Array<{
    reference_id: string;
    description: string;
    amount: {
      currency_code: "USD";
      value: string;
    };
  }>;
  application_context: {
    return_url: string;
    cancel_url: string;
  };
  expiry_time?: string;
};

export interface PaypalOrdersCreateRequest {
  prefer(value: string): void;
  requestBody(body: PaypalOrderCreateBody): void;
}

export interface PaypalOrdersCaptureRequest {
  requestBody(body: Record<string, never>): void;
}

export interface PaypalHttpClient {
  execute<T>(request: unknown): Promise<{ result: T }>;
}

export interface PaymentMetadata {
  sessionId?: string;
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  orderId?: string;
  orderStatus?: string;
  authorizationId?: string;
  captureStatus?: string;
  captureId?: string;
  capturedAt?: string;
  bookingCode?: string;
  eventTitle?: string;
  amountUSD?: string;
}

export type PaymentRecord = {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  status: string;
  currency: string;
  metadata?: PaymentMetadata;
};

export interface PaypalCapturesRefundRequest {
  requestBody(body: {
    note_to_payer?: string;
    amount?: { value: string; currency_code: string };
  }): void;
}

export interface PaypalSdk {
  core: {
    LiveEnvironment: new (clientId: string, clientSecret: string) => unknown;
    SandboxEnvironment: new (clientId: string, clientSecret: string) => unknown;
    PayPalHttpClient: new (environment: unknown) => PaypalHttpClient;
  };
  orders: {
    OrdersCreateRequest: new () => PaypalOrdersCreateRequest;
    OrdersCaptureRequest: new (orderId: string) => PaypalOrdersCaptureRequest;
    OrdersGetRequest: new (orderId: string) => unknown;
  };
  payments: {
    CapturesRefundRequest: new (
      captureId: string
    ) => PaypalCapturesRefundRequest;
  };
}

export type BookingEventSummary = {
  _id: Types.ObjectId | string;
  title: string;
  thumbnail?: string;
  location?: string;
  startDate?: Date;
  endDate?: Date;
};

export type BookingZoneSummary = {
  _id: Types.ObjectId | string;
  name: string;
  price?: number;
};

export type BookingForConfirmationMail = {
  bookingCode: string;
  customerEmail: string;
  customerName?: string;
  eventId: {
    _id?: Types.ObjectId | string;
    title: string;
    location: string;
    startDate: Date;
  };
  zoneId: {
    _id?: Types.ObjectId | string;
    name: string;
  };
  seats?: string[];
  quantity: number;
  totalPrice: number;
  userId?: Types.ObjectId;
  snapshot?: {
    eventTitle: string;
    location: string;
    eventStartDate: Date;
    zoneName: string;
  };
};

export type CreatedTicketForMail = {
  ticketCode: string;
  seatNumber?: string;
  price: number;
  status: string;
  qrCode?: string;
};

export interface CheckoutSessionResult {
  status: number;
  message: string;
  checkoutUrl: string | null;
}

export interface PaypalCreateTransactionResult {
  status: number;
  message: string;
  paypalOrderId: string;
  approvalUrl?: string;
  amountUSD: string;
  bookingDetails: {
    bookingCode: string;
    amount: number;
    currency: "VND";
    amountUSD: string;
    customerEmail?: string;
    customerName?: string;
    customerPhone?: string;
  };
}

export interface PaypalFinalizeResult {
  status: number;
  message: string;
  captureId?: string;
}

export interface PaymentHistoryResult {
  success: true;
  data: PaymentHistoryItem[];
  meta: {
    currentPage: number;
    itemsPerPage: number;
    totalItems: number;
    totalPages: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
}

export interface PaymentHistoryEvent {
  id?: string;
  title?: string;
  location?: string;
  startDate?: Date;
}

export interface PaymentHistoryZone {
  id?: string;
  name?: string;
  price?: number;
}

export interface PaymentHistoryBooking {
  id?: string;
  bookingCode?: string;
  event?: PaymentHistoryEvent;
  zone?: PaymentHistoryZone;
}

export interface PaymentHistoryItem {
  id: string;
  booking: PaymentHistoryBooking | string;
  amount: number;
  currency: string;
  paymentMethod: string;
  status: string;
  errorMessage?: string;
  stripePaymentIntentId?: string;
  paypalOrderId?: string;
  paypalCaptureId?: string;
  metadata?: PaymentMetadata;
  paidAt?: Date;
  refundedAt?: Date;
  stripeRefundId?: string;
  refundAmount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PaymentCancelResult {
  status: number;
  message: string;
}
