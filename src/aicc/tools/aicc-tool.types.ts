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
  args: Record<string, unknown>;
  result: Record<string, unknown>;
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

export interface SearchEventsResult extends Record<string, unknown> {
  events: EventSummary[];
}

export interface GetEventDetailResult extends Record<string, unknown> {
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

export interface AvailabilityResult extends Record<string, unknown> {
  available: boolean;
  capacity?: number;
  soldCount?: number;
  availableTickets?: number;
  message: string;
}

export interface CheckoutAction {
  type: "open_checkout" | "open_booking" | "open_tickets";
  label: string;
  payload: Record<string, unknown>;
}

export interface AiccSensitiveLookupAccess {
  userId?: string;
  customerEmail?: string;
  customerPhone?: string;
}

export interface CheckoutContextResult extends Record<string, unknown> {
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

export interface BookingStatusExplanationResult extends Record<
  string,
  unknown
> {
  found: boolean;
  bookingCode?: string;
  status?: string;
  paymentStatus?: string;
  explanation: string;
  nextAction: BookingNextAction;
}

export interface PaymentStatusExplanationResult extends Record<
  string,
  unknown
> {
  found: boolean;
  status?: string;
  explanation: string;
  shouldHandoff: boolean;
  handoffReason?: string;
}

export interface BookingLookupResult extends Record<string, unknown> {
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

export interface PaymentLookupResult extends Record<string, unknown> {
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

export interface TicketLookupResult extends Record<string, unknown> {
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

export interface KnowledgeSearchResult extends Record<string, unknown> {
  documents: KnowledgeDocumentSummary[];
  belowThreshold: boolean;
}

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
