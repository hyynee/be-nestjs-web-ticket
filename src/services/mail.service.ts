import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { QueueService } from "@src/queue/queue.service";
import config from "@src/config/config";
import * as nodemailer from "nodemailer";
import { Transporter } from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { BookingConfirmationData } from "@src/types/booking-modules";

export interface QueuedMailResult {
  status: "queued";
}

interface QrAttachmentAsset {
  cid: string;
  attachment?: Mail.Attachment;
  src: string;
}

@Injectable()
export class MailService {
  private transporter: Transporter;

  constructor(
    @Inject(forwardRef(() => QueueService))
    private readonly queueService: QueueService
  ) {
    const smtpPort = Number(config.SMTP_PORT);
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    });
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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
  ): QrAttachmentAsset {
    if (!qrCode) {
      return { cid: `qr-${ticketCode}`, src: "" };
    }

    const match = qrCode.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return { cid: `qr-${ticketCode}`, src: qrCode };
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

  private queued(): QueuedMailResult {
    return { status: "queued" };
  }

  async sendRegisterEmail(
    to: string,
    fullName: string
  ): Promise<QueuedMailResult> {
    await this.queueService.addJob({
      type: "send-register-email",
      payload: { to, fullName },
      requestedAt: new Date().toISOString(),
    });
    return this.queued();
  }

  async sendVerificationEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<QueuedMailResult> {
    await this.queueService.addJob({
      type: "send-verification-email",
      payload: { to, token, fullName },
      requestedAt: new Date().toISOString(),
    });
    return this.queued();
  }

  async sendPasswordResetEmail(
    email: string,
    resetToken: string,
    fullName: string
  ): Promise<QueuedMailResult> {
    await this.queueService.addJob({
      type: "send-password-reset",
      payload: { email, resetToken, fullName },
      requestedAt: new Date().toISOString(),
    });
    return this.queued();
  }

  async deliverRegisterEmail(to: string, fullName: string): Promise<void> {
    const safeName = this.escapeHtml(fullName);
    const safeEmail = this.escapeHtml(to);

    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to,
      subject: "Chào mừng bạn đến với Ticket System",
      html: `
        <html>
          <body style="font-family: Arial, sans-serif; background: #f3f4f6; padding: 20px;">
            <div style="max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px;">
              <h2 style="color: #111827;">Chào mừng ${safeName}!</h2>
              <p>Tài khoản của bạn đã được tạo thành công.</p>
              <p>Email đăng nhập: <strong>${safeEmail}</strong></p>
              <p>
                <a href="${config.FRONTEND_URL}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:white;text-decoration:none;border-radius:6px;">
                  Đến trang chủ
                </a>
              </p>
              <p>Trân trọng,<br/>Ticket System</p>
            </div>
          </body>
        </html>
      `,
    });
  }

  async deliverVerificationEmail(
    to: string,
    token: string,
    fullName: string
  ): Promise<void> {
    const safeName = this.escapeHtml(fullName);
    const verifyLink = `${config.FRONTEND_URL}/verify-email?token=${token}`;

    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to,
      subject: "Xác thực địa chỉ email",
      html: `
        <html>
          <body style="font-family: Arial, sans-serif; background: #f3f4f6; padding: 20px;">
            <div style="max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px;">
              <h2 style="color: #111827;">Xác thực email</h2>
              <p>Xin chào <strong>${safeName}</strong>,</p>
              <p>Nhấn vào liên kết bên dưới để xác thực địa chỉ email của bạn (có hiệu lực trong 24 giờ):</p>
              <p>
                <a href="${verifyLink}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:white;text-decoration:none;border-radius:6px;">
                  Xác thực email
                </a>
              </p>
              <p>Nếu bạn không tạo tài khoản này, hãy bỏ qua email này.</p>
              <p>Trân trọng,<br/>Ticket System</p>
            </div>
          </body>
        </html>
      `,
    });
  }

  async deliverPasswordResetEmail(
    email: string,
    resetToken: string,
    fullName: string
  ): Promise<void> {
    const safeName = this.escapeHtml(fullName);
    const resetLink = `${config.FRONTEND_URL}/reset-password?token=${resetToken}`;

    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to: email,
      subject: "Đặt lại mật khẩu",
      html: `
        <html>
          <body style="font-family: Arial, sans-serif; background: #f3f4f6; padding: 20px;">
            <div style="max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px;">
              <h2 style="color: #111827;">Đặt lại mật khẩu</h2>
              <p>Xin chào <strong>${safeName}</strong>,</p>
              <p>Nhấn vào liên kết bên dưới để đặt lại mật khẩu (có hiệu lực trong 1 giờ):</p>
              <p>
                <a href="${resetLink}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:white;text-decoration:none;border-radius:6px;">
                  Đặt lại mật khẩu
                </a>
              </p>
              <p>Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.</p>
              <p>Trân trọng,<br/>Ticket System</p>
            </div>
          </body>
        </html>
      `,
    });
  }

  async sendBookingConfirmation(
    data: BookingConfirmationData
  ): Promise<QueuedMailResult> {
    await this.queueService.addJob({
      type: "send-booking-confirmation",
      payload: data,
      requestedAt: new Date().toISOString(),
    });
    return this.queued();
  }

  async deliverBookingConfirmation(
    data: BookingConfirmationData
  ): Promise<void> {
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

    const safeCustomerName = this.escapeHtml(customerName);
    const safeBookingCode = this.escapeHtml(bookingCode);
    const safeEventTitle = this.escapeHtml(eventTitle);
    const safeEventLocation = this.escapeHtml(eventLocation);
    const safeZoneName = this.escapeHtml(zoneName);
    const formattedDate = this.formatDate(eventDate);
    const formattedPrice = this.formatPrice(totalPrice);

    const attachments: Mail.Attachment[] = [];

    const ticketsHtml = tickets
      .map((ticket, index) => {
        const qrAsset = this.buildQrAttachment(
          ticket.ticketCode,
          ticket.qrCode
        );
        if (qrAsset.attachment) {
          attachments.push(qrAsset.attachment);
        }

        const safeTicketCode = this.escapeHtml(ticket.ticketCode);
        const safeSeatNumber = ticket.seatNumber
          ? this.escapeHtml(ticket.seatNumber)
          : null;

        const qrSection = qrAsset.src
          ? `<img src="${qrAsset.src}" style="width:120px;height:120px;" />`
          : `<div style="width:120px;height:120px;display:flex;align-items:center;justify-content:center;border:1px dashed #d1d5db;color:#9ca3af;font-size:11px;">QR chưa sẵn sàng</div>`;

        return `
      <div style="background: white; padding: 20px; margin: 10px 0; border-radius: 8px; border: 2px solid #e5e7eb;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h3 style="margin: 0 0 10px 0; color: #111827;">Vé ${index + 1}</h3>
            <p><strong>Mã vé:</strong> ${safeTicketCode}</p>
            ${safeSeatNumber ? `<p><strong>Ghế:</strong> ${safeSeatNumber}</p>` : ""}
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

    const safeSeats = seats.map((s) => this.escapeHtml(s));

    const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; background:#f3f4f6; padding:20px;">
        <div style="max-width:600px;margin:auto;background:white;padding:20px;">
          <h2>Đặt vé thành công</h2>
          <p>Xin chào <strong>${safeCustomerName}</strong>,</p>
          <p>Đơn đặt vé của bạn đã được xác nhận.</p>

          <div style="background:#f9fafb;padding:15px;margin:20px 0;">
            <p><strong>Mã đặt vé:</strong> ${safeBookingCode}</p>
            <p><strong>Sự kiện:</strong> ${safeEventTitle}</p>
            <p><strong>Địa điểm:</strong> ${safeEventLocation}</p>
            <p><strong>Thời gian:</strong> ${formattedDate}</p>
            <p><strong>Khu vực:</strong> ${safeZoneName}</p>
            ${
              safeSeats.length
                ? `<p><strong>Ghế:</strong> ${safeSeats.join(", ")}</p>`
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

          <p>Trân trọng,<br/>Ticket System</p>
        </div>
      </body>
    </html>
    `;

    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to: email,
      subject: `Xác nhận đặt vé - ${safeBookingCode}`,
      html: htmlContent,
      attachments,
    });
  }

  async deliverExportReady(
    to: string,
    subject: string,
    csvContent: string,
    filename: string
  ): Promise<void> {
    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to,
      subject,
      html: `<p>File export của bạn đã sẵn sàng. Vui lòng xem file đính kèm.</p>`,
      attachments: [
        {
          filename,
          content: csvContent,
          contentType: "text/csv; charset=utf-8",
        },
      ],
    });
  }

  async sendEventReminder(data: {
    email: string;
    customerName: string;
    eventTitle: string;
    eventDate: Date;
    eventLocation: string;
    bookingCode: string;
  }): Promise<void> {
    const formattedDate = this.formatDate(data.eventDate);
    const safeName = this.escapeHtml(data.customerName);
    const safeTitle = this.escapeHtml(data.eventTitle);
    const safeLocation = this.escapeHtml(data.eventLocation);
    const safeCode = this.escapeHtml(data.bookingCode);

    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to: data.email,
      subject: `Nhắc nhở sự kiện sắp diễn ra`,
      html: `
        <p>Xin chào ${safeName},</p>
        <p>Sự kiện <strong>${safeTitle}</strong> sẽ diễn ra vào ${formattedDate}</p>
        <p>Địa điểm: ${safeLocation}</p>
        <p>Mã đặt vé: ${safeCode}</p>
      `,
    });
  }

  async deliverRefundFailureAlert(data: {
    to: string;
    bookingId: string;
    paymentRef: string;
    source: string;
    errorMessage: string;
    occurredAt: string;
  }): Promise<void> {
    const safe = (s: string) => this.escapeHtml(s);
    await this.transporter.sendMail({
      from: `"Ticket System ALERT" <${config.SMTP_USER}>`,
      to: data.to,
      subject: `[CRITICAL] Refund FAILED — bookingId=${safe(data.bookingId)}`,
      html: `
        <html>
          <body style="font-family: Arial, sans-serif; background: #fef2f2; padding: 20px;">
            <div style="max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px; border: 2px solid #ef4444;">
              <h2 style="color: #dc2626;">⚠️ Refund Failure — Manual Action Required</h2>
              <table style="width:100%;border-collapse:collapse;margin-top:16px;">
                <tr><td style="padding:6px;font-weight:bold;color:#374151;">Booking ID</td><td style="padding:6px;">${safe(data.bookingId)}</td></tr>
                <tr style="background:#f9fafb;"><td style="padding:6px;font-weight:bold;color:#374151;">Payment Ref</td><td style="padding:6px;">${safe(data.paymentRef)}</td></tr>
                <tr><td style="padding:6px;font-weight:bold;color:#374151;">Source</td><td style="padding:6px;">${safe(data.source)}</td></tr>
                <tr style="background:#f9fafb;"><td style="padding:6px;font-weight:bold;color:#374151;">Error</td><td style="padding:6px;color:#dc2626;">${safe(data.errorMessage)}</td></tr>
                <tr><td style="padding:6px;font-weight:bold;color:#374151;">Occurred At</td><td style="padding:6px;">${safe(data.occurredAt)}</td></tr>
              </table>
              <p style="margin-top:20px;color:#374151;">
                The automatic refund failed. A customer is owed money.<br/>
                Please issue a manual refund via the Stripe/PayPal dashboard immediately.
              </p>
            </div>
          </body>
        </html>
      `,
    });
  }

  async sendBookingCancellation(data: {
    email: string;
    customerName: string;
    bookingCode: string;
    eventTitle: string;
    refundAmount?: number;
  }): Promise<void> {
    const safeName = this.escapeHtml(data.customerName);
    const safeCode = this.escapeHtml(data.bookingCode);
    const safeTitle = this.escapeHtml(data.eventTitle);

    await this.transporter.sendMail({
      from: `"Ticket System" <${config.SMTP_USER}>`,
      to: data.email,
      subject: `Hủy đặt vé - ${safeCode}`,
      html: `
        <p>Xin chào ${safeName},</p>
        <p>Đặt vé ${safeCode} cho sự kiện ${safeTitle} đã được hủy.</p>
        ${data.refundAmount ? `<p>Số tiền hoàn lại: ${this.formatPrice(data.refundAmount)}</p>` : ""}
      `,
    });
  }
}
