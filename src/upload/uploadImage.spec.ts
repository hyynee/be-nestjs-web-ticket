import { Test, TestingModule } from "@nestjs/testing";
import { UploadController } from "./uploadImage";
import { UserService } from "@src/user/user.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { HttpStatus } from "@nestjs/common";
import { v2 as cloudinary } from "cloudinary";

jest.mock("cloudinary", () => {
  const _mockUploadStream = { end: jest.fn() };
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

const mockUserService = {
  getUserById: jest.fn(),
  updateProfileUser: jest.fn(),
};

const OLD_ENV = process.env;

describe("UploadController", () => {
  let controller: UploadController;

  beforeAll(() => {
    process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
    process.env.CLOUDINARY_API_KEY = "test-key";
    process.env.CLOUDINARY_API_SECRET = "test-secret";
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    (cloudinary.url as jest.Mock).mockReturnValue(
      "https://cloudinary.com/signed-url"
    );
    jest.spyOn(console, "error").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadController],
      providers: [{ provide: UserService, useValue: mockUserService }],
    }).compile();

    controller = module.get<UploadController>(UploadController);
  });

  describe("uploadPrivateImage", () => {
    it("throws when no file uploaded", async () => {
      await expect(controller.uploadPrivateImage(null as any)).rejects.toThrow(
        "No file uploaded"
      );
    });

    it("throws on invalid mime type", async () => {
      const file = {
        mimetype: "image/bmp",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      await expect(controller.uploadPrivateImage(file)).rejects.toThrow(
        "Invalid file type"
      );
    });

    it("uploads successfully and returns signed URL", async () => {
      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_opts: any, cb: Function) => {
          cb(null, {
            public_id: "private_uploads/abc123",
            format: "png",
            bytes: 12345,
          });
          return mockStream;
        }
      );

      const file = {
        mimetype: "image/png",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      const result = await controller.uploadPrivateImage(file);

      expect(result.status).toBe(HttpStatus.OK);
      expect(result.data.publicId).toBe("private_uploads/abc123");
      expect(result.data.imageUrl).toBe("https://cloudinary.com/signed-url");
      expect(cloudinary.url).toHaveBeenCalledWith(
        "private_uploads/abc123",
        expect.objectContaining({ type: "private", sign_url: true })
      );
    });

    it("throws on upload error", async () => {
      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_opts: any, cb: Function) => {
          cb(new Error("Network error"), null);
          return mockStream;
        }
      );

      const file = {
        mimetype: "image/jpeg",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      await expect(controller.uploadPrivateImage(file)).rejects.toThrow(
        "File upload failed"
      );
    });

    it("uses fallback message when upload callback receives non-Error", async () => {
      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_opts: any, cb: Function) => {
          cb("string error", null);
          return mockStream;
        }
      );

      const file = {
        mimetype: "image/jpeg",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      await expect(controller.uploadPrivateImage(file)).rejects.toThrow(
        "File upload failed"
      );
    });
  });

  describe("refreshSignedUrl", () => {
    it("throws when publicId is missing", () => {
      expect(() => controller.refreshSignedUrl("")).toThrow(
        "publicId is required"
      );
    });

    it("returns signed URL on success", () => {
      const result = controller.refreshSignedUrl("public_id_123");
      expect(result.status).toBe(HttpStatus.OK);
      expect(result.data.imageUrl).toBe("https://cloudinary.com/signed-url");
      expect(cloudinary.url).toHaveBeenCalledWith(
        "public_id_123",
        expect.objectContaining({ type: "private", sign_url: true })
      );
    });

    it("throws on cloudinary error", () => {
      (cloudinary.url as jest.Mock).mockImplementationOnce(() => {
        throw new Error("Cloudinary error");
      });
      expect(() => controller.refreshSignedUrl("bad_id")).toThrow(
        "Failed to generate signed URL"
      );
    });
  });

  describe("uploadAvatar", () => {
    const currentUser: JwtPayload = {
      userId: "user123",
      role: "user",
      iat: 0,
      exp: 0,
    };

    it("throws when no file uploaded", async () => {
      mockUserService.getUserById.mockResolvedValue({ avatarPublicId: null });
      await expect(
        controller.uploadAvatar(null as any, currentUser)
      ).rejects.toThrow("No file uploaded");
    });

    it("throws on invalid mime type", async () => {
      const file = {
        mimetype: "image/gif",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      mockUserService.getUserById.mockResolvedValue({ avatarPublicId: null });
      await expect(controller.uploadAvatar(file, currentUser)).rejects.toThrow(
        "Invalid file type. Only JPEG, PNG, WEBP allowed"
      );
    });

    it("uploads new avatar when user has no existing one", async () => {
      mockUserService.getUserById.mockResolvedValue({ avatarPublicId: null });
      mockUserService.updateProfileUser.mockResolvedValue({});

      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_opts: any, cb: Function) => {
          cb(null, { public_id: "avatars/user123/abc" });
          return mockStream;
        }
      );

      const file = {
        mimetype: "image/jpeg",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      const result = await controller.uploadAvatar(file, currentUser);

      expect(result.status).toBe(HttpStatus.OK);
      expect(result.message).toBe("Avatar uploaded successfully");
      expect(result.data.publicId).toBe("avatars/user123/abc");
      expect(result.data.avatarUrl).toBe("https://cloudinary.com/signed-url");
      expect(mockUserService.updateProfileUser).toHaveBeenCalledWith(
        "user123",
        {
          avatarPublicId: "avatars/user123/abc",
        }
      );
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });

    it("replaces old avatar when user has existing one", async () => {
      mockUserService.getUserById.mockResolvedValue({
        avatarPublicId: "avatars/user123/old",
      });
      mockUserService.updateProfileUser.mockResolvedValue({});
      (cloudinary.uploader.destroy as jest.Mock).mockResolvedValueOnce({
        result: "ok",
      });

      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_opts: any, cb: Function) => {
          cb(null, { public_id: "avatars/user123/new" });
          return mockStream;
        }
      );

      const file = {
        mimetype: "image/png",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      const result = await controller.uploadAvatar(file, currentUser);

      expect(result.status).toBe(HttpStatus.OK);
      expect(cloudinary.uploader.destroy).toHaveBeenCalledWith(
        "avatars/user123/old",
        {
          type: "private",
          resource_type: "image",
        }
      );
      expect(mockUserService.updateProfileUser).toHaveBeenCalledWith(
        "user123",
        {
          avatarPublicId: "avatars/user123/new",
        }
      );
    });

    it("continues even when deleting old avatar fails", async () => {
      mockUserService.getUserById.mockResolvedValue({
        avatarPublicId: "avatars/user123/old",
      });
      mockUserService.updateProfileUser.mockResolvedValue({});
      (cloudinary.uploader.destroy as jest.Mock).mockRejectedValueOnce(
        new Error("Delete failed")
      );

      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_opts: any, cb: Function) => {
          cb(null, { public_id: "avatars/user123/new" });
          return mockStream;
        }
      );

      const file = {
        mimetype: "image/jpeg",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      const result = await controller.uploadAvatar(file, currentUser);
      expect(result.status).toBe(HttpStatus.OK);
    });

    it("throws on upload error", async () => {
      mockUserService.getUserById.mockResolvedValue({ avatarPublicId: null });

      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_opts: any, cb: Function) => {
          cb(new Error("Upload failed"), null);
          return mockStream;
        }
      );

      const file = {
        mimetype: "image/webp",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      await expect(controller.uploadAvatar(file, currentUser)).rejects.toThrow(
        "Avatar upload failed"
      );
    });

    it("uses fallback message when avatar upload callback receives non-Error", async () => {
      mockUserService.getUserById.mockResolvedValue({ avatarPublicId: null });

      const mockStream = { end: jest.fn() } as any;
      (cloudinary.uploader.upload_stream as jest.Mock).mockImplementation(
        (_opts: any, cb: Function) => {
          cb("string rejection", null);
          return mockStream;
        }
      );

      const file = {
        mimetype: "image/webp",
        buffer: Buffer.from("test"),
      } as Express.Multer.File;
      await expect(controller.uploadAvatar(file, currentUser)).rejects.toThrow(
        "Avatar upload failed"
      );
    });
  });

  describe("deleteAvatar", () => {
    const currentUser: JwtPayload = {
      userId: "user123",
      role: "user",
      iat: 0,
      exp: 0,
    };

    it("throws when user has no avatar", async () => {
      mockUserService.getUserById.mockResolvedValue({ avatarPublicId: null });
      await expect(controller.deleteAvatar(currentUser)).rejects.toThrow(
        "No avatar to delete"
      );
    });

    it("deletes avatar successfully", async () => {
      mockUserService.getUserById.mockResolvedValue({
        avatarPublicId: "avatars/user123/abc",
      });
      mockUserService.updateProfileUser.mockResolvedValue({});
      (cloudinary.uploader.destroy as jest.Mock).mockResolvedValueOnce({
        result: "ok",
      });

      const result = await controller.deleteAvatar(currentUser);
      expect(result.status).toBe(HttpStatus.OK);
      expect(result.message).toBe("Avatar deleted successfully");
      expect(cloudinary.uploader.destroy).toHaveBeenCalledWith(
        "avatars/user123/abc",
        {
          type: "private",
          resource_type: "image",
        }
      );
      expect(mockUserService.updateProfileUser).toHaveBeenCalledWith(
        "user123",
        {
          avatarPublicId: null,
        }
      );
    });
  });

  describe("refreshAvatarUrl", () => {
    const currentUser: JwtPayload = {
      userId: "user123",
      role: "user",
      iat: 0,
      exp: 0,
    };

    it("throws when user has no avatar", async () => {
      mockUserService.getUserById.mockResolvedValue({ avatarPublicId: null });
      await expect(controller.refreshAvatarUrl(currentUser)).rejects.toThrow(
        "User has no avatar"
      );
    });

    it("returns signed URL on success", async () => {
      mockUserService.getUserById.mockResolvedValue({
        avatarPublicId: "avatars/user123/abc",
      });
      const result = await controller.refreshAvatarUrl(currentUser);
      expect(result.status).toBe(HttpStatus.OK);
      expect(result.data.avatarUrl).toBe("https://cloudinary.com/signed-url");
      expect(result.data.expiresIn).toBe(3600);
    });

    it("throws on cloudinary error", async () => {
      mockUserService.getUserById.mockResolvedValue({
        avatarPublicId: "avatars/user123/abc",
      });
      (cloudinary.url as jest.Mock).mockImplementationOnce(() => {
        throw new Error("Sign error");
      });
      await expect(controller.refreshAvatarUrl(currentUser)).rejects.toThrow(
        "Failed to generate signed URL"
      );
    });
  });
});
