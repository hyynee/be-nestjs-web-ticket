import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { GoogleStrategy } from "./google.strategy";

describe("GoogleStrategy", () => {
  let strategy: GoogleStrategy;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleStrategy,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              const map: Record<string, string> = {
                GOOGLE_CLIENT_ID: "fake-client-id",
                GOOGLE_CLIENT_SECRET: "fake-client-secret",
                GOOGLE_CALLBACK_URL:
                  "http://localhost:3000/auth/google/callback",
              };
              return map[key];
            }),
          },
        },
      ],
    }).compile();

    strategy = module.get(GoogleStrategy);
  });

  it("calls done with user info from profile", () => {
    const done = jest.fn();
    const profile = {
      name: { givenName: "Alice", familyName: "Smith" },
      emails: [{ value: "alice@example.com" }],
      photos: [{ value: "https://example.com/photo.jpg" }],
    } as any;

    strategy.validate("access_token", "refresh_token", profile, done);

    expect(done).toHaveBeenCalledWith(null, {
      email: "alice@example.com",
      name: "Alice Smith",
      picture: "https://example.com/photo.jpg",
    });
  });

  it("handles missing optional profile fields gracefully", () => {
    const done = jest.fn();
    const profile = {
      name: undefined,
      emails: undefined,
      photos: undefined,
    } as any;

    strategy.validate("access_token", "refresh_token", profile, done);

    expect(done).toHaveBeenCalledWith(null, {
      email: undefined,
      name: undefined,
      picture: undefined,
    });
  });
});
