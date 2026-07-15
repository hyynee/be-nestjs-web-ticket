export enum QueueJobType {
  SEND_REGISTER_EMAIL = "send-register-email",
  SEND_VERIFICATION_EMAIL = "send-verification-email",
  SEND_PASSWORD_RESET = "send-password-reset",
  SEND_BOOKING_CONFIRMATION = "send-booking-confirmation",
  FINALIZE_TICKET_DELIVERY = "finalize-ticket-delivery",
  REFUND_FAILURE_ALERT = "refund-failure-alert",
  EXPORT_TICKETS = "export-tickets",
  EXPORT_CHECKIN_ZONES = "export-checkin-zones",
}
