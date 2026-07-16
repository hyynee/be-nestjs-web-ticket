import * as crypto from "crypto";
import { Injectable } from "@nestjs/common";

@Injectable()
export class BookingCodeService {
  generateBookingCode(): string {
    const date = new Date();
    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const timestamp =
      date.getHours().toString().padStart(2, "0") +
      date.getMinutes().toString().padStart(2, "0") +
      date.getSeconds().toString().padStart(2, "0");
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();

    return `BK${year}${month}${day}${timestamp}${random}`;
  }
}
