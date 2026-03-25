// mail.service.ts
import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { QueueService } from "@src/queue/queue.service";
import config from "@src/config/config";
import * as nodemailer from "nodemailer";
import { Transporter } from "nodemailer";

interface BookingConfirmationData {
  email: string;
  customerName: string;
  bookingCode: string;
  eventTitle: string;
  eventLocation: string;
  eventDate: Date;
  zoneName: string;
  seats: string[];
  quantity: number;
  totalPrice: number;
  currency: string;
  tickets?: Array<{
    ticketCode: string;
    seatNumber?: string;
    qrCode: string;
  }>;
}

@Injectable()
export class MailService {
  private transporter: Transporter;

  constructor(
    @Inject(forwardRef(() => QueueService)) private readonly queueService: QueueService
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: Number(config.SMTP_PORT),
      secure: false,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    });
  }

  private formatPrice(amount: number): string {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  }

  private formatDate(date: Date): string {
    return new Date(date).toLocaleString("vi-VN", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  private buildQrAttachment(
    ticketCode: string,
    qrCode: string
  ): {
    cid: string;
    attachment?: any;
    src: string;
  } {
    if (!qrCode) {
      return {
        cid: `qr-${ticketCode}`,
        src: "",
      };
    }

    const match = qrCode.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return {
        cid: `qr-${ticketCode}`,
        src: qrCode,
      };
    }

    const [, mimeType, base64Content] = match;
    const extension = mimeType.split("/")[1] || "png";
    const cid = `qr-${ticketCode}`;

    return {
      cid,
      src: `cid:${cid}`,
      attachment: {
        filename: `${ticketCode}.${extension}`,
        content: base64Content,
        encoding: "base64",
        contentType: mimeType,
        cid,
      },
    };
  }

  async sendRegisterEmail(to: string, fullName: string) {
    // Offload to queue
    await this.queueService.addJob({
      type: "send-register-email",
      payload: { to, fullName },
      requestedAt: new Date().toISOString(),
    });
    // Optionally, return immediately
    return { status: "queued" };
  }
  async sendPasswordResetEmail(to: string, resetTokenOrLink: string) {
    const resetLink = /^https?:\/\//i.test(resetTokenOrLink)
      ? resetTokenOrLink
      : `${config.FRONTEND_URL}/reset-password?token=${resetTokenOrLink}`;
    const mailOptions = {
      from: "Auth-backend service",
      to: to,
      subject: "Password Reset Request",
      html: `<p>You requested a password reset. Click the link below to reset your password:</p><p><a href="${resetLink}">Reset Password</a></p>`,
    };
    try {
      await this.transporter.sendMail(mailOptions);
    } catch (error) {
      console.error("Error sending email:", error);
    }
  }

  async sendBookingConfirmation(data: BookingConfirmationData) {
    const {
      email,
      customerName,
      bookingCode,
      eventTitle,
      eventLocation,
      eventDate,
      zoneName,
      seats,
      quantity,
      totalPrice,
      tickets = [],
    } = data;

    const formattedDate = this.formatDate(eventDate);
    const formattedPrice = this.formatPrice(totalPrice);

    const attachments: any[] = [];

    const ticketsHtml = tickets
      .map((ticket, index) => {
        const qrAsset = this.buildQrAttachment(
          ticket.ticketCode,
          ticket.qrCode
        );
        if (qrAsset.attachment) {
          attachments.push(qrAsset.attachment);
        }

        const qrSection = qrAsset.src
          ? `<img src="${qrAsset.src}" style="width:120px;height:120px;" />`
          : `<div style="width:120px;height:120px;display:flex;align-items:center;justify-content:center;border:1px dashed #d1d5db;color:#9ca3af;font-size:11px;">QR chưa sẵn sàng</div>`;

        return `
      <div style="background: white; padding: 20px; margin: 10px 0; border-radius: 8px; border: 2px solid #e5e7eb;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h3 style="margin: 0 0 10px 0; color: #111827;">Vé ${index + 1}</h3>
            <p><strong>Mã vé:</strong> ${ticket.ticketCode}</p>
            ${
              ticket.seatNumber
                ? `<p><strong>Ghế:</strong> ${ticket.seatNumber}</p>`
                : ""
            }
          </div>
          <div style="text-align: center;">
            ${qrSection}
            <p style="font-size:12px;color:#6b7280;">Quét mã để check-in</p>
          </div>
        </div>
      </div>
    `;
      })
      .join("");

    const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; background:#f3f4f6; padding:20px;">
        <div style="max-width:600px;margin:auto;background:white;padding:20px;">
          <h2>Đặt vé thành công</h2>
          <p>Xin chào <strong>${customerName}</strong>,</p>
          <p>Đơn đặt vé của bạn đã được xác nhận.</p>

          <div style="background:#f9fafb;padding:15px;margin:20px 0;">
            <p><strong>Mã đặt vé:</strong> ${bookingCode}</p>
            <p><strong>Sự kiện:</strong> ${eventTitle}</p>
            <p><strong>Địa điểm:</strong> ${eventLocation}</p>
            <p><strong>Thời gian:</strong> ${formattedDate}</p>
            <p><strong>Khu vực:</strong> ${zoneName}</p>
            ${
              seats.length
                ? `<p><strong>Ghế:</strong> ${seats.join(", ")}</p>`
                : `<p><strong>Số lượng vé:</strong> ${quantity}</p>`
            }
            <p style="font-size:18px;"><strong>Tổng tiền:</strong> ${formattedPrice}</p>
          </div>

          ${tickets.length ? `<h3>Danh sách vé</h3>${ticketsHtml}` : ""}

          <p>
            <a href="${config.FRONTEND_URL}/my-tickets">Xem vé của tôi</a>
          </p>

          <p>Lưu ý:</p>
          <ul>
            <li>Mang theo mã QR khi check-in</li>
            <li>Đến trước thời gian diễn ra ít nhất 30 phút</li>
            <li>Vé chỉ có giá trị sử dụng một lần</li>
          </ul>

          <p>Trân trọng,<br/>Nguyễn Anh Huy - Sai Gon University</p>
        </div>
      </body>
    </html>
    `;

    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to: email,
      subject: `Xác nhận đặt vé - ${bookingCode}`,
      html: htmlContent,
      attachments,
    });
  }

  async sendEventReminder(data: {
    email: string;
    customerName: string;
    eventTitle: string;
    eventDate: Date;
    eventLocation: string;
    bookingCode: string;
  }) {
    const formattedDate = this.formatDate(data.eventDate);

    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to: data.email,
      subject: `Nhắc nhở sự kiện sắp diễn ra`,
      html: `
        <p>Xin chào ${data.customerName},</p>
        <p>Sự kiện <strong>${data.eventTitle}</strong> sẽ diễn ra vào ${formattedDate}</p>
        <p>Địa điểm: ${data.eventLocation}</p>
        <p>Mã đặt vé: ${data.bookingCode}</p>
      `,
    });
  }

  async sendBookingCancellation(data: {
    email: string;
    customerName: string;
    bookingCode: string;
    eventTitle: string;
    refundAmount?: number;
  }) {
    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to: data.email,
      subject: `Hủy đặt vé - ${data.bookingCode}`,
      html: `
        <p>Xin chào ${data.customerName},</p>
        <p>Đặt vé ${data.bookingCode} cho sự kiện ${data.eventTitle} đã được hủy.</p>
        ${
          data.refundAmount
            ? `<p>Số tiền hoàn lại: ${this.formatPrice(data.refundAmount)}</p>`
            : ""
        }
      `,
    });
  }
}
