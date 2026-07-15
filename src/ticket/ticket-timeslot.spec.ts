import { Types } from "mongoose";
import { validateTimeSlotWindow } from "./ticket.service";
import type { TimeSlotWindow } from "./types/ticket.types";

const SLOT_LABEL = "Ca sáng";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const makeSlot = (startTime: Date, endTime: Date): TimeSlotWindow => ({
  _id: new Types.ObjectId(),
  label: SLOT_LABEL,
  startTime,
  endTime,
});

describe("validateTimeSlotWindow", () => {
  describe("valid cases", () => {
    it("returns valid when now is exactly at grace period start (30 min before slot)", () => {
      const start = new Date(Date.now() + 30 * MINUTE);
      const end = new Date(Date.now() + 2 * HOUR);
      const slot = makeSlot(start, end);
      expect(validateTimeSlotWindow(slot, new Date()).valid).toBe(true);
    });

    it("returns valid when now is exactly at slot startTime", () => {
      const now = new Date();
      const slot = makeSlot(now, new Date(now.getTime() + HOUR));
      expect(validateTimeSlotWindow(slot, now).valid).toBe(true);
    });

    it("returns valid when now is mid-slot", () => {
      const start = new Date(Date.now() - 30 * MINUTE);
      const end = new Date(Date.now() + 30 * MINUTE);
      const slot = makeSlot(start, end);
      expect(validateTimeSlotWindow(slot, new Date()).valid).toBe(true);
    });

    it("returns valid when now equals slot endTime exactly", () => {
      const now = new Date();
      const slot = makeSlot(new Date(now.getTime() - HOUR), now);
      expect(validateTimeSlotWindow(slot, now).valid).toBe(true);
    });
  });

  describe("too early — before grace period", () => {
    it("returns invalid when now is 31 minutes before slot start", () => {
      const start = new Date(Date.now() + 31 * MINUTE);
      const end = new Date(Date.now() + 2 * HOUR);
      const slot = makeSlot(start, end);
      const result = validateTimeSlotWindow(slot, new Date());
      expect(result.valid).toBe(false);
      expect(result.message).toContain(SLOT_LABEL);
      expect(result.message).toContain("check-in");
    });

    it("returns invalid for a slot starting 2 hours in the future", () => {
      const start = new Date(Date.now() + 2 * HOUR);
      const end = new Date(Date.now() + 3 * HOUR);
      const slot = makeSlot(start, end);
      expect(validateTimeSlotWindow(slot, new Date()).valid).toBe(false);
    });
  });

  describe("too late — after slot endTime", () => {
    it("returns invalid when now is 1 ms after endTime", () => {
      const end = new Date(Date.now() - 1);
      const start = new Date(end.getTime() - HOUR);
      const slot = makeSlot(start, end);
      const result = validateTimeSlotWindow(slot, new Date());
      expect(result.valid).toBe(false);
      expect(result.message).toContain("kết thúc");
    });

    it("returns invalid for a slot that ended an hour ago", () => {
      const end = new Date(Date.now() - HOUR);
      const start = new Date(end.getTime() - HOUR);
      const slot = makeSlot(start, end);
      expect(validateTimeSlotWindow(slot, new Date()).valid).toBe(false);
    });
  });

  describe("message content", () => {
    it("includes slot label in too-early message", () => {
      const start = new Date(Date.now() + 2 * HOUR);
      const end = new Date(Date.now() + 3 * HOUR);
      const slot = makeSlot(start, end);
      const result = validateTimeSlotWindow(slot, new Date());
      expect(result.message).toContain(SLOT_LABEL);
    });

    it("includes slot label in too-late message", () => {
      const end = new Date(Date.now() - HOUR);
      const start = new Date(end.getTime() - HOUR);
      const slot = makeSlot(start, end);
      const result = validateTimeSlotWindow(slot, new Date());
      expect(result.message).toContain(SLOT_LABEL);
    });
  });
});
