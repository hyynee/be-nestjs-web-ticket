import { AiccToolCallStatus } from "../schemas/aicc-tool-call.schema";

export enum AiccToolName {
  SEARCH_EVENTS = "search_events",
  GET_EVENT_DETAIL = "get_event_detail",
  CHECK_TICKET_AVAILABILITY = "check_ticket_availability",
  BUILD_CHECKOUT_CONTEXT = "build_checkout_context",
  LOOKUP_BOOKING = "lookup_booking",
  EXPLAIN_BOOKING_STATUS = "explain_booking_status",
  LOOKUP_PAYMENT = "lookup_payment",
  EXPLAIN_PAYMENT_STATUS = "explain_payment_status",
  LOOKUP_TICKET = "lookup_ticket",
  SEARCH_KNOWLEDGE = "search_knowledge",
  CREATE_HANDOFF = "create_handoff",
}

export interface AiccExecutedToolCall {
  sessionId: string;
  turnNo: number;
  toolName: AiccToolName;
  args: AiccToolArgs;
  result: AiccToolResult;
  status: AiccToolCallStatus;
  errorCode?: string;
  durationMs: number;
  idempotencyKey?: string;
}

export interface EventSummary {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  location: string;
  status: string;
  thumbnail?: string;
}

export interface SearchEventsArgs {
  search?: string;
  status?: string;
  dateMode?: "active_now" | "upcoming" | "all";
  limit?: number;
}

export interface SearchEventsResult {
  events: EventSummary[];
}

export interface GetEventDetailResult {
  event?: EventSummary & {
    description?: string;
    timeSlots: Array<{
      id: string;
      label: string;
      startTime: string;
      endTime: string;
      capacity?: number;
    }>;
  };
  zones: Array<{
    id: string;
    name: string;
    price: number;
    capacity: number;
    soldCount: number;
    confirmedSoldCount: number;
    availableTickets: number;
    hasSeating: boolean;
    areas: Array<{ id: string; name: string; rowLabel?: string }>;
  }>;
  bookable: boolean;
}

export interface AvailabilityResult {
  available: boolean;
  capacity?: number;
  soldCount?: number;
  availableTickets?: number;
  message: string;
}

export interface CheckoutAction {
  type: "open_checkout" | "open_booking" | "open_tickets";
  label: string;
  payload: CheckoutActionPayload;
}

export interface AiccSensitiveLookupAccess {
  userId?: string;
  customerEmail?: string;
  customerPhone?: string;
}

export interface CheckoutActionPayload {
  checkoutUrl?: string;
  checkoutDeepLink?: string;
  bookingUrl?: string;
  ticketsUrl?: string;
  bookingCode?: string;
  eventId?: string;
  zoneId?: string;
  areaId?: string;
  timeSlotId?: string;
  quantity?: number;
  estimatedTotal?: number;
}

export interface GetEventDetailArgs {
  eventId: string;
}

export interface AvailabilityArgs {
  eventId: string;
  zoneId?: string;
}

export interface CheckoutContextArgs {
  eventId: string;
  zoneId?: string;
  areaId?: string;
  timeSlotId?: string;
  quantity: number;
}

export interface CheckoutContextResult {
  canCheckout: boolean;
  reason?: string;
  event?: { id: string; title: string };
  selection: {
    eventId: string;
    zoneId?: string;
    areaId?: string;
    timeSlotId?: string;
    quantity: number;
  };
  estimatedTotal?: number;
  checkoutDeepLink?: string;
  suggestedZones?: Array<{
    id: string;
    name: string;
    price: number;
    availableTickets: number;
  }>;
}

export type BookingNextAction =
  "pay_now" | "wait_payment" | "contact_support" | "view_ticket" | "none";

export interface BookingStatusExplanationResult {
  found: boolean;
  bookingCode?: string;
  status?: string;
  paymentStatus?: string;
  explanation: string;
  nextAction: BookingNextAction;
}

export interface PaymentStatusExplanationResult {
  found: boolean;
  status?: string;
  explanation: string;
  shouldHandoff: boolean;
  handoffReason?: string;
}

export interface BookingLookupArgs {
  bookingCode?: string;
  email?: string;
  phone?: string;
  access?: AiccSensitiveLookupAccess;
}

export interface BookingStatusExplanationArgs {
  bookingCode: string;
  access?: AiccSensitiveLookupAccess;
}

export interface BookingLookupResult {
  found: boolean;
  booking?: {
    id: string;
    bookingCode: string;
    status: string;
    paymentStatus: string;
    quantity: number;
    totalPrice: number;
    expiresAt: string;
    event?: EventSummary;
    zone?: { id: string; name: string; price?: number };
    area?: { id: string; name: string; rowLabel?: string };
  };
}

export interface PaymentLookupArgs {
  bookingId?: string;
  bookingCode?: string;
  paymentIntentId?: string;
  paypalOrderId?: string;
  access?: AiccSensitiveLookupAccess;
}

export interface PaymentStatusExplanationArgs {
  bookingCode?: string;
  paymentIntentId?: string;
  paypalOrderId?: string;
  access?: AiccSensitiveLookupAccess;
}

export interface PaymentLookupResult {
  found: boolean;
  payment?: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    paidAt?: string;
    refundedAt?: string;
    errorMessage?: string;
    bookingCode?: string;
  };
}

export interface TicketLookupArgs {
  ticketCode?: string;
  bookingCode?: string;
  access?: AiccSensitiveLookupAccess;
}

export interface TicketLookupResult {
  found: boolean;
  ticket?: {
    id: string;
    ticketCode: string;
    status: string;
    checkedInAt?: string;
    seatNumber?: string;
    event?: EventSummary;
    zone?: { id: string; name: string };
    area?: { id: string; name: string };
    bookingCode?: string;
  };
}

export interface KnowledgeSearchArgs {
  query: string;
  category?: string;
  topK?: number;
}

export interface KnowledgeDocumentSummary {
  id: string;
  title: string;
  category: string;
  version: number;
  contentSnippet: string;
  score?: number;
}

export interface KnowledgeSearchResult {
  documents: KnowledgeDocumentSummary[];
  belowThreshold: boolean;
}

export interface ToolFailureResult {
  errorCode: string;
  message: string;
}

export type AiccToolArgs =
  | SearchEventsArgs
  | GetEventDetailArgs
  | AvailabilityArgs
  | CheckoutContextArgs
  | BookingLookupArgs
  | BookingStatusExplanationArgs
  | PaymentLookupArgs
  | PaymentStatusExplanationArgs
  | TicketLookupArgs
  | KnowledgeSearchArgs;

export type AiccToolResult =
  | SearchEventsResult
  | GetEventDetailResult
  | AvailabilityResult
  | CheckoutContextResult
  | BookingLookupResult
  | BookingStatusExplanationResult
  | PaymentLookupResult
  | PaymentStatusExplanationResult
  | TicketLookupResult
  | KnowledgeSearchResult
  | ToolFailureResult;

export interface ExtractedEntities {
  objectId?: string;
  objectIds?: string[];
  eventId?: string;
  zoneId?: string;
  bookingCode?: string;
  ticketCode?: string;
  paymentIntentId?: string;
  paypalOrderId?: string;
  email?: string;
  phone?: string;
  search?: string;
  quantity?: number;
}
