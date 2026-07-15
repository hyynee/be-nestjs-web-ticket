import { v2 as cloudinary } from "cloudinary";

jest.mock("cloudinary", () => {
  const _mockUploadStream = {
    end: jest.fn(),
  };
  return {
    v2: {
      config: jest.fn(),
      uploader: {
        upload_stream: jest.fn(),
        destroy: jest.fn(),
      },
      url: jest.fn(),
    },
  };
});

const OLD_ENV = process.env;

describe("UploadService", () => {
  beforeAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
    process.env.CLOUDINARY_API_KEY = "test-key";
    process.env.CLOUDINARY_API_SECRET = "test-secret";
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const getService = () => {
    const { UploadService } = require("./upload.service");
    return new UploadService();
  };

  describe("constructor", () => {
    it("configures cloudinary with correct credentials", () => {
      getService();
      expect(cloudinary.config).toHaveBeenCalledWith({
        cloud_name: "test-cloud",
        api_key: "test-key",
        api_secret: "test-secret",
      });
    });
  });

  describe("uploadBuffer", () => {
    it("resolves with result on success", async () => {
      const service = getService();
      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_options: any, callback: Function) => {
          callback(null, { secure_url: "https://cloudinary.com/test" });
          return mockStream;
        }
      );

      const result = await service.uploadBuffer(Buffer.from("test"), {});
      expect(result).toEqual({ secure_url: "https://cloudinary.com/test" });
      expect(mockStream.end).toHaveBeenCalledWith(Buffer.from("test"));
    });

    it("rejects with error on failure", async () => {
      const service = getService();
      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_options: any, callback: Function) => {
          callback(new Error("Upload failed"), null);
          return mockStream;
        }
      );

      await expect(
        service.uploadBuffer(Buffer.from("test"), {})
      ).rejects.toThrow("Upload failed");
    });

    it("rejects with generic message when error is not an Error instance", async () => {
      const service = getService();
      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_options: any, callback: Function) => {
          callback("string error", null);
          return mockStream;
        }
      );

      await expect(
        service.uploadBuffer(Buffer.from("test"), {})
      ).rejects.toThrow("Cloudinary upload failed");
    });
  });

  describe("uploadQRCode", () => {
    it("throws on invalid base64 (no comma)", async () => {
      const service = getService();
      await expect(service.uploadQRCode("no-comma", "TCK001")).rejects.toThrow(
        "Invalid base64 format"
      );
    });

    it("uploads valid base64 and returns secure_url", async () => {
      const service = getService();
      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_options: any, callback: Function) => {
          callback(null, { secure_url: "https://cloudinary.com/qr" });
          return mockStream;
        }
      );

      const result = await service.uploadQRCode(
        "data:image/png;base64,abc123",
        "TCK001"
      );
      expect(result).toBe("https://cloudinary.com/qr");
    });
  });

  describe("uploadQRCodeBuffer", () => {
    it("uploads buffer and returns secure_url", async () => {
      const service = getService();
      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_options: any, callback: Function) => {
          callback(null, { secure_url: "https://cloudinary.com/qr-buffer" });
          return mockStream;
        }
      );

      const result = await service.uploadQRCodeBuffer(
        Buffer.from("test"),
        "TCK002"
      );
      expect(result).toBe("https://cloudinary.com/qr-buffer");
    });
  });

  describe("deleteQRCode", () => {
    it("calls cloudinary.uploader.destroy with correct public_id", async () => {
      const service = getService();
      (cloudinary.uploader.destroy as jest.Mock).mockResolvedValueOnce({
        result: "ok",
      });
      await service.deleteQRCode("TCK001");
      expect(cloudinary.uploader.destroy).toHaveBeenCalledWith(
        "qrcodes/TCK001"
      );
    });

    it("catches error and logs to console", async () => {
      const service = getService();
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      (cloudinary.uploader.destroy as jest.Mock).mockRejectedValueOnce(
        new Error("Not found")
      );
      await service.deleteQRCode("TCK001");
      expect(consoleSpy).toHaveBeenCalledWith(
        "Delete QR error:",
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });
  });
});
