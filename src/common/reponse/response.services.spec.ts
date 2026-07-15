import { ResponseService } from "./response.services";

describe("ResponseService", () => {
  let service: ResponseService;

  beforeEach(() => {
    service = new ResponseService();
  });

  describe("success", () => {
    it("returns success response with data", () => {
      const result = service.success({ id: 1 });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: 1 });
      expect(result.message).toBe("Success");
      expect(result.statusCode).toBe(200);
      expect(result.timestamp).toBeDefined();
    });

    it("uses custom message and statusCode", () => {
      const result = service.success("ok", "Created", 201);
      expect(result.message).toBe("Created");
      expect(result.statusCode).toBe(201);
    });
  });

  describe("successWithoutData", () => {
    it("returns success response without data", () => {
      const result = service.successWithoutData();
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });
  });

  describe("successWithPagination", () => {
    it("returns paginated response", () => {
      const result = service.successWithPagination(["a", "b"], 1, 10, 2);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(["a", "b"]);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 2,
        totalPages: 1,
      });
    });

    it("calculates totalPages correctly", () => {
      const result = service.successWithPagination([], 1, 10, 25);
      expect(result.pagination.totalPages).toBe(3);
    });
  });

  describe("error", () => {
    it("returns error response with defaults", () => {
      const result = service.error("Something went wrong");
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.message).toBe("Something went wrong");
    });

    it("includes errorCode, errors, and details when provided", () => {
      const result = service.error(
        "Validation failed",
        400,
        "VALIDATION_ERROR",
        ["field required"],
        { field: "email" }
      );
      expect(result.errorCode).toBe("VALIDATION_ERROR");
      expect(result.errors).toEqual(["field required"]);
      expect(result.details).toEqual({ field: "email" });
    });
  });

  describe("validationError", () => {
    it("returns 400 with VALIDATION_ERROR code", () => {
      const result = service.validationError(["name is required"]);
      expect(result.statusCode).toBe(400);
      expect(result.errorCode).toBe("VALIDATION_ERROR");
      expect(result.errors).toEqual(["name is required"]);
    });
  });

  describe("unauthorized", () => {
    it("returns 401 with default error code", () => {
      const result = service.unauthorized();
      expect(result.statusCode).toBe(401);
      expect(result.errorCode).toBe("UNAUTHORIZED");
    });

    it("uses custom error code", () => {
      const result = service.unauthorized("Access denied", "ACCESS_DENIED");
      expect(result.errorCode).toBe("ACCESS_DENIED");
    });
  });

  describe("forbidden", () => {
    it("returns 403 with FORBIDDEN code", () => {
      const result = service.forbidden();
      expect(result.statusCode).toBe(403);
      expect(result.errorCode).toBe("FORBIDDEN");
    });
  });

  describe("notFound", () => {
    it("returns 404 with NOT_FOUND code", () => {
      const result = service.notFound();
      expect(result.statusCode).toBe(404);
      expect(result.errorCode).toBe("NOT_FOUND");
    });
  });

  describe("conflict", () => {
    it("returns 409 with CONFLICT code", () => {
      const result = service.conflict();
      expect(result.statusCode).toBe(409);
      expect(result.errorCode).toBe("CONFLICT");
    });
  });
});
