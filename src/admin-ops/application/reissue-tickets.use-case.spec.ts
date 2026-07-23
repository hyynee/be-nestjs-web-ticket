import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { ReissueTicketsUseCase } from "./reissue-tickets.use-case";

const admin: JwtPayload = { userId: "admin-1", role: "admin", iat: 0, exp: 0 };

describe("ReissueTicketsUseCase", () => {
  it("delegates to TicketService.createTicketsFromBooking and audits the result", async () => {
    const tickets = [{ id: "t1", ticketCode: "TK1" }];
    const ticketService = {
      createTicketsFromBooking: jest.fn().mockResolvedValue(tickets),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };

    const useCase = new ReissueTicketsUseCase(
      ticketService as never,
      auditService as never
    );

    const result = await useCase.execute("bk123", admin);

    expect(ticketService.createTicketsFromBooking).toHaveBeenCalledWith(
      "bk123"
    );
    expect(result).toEqual({ bookingCode: "BK123", tickets });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.ADMIN_BOOKING_REISSUE_TICKETS,
        actorId: admin.userId,
        metadata: { bookingCode: "bk123", ticketCount: 1 },
      })
    );
  });

  it("propagates a not-found/invalid booking error without auditing", async () => {
    const ticketService = {
      createTicketsFromBooking: jest
        .fn()
        .mockRejectedValue(new Error("Invalid booking code")),
    };
    const auditService = { record: jest.fn() };

    const useCase = new ReissueTicketsUseCase(
      ticketService as never,
      auditService as never
    );

    await expect(useCase.execute("bad-code", admin)).rejects.toThrow(
      "Invalid booking code"
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });
});
