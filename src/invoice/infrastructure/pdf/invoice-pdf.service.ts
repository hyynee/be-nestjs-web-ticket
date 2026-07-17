import { Injectable } from "@nestjs/common";
import PDFDocument from "pdfkit";
import type { InvoiceData } from "@src/invoice/types/invoice.types";

@Injectable()
export class InvoicePdfService {
  generate(data: InvoiceData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks: Buffer[] = [];

      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      this.renderHeader(doc, data);
      this.renderParties(doc, data);
      this.renderEventInfo(doc, data);
      this.renderLineItems(doc, data);
      this.renderTotals(doc, data);
      this.renderFooter(doc);

      doc.end();
    });
  }

  private formatCurrency(amount: number, currency: string): string {
    const upper = (currency || "vnd").toUpperCase();
    if (upper === "VND") {
      return `${Math.round(amount).toLocaleString("vi-VN")} VND`;
    }
    return `${amount.toLocaleString("en-US")} ${upper}`;
  }

  private formatDate(date?: Date | string): string {
    if (!date) return "N/A";
    return new Date(date).toLocaleString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  private renderHeader(doc: PDFKit.PDFDocument, data: InvoiceData): void {
    doc.fontSize(20).text("HOA DON / RECEIPT", { align: "center" });
    doc.moveDown(0.3);
    doc
      .fontSize(10)
      .fillColor("#555555")
      .text(`Ma dat ve: ${data.bookingCode}`, { align: "center" });
    doc.fillColor("#000000");
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#dddddd").stroke();
    doc.moveDown(1);
  }

  private renderParties(doc: PDFKit.PDFDocument, data: InvoiceData): void {
    doc.fontSize(11).fillColor("#000000");
    doc.text(`Khach hang: ${data.customerName}`);
    doc.text(`Email: ${data.customerEmail}`);
    doc.text(`Trang thai thanh toan: ${data.paymentStatus}`);
    if (data.paymentMethod) {
      doc.text(`Phuong thuc: ${data.paymentMethod}`);
    }
    if (data.paymentProvider) {
      doc.text(`Cong thanh toan: ${data.paymentProvider}`);
    }
    doc.text(`Ngay thanh toan: ${this.formatDate(data.paidAt)}`);
    doc.moveDown(1);
  }

  private renderEventInfo(doc: PDFKit.PDFDocument, data: InvoiceData): void {
    doc.fontSize(13).text("Thong tin su kien", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(11);
    doc.text(`Su kien: ${data.eventTitle}`);
    doc.text(`Thoi gian: ${this.formatDate(data.eventDate)}`);
    doc.text(`Dia diem: ${data.location}`);
    doc.text(
      `Khu vuc: ${data.zoneName}${data.areaName ? ` - ${data.areaName}` : ""}`
    );
    if (data.seats?.length) {
      doc.text(`Ghe: ${data.seats.join(", ")}`);
    }
    doc.moveDown(1);
  }

  private renderLineItems(doc: PDFKit.PDFDocument, data: InvoiceData): void {
    doc.fontSize(13).text("Chi tiet", { underline: true });
    doc.moveDown(0.5);

    const tableTop = doc.y;
    doc.fontSize(10).fillColor("#555555");
    doc.text("Noi dung", 50, tableTop);
    doc.text("SL", 300, tableTop, { width: 50, align: "right" });
    doc.text("Don gia", 360, tableTop, { width: 90, align: "right" });
    doc.text("Thanh tien", 455, tableTop, { width: 90, align: "right" });

    doc
      .moveTo(50, tableTop + 15)
      .lineTo(545, tableTop + 15)
      .strokeColor("#dddddd")
      .stroke();

    const rowY = tableTop + 22;
    doc.fillColor("#000000").fontSize(10);
    doc.text(`Ve ${data.zoneName}`, 50, rowY, { width: 240 });
    doc.text(String(data.quantity), 300, rowY, { width: 50, align: "right" });
    doc.text(this.formatCurrency(data.unitPrice, data.currency), 360, rowY, {
      width: 90,
      align: "right",
    });
    doc.text(
      this.formatCurrency(data.unitPrice * data.quantity, data.currency),
      455,
      rowY,
      { width: 90, align: "right" }
    );

    doc.moveDown(3);
  }

  private renderTotals(doc: PDFKit.PDFDocument, data: InvoiceData): void {
    const subtotal = data.unitPrice * data.quantity;
    const startY = doc.y;

    doc.fontSize(10);
    doc.text("Tam tinh:", 360, startY, { width: 90, align: "right" });
    doc.text(this.formatCurrency(subtotal, data.currency), 455, startY, {
      width: 90,
      align: "right",
    });

    let currentY = startY + 16;
    if (data.discount > 0) {
      doc.text("Giam gia:", 360, currentY, { width: 90, align: "right" });
      doc.text(
        `-${this.formatCurrency(data.discount, data.currency)}`,
        455,
        currentY,
        { width: 90, align: "right" }
      );
      currentY += 16;
    }

    doc.fontSize(11).font("Helvetica-Bold");
    doc.text("Tong thanh toan:", 360, currentY, { width: 90, align: "right" });
    doc.text(
      this.formatCurrency(data.totalPrice, data.currency),
      455,
      currentY,
      { width: 90, align: "right" }
    );
    doc.font("Helvetica");
    currentY += 20;

    if (data.refundedAmount > 0) {
      doc.fontSize(10).fillColor("#dc2626");
      doc.text("Da hoan tien:", 360, currentY, { width: 90, align: "right" });
      doc.text(
        this.formatCurrency(data.refundedAmount, data.currency),
        455,
        currentY,
        { width: 90, align: "right" }
      );
      doc.fillColor("#000000");
      currentY += 16;
    }

    doc.y = currentY + 20;
  }

  private renderFooter(doc: PDFKit.PDFDocument): void {
    doc
      .fontSize(9)
      .fillColor("#888888")
      .text("Day la hoa don dien tu, khong can dong dau/ky ten.", 50, doc.y, {
        align: "center",
        width: 495,
      });
  }
}
