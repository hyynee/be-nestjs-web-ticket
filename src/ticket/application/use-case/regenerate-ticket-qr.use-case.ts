import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Ticket } from "@src/schemas/ticket.schema";
import { TicketCacheService } from "@src/ticket/infrastructure/cache/ticket-cache.service";
import { TicketQrService } from "@src/ticket/infrastructure/qr/ticket-qr.service";
import { TicketPresenter } from "@src/ticket/presenters/ticket.presenter";
import { TicketIssuedItem } from "@src/ticket/types/ticket.types";
import { Model } from "mongoose";

const NON_REGENERATABLE_STATUSES = ["cancelled", "expired"] as const;

@Injectable()
export class RegenerateTicketQrUseCase {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    private readonly ticketQrService: TicketQrService,
    private readonly ticketCache: TicketCacheService,
    private readonly ticketPresenter: TicketPresenter
  ) {}

  async execute(ticketCode: string): Promise<TicketIssuedItem> {
    const normalizedCode = this.normalizeTicketCode(ticketCode);

    const ticket = await this.ticketModel.findOne({
      ticketCode: normalizedCode,
      isDeleted: false,
    });

    if (!ticket) {
      throw new NotFoundException("Ticket not found");
    }

    if (
      NON_REGENERATABLE_STATUSES.includes(
        ticket.status as (typeof NON_REGENERATABLE_STATUSES)[number]
      )
    ) {
      throw new BadRequestException(
        `Cannot regenerate QR for a ${ticket.status} ticket`
      );
    }

    // Upload uses `overwrite: false` (a ticket's QR image is immutable by
    // ticketCode once issued), so the previous asset MUST be deleted before
    // a new one can be uploaded at the same public_id — see
    // TicketQrService/UploadService.uploadQRCodeBuffer.
    await this.ticketQrService.deleteQRCode(normalizedCode);
    const qrCode = await this.ticketQrService.generateQRCode(normalizedCode);

    // Re-guard status on the write, not just the initial read above — the
    // ticket could have been cancelled/expired between the check and here
    // (rule.md 2.2: check-then-act is not sufficient on its own).
    const updated = await this.ticketModel.findOneAndUpdate(
      {
        _id: ticket._id,
        isDeleted: false,
        status: { $nin: NON_REGENERATABLE_STATUSES },
      },
      { $set: { qrCode } },
      { new: true }
    );

    if (!updated) {
      throw new ConflictException(
        "Ticket status changed and can no longer have its QR regenerated"
      );
    }

    await this.ticketCache.invalidateTicketCache();

    return this.ticketPresenter.toTicketIssuedItem(updated);
  }

  private normalizeTicketCode(ticketCode: string): string {
    if (typeof ticketCode !== "string" || !ticketCode.trim()) {
      throw new BadRequestException("Ticket code is required");
    }

    return ticketCode.trim().toUpperCase();
  }
}
