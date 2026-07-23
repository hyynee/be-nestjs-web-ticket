import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { RegenerateTicketQrUseCase } from "./regenerate-ticket-qr.use-case";

describe("RegenerateTicketQrUseCase", () => {
  function makeUseCase(
    ticket: { status: string; ticketCode: string; qrCode?: string } | null,
    updated: unknown = { ticketCode: "TK1", status: "valid", qrCode: "new-url" }
  ) {
    const ticketModel = {
      findOne: jest.fn().mockResolvedValue(ticket),
      findOneAndUpdate: jest.fn().mockResolvedValue(updated),
    };
    const ticketQrService = {
      deleteQRCode: jest.fn().mockResolvedValue(undefined),
      generateQRCode: jest.fn().mockResolvedValue("new-url"),
    };
    const ticketCache = {
      invalidateTicketCache: jest.fn().mockResolvedValue(undefined),
    };
    const ticketPresenter = {
      toTicketIssuedItem: jest.fn((t: unknown) => t),
    };

    const useCase = new RegenerateTicketQrUseCase(
      ticketModel as never,
      ticketQrService as never,
      ticketCache as never,
      ticketPresenter as never
    );

    return { useCase, ticketModel, ticketQrService, ticketCache };
  }

  it("deletes the old QR asset before generating a new one, then updates the ticket", async () => {
    const { useCase, ticketModel, ticketQrService, ticketCache } = makeUseCase({
      status: "valid",
      ticketCode: "TK1",
      qrCode: "old-url",
    });

    const result = await useCase.execute("tk1");

    expect(ticketModel.findOne).toHaveBeenCalledWith({
      ticketCode: "TK1",
      isDeleted: false,
    });
    const deleteOrder =
      ticketQrService.deleteQRCode.mock.invocationCallOrder[0];
    const generateOrder =
      ticketQrService.generateQRCode.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(generateOrder);
    expect(ticketQrService.deleteQRCode).toHaveBeenCalledWith("TK1");
    expect(ticketQrService.generateQRCode).toHaveBeenCalledWith("TK1");
    expect(ticketModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        isDeleted: false,
        status: { $nin: ["cancelled", "expired"] },
      }),
      { $set: { qrCode: "new-url" } },
      { new: true }
    );
    expect(ticketCache.invalidateTicketCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ticketCode: "TK1",
      status: "valid",
      qrCode: "new-url",
    });
  });

  it("throws NotFoundException when the ticket does not exist", async () => {
    const { useCase } = makeUseCase(null);
    await expect(useCase.execute("tk-missing")).rejects.toThrow(
      NotFoundException
    );
  });

  it("throws BadRequestException for a cancelled ticket without touching QR storage", async () => {
    const { useCase, ticketQrService } = makeUseCase({
      status: "cancelled",
      ticketCode: "TK1",
    });

    await expect(useCase.execute("tk1")).rejects.toThrow(BadRequestException);
    expect(ticketQrService.deleteQRCode).not.toHaveBeenCalled();
  });

  it("throws BadRequestException for an expired ticket", async () => {
    const { useCase } = makeUseCase({ status: "expired", ticketCode: "TK1" });
    await expect(useCase.execute("tk1")).rejects.toThrow(BadRequestException);
  });

  it("rejects a blank ticket code before querying the database", async () => {
    const { useCase, ticketModel } = makeUseCase({
      status: "valid",
      ticketCode: "TK1",
    });

    await expect(useCase.execute("   ")).rejects.toThrow(BadRequestException);
    expect(ticketModel.findOne).not.toHaveBeenCalled();
  });

  it("throws ConflictException when the ticket's status changed (e.g. got cancelled) between the read and the guarded write", async () => {
    const { useCase } = makeUseCase(
      { status: "valid", ticketCode: "TK1" },
      null // findOneAndUpdate's status guard no longer matches -> null
    );

    await expect(useCase.execute("tk1")).rejects.toThrow(ConflictException);
  });
});
