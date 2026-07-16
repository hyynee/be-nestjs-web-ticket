import * as ExcelJS from "exceljs";
import type { Response } from "express";

import { Parser } from "json2csv";

export type ExportCellValue = string | number | boolean | Date | null;
export type ExportRow = Record<string, ExportCellValue>;
export type ExportColumn = Partial<ExcelJS.Column>;

export function exportCSV(data: ExportRow[], fields: string[]): string {
  const parser = new Parser({ fields });
  return parser.parse(data);
}

export async function exportExcel(
  data: ExportRow[],
  columns: ExportColumn[],
  res: Response,
  fileName: string
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(fileName);

  sheet.columns = columns;
  data.forEach((row) => sheet.addRow(row));

  await workbook.xlsx.write(res);
}
