import { AiccOutcome, AiccSessionPhase } from "../schemas/aicc-session.schema";
import { AiccIntent } from "./aicc-intents";

export function phaseForIntent(intent: AiccIntent): AiccSessionPhase {
  if (intent === AiccIntent.UNKNOWN) {
    return AiccSessionPhase.IDENTIFY_INTENT;
  }
  if (
    intent === AiccIntent.HUMAN_REQUEST ||
    intent === AiccIntent.COMPLAINT ||
    intent === AiccIntent.REFUND_POLICY
  ) {
    return AiccSessionPhase.COLLECTING;
  }
  return AiccSessionPhase.EXECUTING;
}

export function outcomeForIntent(intent: AiccIntent): AiccOutcome {
  if (
    intent === AiccIntent.EVENT_SEARCH ||
    intent === AiccIntent.EVENT_DETAIL ||
    intent === AiccIntent.TICKET_AVAILABILITY
  ) {
    return AiccOutcome.EVENT_INFO;
  }
  if (intent === AiccIntent.BOOKING_LOOKUP) {
    return AiccOutcome.BOOKING_SUPPORT;
  }
  if (intent === AiccIntent.PAYMENT_LOOKUP) {
    return AiccOutcome.PAYMENT_SUPPORT;
  }
  if (
    intent === AiccIntent.TICKET_LOOKUP ||
    intent === AiccIntent.CHECKIN_SUPPORT
  ) {
    return AiccOutcome.TICKET_SUPPORT;
  }
  if (
    intent === AiccIntent.HUMAN_REQUEST ||
    intent === AiccIntent.COMPLAINT ||
    intent === AiccIntent.REFUND_POLICY
  ) {
    return AiccOutcome.HANDOFF;
  }
  return AiccOutcome.UNKNOWN;
}
