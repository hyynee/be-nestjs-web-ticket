import * as ExcelJS from 'exceljs';


import { Parser } from 'json2csv';

export function exportCSV(
  data: any[],
  fields: string[],
): string {
  const parser = new Parser({ fields });
  return parser.parse(data);
}


export async function exportExcel(
  data: any[],
  columns: any[],
  res: any,
  fileName: string,
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(fileName);

  sheet.columns = columns;
  data.forEach(row => sheet.addRow(row));

  await workbook.xlsx.write(res);
}

