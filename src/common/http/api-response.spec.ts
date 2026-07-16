import { HttpStatus } from "@nestjs/common";
import { ApiResponse } from "./api-response";

describe("ApiResponse", () => {
  it("builds a success envelope with schema metadata", () => {
    const result = ApiResponse.success({
      data: { id: "booking-1" },
      statusCode: HttpStatus.CREATED,
      message: "Created",
      path: "/api/v1/booking",
      correlationId: "req-1",
    });

    expect(result).toMatchObject({
      success: true,
      schemaVersion: "v1",
      statusCode: 201,
      code: "CREATED",
      message: "Created",
      data: { id: "booking-1" },
      path: "/api/v1/booking",
      correlationId: "req-1",
    });
    expect(result.timestamp).toEqual(expect.any(String));
  });

  it("builds an error envelope with a stable code", () => {
    const result = ApiResponse.error({
      statusCode: HttpStatus.BAD_REQUEST,
      code: "VALIDATION_ERROR",
      message: ["email must be an email"],
    });

    expect(result).toMatchObject({
      success: false,
      schemaVersion: "v1",
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: ["email must be an email"],
      error: {
        code: "VALIDATION_ERROR",
        message: ["email must be an email"],
      },
    });
  });

  it("detects only complete envelopes", () => {
    expect(
      ApiResponse.isEnvelope(
        ApiResponse.success({ data: null, statusCode: HttpStatus.OK })
      )
    ).toBe(true);
    expect(ApiResponse.isEnvelope({ success: true, data: null })).toBe(false);
  });
});
