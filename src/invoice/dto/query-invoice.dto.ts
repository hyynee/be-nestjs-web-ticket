import { IsIn, IsOptional } from "class-validator";

export const INVOICE_DISPOSITIONS = ["attachment", "inline"] as const;

export class QueryInvoiceDto {
  @IsOptional()
  @IsIn(INVOICE_DISPOSITIONS)
  disposition?: (typeof INVOICE_DISPOSITIONS)[number] = "attachment";
}
