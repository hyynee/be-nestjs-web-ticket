import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { UploadService } from "@src/upload/upload.service";
import * as QRCode from "qrcode";

@Injectable()
export class TicketQrService {
  private readonly logger = new Logger(TicketQrService.name);

  constructor(private readonly uploadService: UploadService) {}

  async generateQRCode(ticketCode: string): Promise<string> {
    try {
      const buffer = await QRCode.toBuffer(ticketCode, {
        errorCorrectionLevel: "H",
        type: "png",
        width: 300,
        margin: 1,
      });
      return this.uploadService.uploadQRCodeBuffer(buffer, ticketCode);
    } catch (error) {
      this.logger.error(
        `Error generating QR code for ${ticketCode}: ${(error as Error)?.message ?? String(error)}`
      );
      throw new BadRequestException("Failed to generate QR code");
    }
  }

  async deleteQRCode(ticketCode: string): Promise<void> {
    await this.uploadService
      .deleteQRCode(ticketCode)
      .catch((error: unknown) => {
        this.logger.warn(
          `deleteQRCode failed for ${ticketCode}: ${(error as Error)?.message ?? String(error)}`
        );
      });
  }
}
