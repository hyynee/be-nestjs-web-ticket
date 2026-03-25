/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { Injectable } from "@nestjs/common";
import { v2 as cloudinary } from "cloudinary";
import config from "@src/config/config";

@Injectable()
export class UploadService {
  constructor() {
    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
    });
  }

  async uploadBuffer(buffer: Buffer, options: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        options,
        (error, result) => {
          if (error) {
            const errorMessage =
              error instanceof Error
                ? error.message
                : "Cloudinary upload failed";
            reject(new Error(errorMessage));
            return;
          }

          resolve(result);
        }
      );
      stream.end(buffer);
    });
  }

  async uploadQRCode(base64: string, ticketCode: string): Promise<string> {
    if (!base64.includes(",")) {
      throw new Error("Invalid base64 format");
    }

    const base64Data = base64.split(",")[1];

    const result: any = await this.uploadBuffer(
      Buffer.from(base64Data, "base64"),
      {
        resource_type: "image",
        folder: "qrcodes",
        public_id: ticketCode,
        overwrite: false,
      }
    );

    return result.secure_url;
  }

  async deleteQRCode(ticketCode: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(`qrcodes/${ticketCode}`);
    } catch (error) {
      console.error("Delete QR error:", error);
    }
  }
}
