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

export type PaymentRecord = {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  status: string;
  currency: string;
  metadata?: Record<string, unknown>;
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
    title: string;
    location: string;
    startDate: Date;
  };
  zoneId: {
    name: string;
  };
  seats?: string[];
  quantity: number;
  totalPrice: number;
  userId?: Types.ObjectId;
  /** Facts as they were at booking time — preferred over eventId/zoneId (live, populated) when present. Absent on bookings created before this field existed. */
  snapshot?: {
    eventTitle: string;
    location: string;
    eventStartDate: Date;
    zoneName: string;
  };
};

export type CreatedTicketForMail = {
  ticketCode: string;
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  seatNumber?: string;
  price: number;
  status: string;
  qrCode?: string;
};
