import { TimeSlotWindow } from "@src/ticket/types/ticket.types";

export const CHECKIN_GRACE_MS = 30 * 60 * 1000;

export function validateTimeSlotWindow(
  slot: TimeSlotWindow,
  now: Date
): { valid: boolean; message?: string } {
  const earliest = new Date(slot.startTime.getTime() - CHECKIN_GRACE_MS);
  if (now < earliest) {
    return {
      valid: false,
      message: `Chưa tới giờ check-in cho khung giờ "${slot.label}" (từ ${earliest.toISOString()})`,
    };
  }
  if (now > slot.endTime) {
    return {
      valid: false,
      message: `Khung giờ "${slot.label}" đã kết thúc lúc ${slot.endTime.toISOString()}`,
    };
  }
  return { valid: true };
}
