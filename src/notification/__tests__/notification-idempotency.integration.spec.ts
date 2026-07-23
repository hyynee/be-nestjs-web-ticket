/**
 * Real-MongoDB proof that `uniq_notification_idempotency_key`
 * (schemas/notification.schema.ts, sparse unique index on
 * `metadata.idempotencyKey`) actually blocks duplicate notification
 * creation under concurrent delivery — the invariant
 * `NotificationWriterService.createNotification()` relies on (it maps the
 * resulting E11000 to "return the existing record", see
 * notification-writer.service.spec.ts). A mocked model can't prove the
 * index itself works.
 */
import { MongooseModule, getConnectionToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Connection, Types } from "mongoose";

import {
  Notification,
  NotificationChannel,
  NotificationSchema,
  NotificationStatus,
  NotificationType,
} from "@src/schemas/notification.schema";

jest.setTimeout(60000);

let mongod: MongoMemoryServer;
let moduleRef: TestingModule;
let connection: Connection;
let notificationModel: any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(mongod.getUri(), {
        dbName: "notification_idempotency_test",
      }),
      MongooseModule.forFeature([
        { name: Notification.name, schema: NotificationSchema },
      ]),
    ],
  }).compile();

  connection = moduleRef.get(getConnectionToken());
  notificationModel = connection.model(Notification.name);
  await notificationModel.syncIndexes();
}, 60000);

afterAll(async () => {
  await moduleRef?.close();
  await mongod?.stop();
});

afterEach(async () => {
  await notificationModel.deleteMany({});
});

function makeNotificationDoc(
  idempotencyKey: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    userId: new Types.ObjectId(),
    type: NotificationType.BOOKING_CREATED,
    channel: NotificationChannel.IN_APP,
    title: "Booking created",
    body: "BK1",
    status: NotificationStatus.SENT,
    metadata: { idempotencyKey },
    ...overrides,
  };
}

describe("Notification metadata.idempotencyKey unique index — real Mongo", () => {
  it("persists exactly one notification when the same idempotencyKey is inserted 5 times concurrently", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        notificationModel.create(makeNotificationDoc("booking-created:b1"))
      )
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(4);
    for (const r of failed as PromiseRejectedResult[]) {
      expect(r.reason.code).toBe(11000);
    }

    const count = await notificationModel.countDocuments({
      "metadata.idempotencyKey": "booking-created:b1",
    });
    expect(count).toBe(1);
  });

  it("allows two different idempotencyKeys to both be created", async () => {
    const results = await Promise.allSettled([
      notificationModel.create(makeNotificationDoc("booking-created:b1")),
      notificationModel.create(makeNotificationDoc("booking-created:b2")),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("does not constrain notifications with no idempotencyKey at all (sparse index)", async () => {
    const results = await Promise.allSettled([
      notificationModel.create({
        userId: new Types.ObjectId(),
        type: NotificationType.EVENT_REMINDER,
        channel: NotificationChannel.IN_APP,
        title: "x",
        body: "x",
      }),
      notificationModel.create({
        userId: new Types.ObjectId(),
        type: NotificationType.EVENT_REMINDER,
        channel: NotificationChannel.IN_APP,
        title: "x",
        body: "x",
      }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
