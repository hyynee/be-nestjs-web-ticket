import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { RegenerateTicketQrAdminUseCase } from "./regenerate-ticket-qr.use-case";

const admin: JwtPayload = { userId: "admin-1", role: "admin", iat: 0, exp: 0 };

describe("RegenerateTicketQrAdminUseCase", () => {
  it("delegates to TicketService.regenerateQrCode and audits with the ticket id", async () => {
    const ticket = { id: "ticket-1", ticketCode: "TK1", qrCode: "url" };
    const ticketService = {
      regenerateQrCode: jest.fn().mockResolvedValue(ticket),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };

    const useCase = new RegenerateTicketQrAdminUseCase(
      ticketService as never,
      auditService as never
    );

    const result = await useCase.execute("tk1", admin);

    expect(ticketService.regenerateQrCode).toHaveBeenCalledWith("tk1");
    expect(result).toBe(ticket);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.ADMIN_TICKET_REGENERATE_QR,
        actorId: admin.userId,
        ticketId: "ticket-1",
        metadata: { ticketCode: "TK1" },
      })
    );
  });

  it("propagates errors for a cancelled/expired ticket without auditing", async () => {
    const ticketService = {
      regenerateQrCode: jest
        .fn()
        .mockRejectedValue(
          new Error("Cannot regenerate QR for a cancelled ticket")
        ),
    };
    const auditService = { record: jest.fn() };

    const useCase = new RegenerateTicketQrAdminUseCase(
      ticketService as never,
      auditService as never
    );

    await expect(useCase.execute("tk1", admin)).rejects.toThrow(
      "Cannot regenerate QR for a cancelled ticket"
    );
    expect(auditService.record).not.toHaveBeenCalled();
  });
});
