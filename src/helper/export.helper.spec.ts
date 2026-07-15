import { exportCSV, exportExcel } from "./export.helper";
import { Parser } from "json2csv";

jest.mock("json2csv", () => ({
  Parser: jest.fn().mockImplementation(() => ({
    parse: jest.fn().mockReturnValue("col1,col2\nval1,val2"),
  })),
}));

describe("exportCSV", () => {
  it("returns CSV string from data and fields", () => {
    const result = exportCSV(
      [{ col1: "val1", col2: "val2" }],
      ["col1", "col2"]
    );
    expect(result).toBe("col1,col2\nval1,val2");
  });

  it("creates Parser with given fields", () => {
    exportCSV([{ a: 1 }], ["a"]);
    expect(Parser).toHaveBeenCalledWith({ fields: ["a"] });
  });
});

describe("exportExcel", () => {
  it("resolves without error", async () => {
    const writeMock = jest.fn();
    const res = { write: writeMock, end: jest.fn() } as any;
    const data = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
    ];
    const columns = [
      { header: "Name", key: "name" },
      { header: "Age", key: "age" },
    ];

    await expect(
      exportExcel(data, columns, res, "Sheet1")
    ).resolves.toBeUndefined();
  });
});
