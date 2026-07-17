import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Types } from "mongoose";
import { PromotionType } from "@src/schemas/promotion.schema";
import { PromotionRedemptionService } from "./application/promotion-redemption.service";
import { PromotionPolicyService } from "./domain/policies/promotion-policy.service";

const mockLeanChain = <T>(value: T) => ({
  select: jest.fn().mockReturnThis(),
  session: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

const mockCountChain = (value: number) => ({
  session: jest.fn().mockResolvedValue(value),
});

describe("PromotionService", () => {
  const promotionId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const bookingId = new Types.ObjectId();
  const eventId = new Types.ObjectId();
  const zoneId = new Types.ObjectId();

  let promotionModel: {
    create: jest.Mock;
    find: jest.Mock;
    countDocuments: jest.Mock;
    findById: jest.Mock;
    findByIdAndUpdate: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
    updateOne: jest.Mock;
  };
  let promotionUsageModel: {
    create: jest.Mock;
    countDocuments: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  let zoneModel: { find: jest.Mock; findOne: jest.Mock };
  let ownershipService: {
    assertCanManageEvent: jest.Mock;
    getManagedEventIds: jest.Mock;
  };
  let service: PromotionRedemptionService;

  const activePromotion = {
    _id: promotionId,
    code: "SAVE20",
    type: PromotionType.PERCENT,
    value: 20,
    eventIds: [eventId],
    zoneIds: [zoneId],
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 60_000),
    maxUses: 10,
    maxUsesPerUser: 2,
    usedCount: 0,
    minOrderAmount: 100_000,
    isActive: true,
    createdBy: userId,
  };

  beforeEach(() => {
    promotionModel = {
      create: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
    };
    promotionUsageModel = {
      create: jest.fn(),
      countDocuments: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    zoneModel = {
      find: jest.fn(),
      findOne: jest.fn(),
    };
    ownershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
      getManagedEventIds: jest.fn().mockResolvedValue([]),
    };

    const policy = new PromotionPolicyService(
      zoneModel as never,
      ownershipService as never
    );
    service = new PromotionRedemptionService(
      promotionModel as never,
      promotionUsageModel as never,
      policy
    );

    zoneModel.findOne.mockReturnValue(mockLeanChain({ _id: zoneId }));
    promotionModel.findOne.mockReturnValue(mockLeanChain(activePromotion));
    promotionUsageModel.countDocuments.mockReturnValue(mockCountChain(0));
  });

  it("validates a scoped percent promotion and calculates discount from original amount", async () => {
    const result = await service.validatePromotion(
      {
        code: " save20 ",
        eventId: eventId.toString(),
        zoneId: zoneId.toString(),
        orderAmount: 500_000,
      },
      userId.toString()
    );

    expect(result).toEqual({
      valid: true,
      promotionId: promotionId.toString(),
      code: "SAVE20",
      type: PromotionType.PERCENT,
      value: 20,
      originalAmount: 500_000,
      discountAmount: 100_000,
      finalAmount: 400_000,
    });
  });

  it("rejects expired promotions", async () => {
    promotionModel.findOne.mockReturnValue(
      mockLeanChain({
        ...activePromotion,
        endsAt: new Date(Date.now() - 1_000),
      })
    );

    await expect(
      service.validatePromotion({
        code: "SAVE20",
        eventId: eventId.toString(),
        zoneId: zoneId.toString(),
        orderAmount: 500_000,
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects inactive promotions", async () => {
    promotionModel.findOne.mockReturnValue(
      mockLeanChain({ ...activePromotion, isActive: false })
    );

    await expect(
      service.validatePromotion({
        code: "SAVE20",
        eventId: eventId.toString(),
        zoneId: zoneId.toString(),
        orderAmount: 500_000,
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects promotions outside the event or zone scope", async () => {
    promotionModel.findOne.mockReturnValue(
      mockLeanChain({
        ...activePromotion,
        eventIds: [new Types.ObjectId()],
      })
    );

    await expect(
      service.validatePromotion({
        code: "SAVE20",
        eventId: eventId.toString(),
        zoneId: zoneId.toString(),
        orderAmount: 500_000,
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects exhausted global usage limit", async () => {
    promotionModel.findOne.mockReturnValue(
      mockLeanChain({
        ...activePromotion,
        usedCount: 10,
      })
    );

    await expect(
      service.validatePromotion({
        code: "SAVE20",
        eventId: eventId.toString(),
        zoneId: zoneId.toString(),
        orderAmount: 500_000,
      })
    ).rejects.toThrow(ConflictException);
  });

  it("rejects per-user usage limit", async () => {
    promotionUsageModel.countDocuments.mockReturnValue(mockCountChain(2));

    await expect(
      service.validatePromotion(
        {
          code: "SAVE20",
          eventId: eventId.toString(),
          zoneId: zoneId.toString(),
          orderAmount: 500_000,
        },
        userId.toString()
      )
    ).rejects.toThrow(ConflictException);
  });

  it("applies promotion to booking atomically and creates a usage record", async () => {
    promotionModel.findOneAndUpdate.mockReturnValue(
      mockLeanChain({ ...activePromotion, usedCount: 1 })
    );
    promotionUsageModel.create.mockResolvedValue([
      { _id: new Types.ObjectId() },
    ]);

    const result = await service.applyPromotionToBooking(
      {
        code: "SAVE20",
        userId: userId.toString(),
        eventId: eventId.toString(),
        zoneId: zoneId.toString(),
        bookingId: bookingId.toString(),
        orderAmount: 500_000,
      },
      {} as never
    );

    expect(promotionModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: promotionId,
        isActive: true,
        type: PromotionType.PERCENT,
        value: 20,
      }),
      { $inc: { usedCount: 1 } },
      { new: true, session: {} }
    );
    expect(promotionUsageModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          promotionId,
          code: "SAVE20",
          userId,
          bookingId,
          discountAmount: 100_000,
          usageOrdinal: 1,
        }),
      ],
      { session: {} }
    );
    expect(result.finalAmount).toBe(400_000);
  });

  it("throws NotFoundException for unknown promotion code", async () => {
    promotionModel.findOne.mockReturnValue(mockLeanChain(null));

    await expect(
      service.validatePromotion({
        code: "MISSING",
        eventId: eventId.toString(),
        zoneId: zoneId.toString(),
        orderAmount: 500_000,
      })
    ).rejects.toThrow(NotFoundException);
  });

  it("releases usage idempotently and never decrements usedCount below zero", async () => {
    promotionUsageModel.findOneAndUpdate.mockReturnValue(
      mockLeanChain({ promotionId })
    );

    await service.releaseUsageForBooking(bookingId, {} as never);

    expect(promotionUsageModel.findOneAndUpdate).toHaveBeenCalledWith(
      { bookingId, releasedAt: { $exists: false } },
      { $set: { releasedAt: expect.any(Date) } },
      { new: false, session: {} }
    );
    expect(promotionModel.updateOne).toHaveBeenCalledWith(
      { _id: promotionId },
      [
        {
          $set: {
            usedCount: {
              $max: [{ $subtract: ["$usedCount", 1] }, 0],
            },
          },
        },
      ],
      { session: {} }
    );
  });
});
