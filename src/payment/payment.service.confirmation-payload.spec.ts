import { PaymentService } from "./payment.service";
import { BookingForConfirmationMail } from "./types/payment.types";

jest.mock("stripe", () => jest.fn().mockImplementation(() => ({})));

jest.mock("@paypal/checkout-server-sdk", () => ({
  core: {
    SandboxEnvironment: jest.fn(),
    LiveEnvironment: jest.fn(),
    PayPalHttpClient: jest
      .fn()
      .mockImplementation(() => ({ execute: jest.fn() })),
  },
  orders: {
    OrdersCreateRequest: jest.fn(),
    OrdersCaptureRequest: jest.fn(),
    OrdersGetRequest: jest.fn(),
  },
  payments: {
    CapturesRefundRequest: jest.fn(),
  },
}));

jest.mock("@src/config/config", () => ({
  default: {
    STRIPE_SECRET_KEY: "sk_test_fake",
    PAYPAL_CLIENT_ID: "fake_paypal_id",
    PAYPAL_CLIENT_SECRET: "fake_paypal_secret",
    FRONTEND_URL: "http://localhost:3000",
  },
}));

// buildBookingConfirmationPayload() is a pure, synchronous field-mapping
// helper with no DB/Stripe/PayPal calls, so a real PaymentService instance
// with stubbed constructor deps is enough — no need to reproduce the full
// webhook transaction mocking that the rest of payment.service.spec.ts uses.
describe("PaymentService — buildBookingConfirmationPayload (snapshot preference)", () => {
  let service: any;

  beforeEach(() => {
    service = new PaymentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
  });

  const baseBooking = (
    overrides: Partial<BookingForConfirmationMail> = {}
  ): BookingForConfirmationMail => ({
    bookingCode: "BK-001",
    customerEmail: "user@example.com",
    customerName: "Nguyen Van A",
    eventId: {
      title: "Live event title",
      location: "Live location",
      startDate: new Date("2030-06-01T00:00:00.000Z"),
    },
    zoneId: { name: "Live zone name" },
    seats: ["A1"],
    quantity: 1,
    totalPrice: 100_000,
    ...overrides,
  });

  it("falls back to populated eventId/zoneId when snapshot is absent (bookings created before this field existed)", () => {
    const booking = baseBooking();

    const payload = service.buildBookingConfirmationPayload(
      booking,
      "VND",
      100_000
    );

    expect(payload.eventTitle).toBe("Live event title");
    expect(payload.eventLocation).toBe("Live location");
    expect(payload.eventDate).toEqual(new Date("2030-06-01T00:00:00.000Z"));
    expect(payload.zoneName).toBe("Live zone name");
  });

  it("prefers the immutable snapshot over the (possibly since-changed) populated eventId/zoneId", () => {
    const booking = baseBooking({
      snapshot: {
        eventTitle: "Snapshot event title",
        location: "Snapshot location",
        eventStartDate: new Date("2029-01-01T00:00:00.000Z"),
        zoneName: "Snapshot zone name",
      },
    });

    const payload = service.buildBookingConfirmationPayload(
      booking,
      "VND",
      100_000
    );

    expect(payload.eventTitle).toBe("Snapshot event title");
    expect(payload.eventLocation).toBe("Snapshot location");
    expect(payload.eventDate).toEqual(new Date("2029-01-01T00:00:00.000Z"));
    expect(payload.zoneName).toBe("Snapshot zone name");
  });
});
