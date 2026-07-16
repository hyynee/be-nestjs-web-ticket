export const getPaymentErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown error";
