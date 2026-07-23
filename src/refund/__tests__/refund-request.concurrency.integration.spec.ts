/**
 * Real-MongoDB proof that `uniq_active_refund_request_per_booking`
 * (schemas/refund-request.schema.ts) actually blocks two concurrent active
 * refund requests for the same booking — the invariant
 * `CreateRefundRequestUseCase` relies on (it maps the resulting E11000 to
 * a 409 Conflict, see create-refund-request.use-case.spec.ts). A mocked
 * Mongoose model can't prove the index itself works; this uses a real
 * MongoMemoryServer (single node — the unique index check doesn't need a
 * replica set/transaction).
 */
import { MongooseModule, getConnectionToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Connection, Types } from "mongoose";

import {
  RefundRequest,
  RefundRequestSchema,
  RefundRequestStatus,
} from "@src/schemas/refund-request.schema";

jest.setTimeout(60000);

let mongod: MongoMemoryServer;
let moduleRef: TestingModule;
let connection: Connection;
let refundRequestModel: any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(mongod.getUri(), {
        dbName: "refund_request_concurrency_test",
      }),
      MongooseModule.forFeature([
        { name: RefundRequest.name, schema: RefundRequestSchema },
      ]),
    ],
  }).compile();

  connection = moduleRef.get(getConnectionToken());
  refundRequestModel = connection.model(RefundRequest.name);
  // Indexes are built in the background by default; the unique constraint
  // must be in place before the race test runs.
  await refundRequestModel.syncIndexes();
}, 60000);

afterAll(async () => {
  await moduleRef?.close();
  await mongod?.stop();
});

afterEach(async () => {
  await refundRequestModel.deleteMany({});
});

function makeRequestDoc(
  bookingId: Types.ObjectId,
  overrides: Record<string, unknown> = {}
) {
  return {
    bookingId,
    userId: new Types.ObjectId(),
    eventId: new Types.ObjectId(),
    amount: 10000,
    reason: "test",
    status: RefundRequestStatus.REQUESTED,
    isDeleted: false,
    ...overrides,
  };
}

describe("RefundRequest unique-active-per-booking index — real Mongo", () => {
  it("allows only one of two concurrent active refund requests for the same booking", async () => {
    const bookingId = new Types.ObjectId();

    const results = await Promise.allSettled([
      refundRequestModel.create(makeRequestDoc(bookingId)),
      refundRequestModel.create(makeRequestDoc(bookingId)),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.code).toBe(11000);

    const count = await refundRequestModel.countDocuments({ bookingId });
    expect(count).toBe(1);
  });

  it("allows a new active request once the prior one reaches a terminal state (succeeded/rejected)", async () => {
    const bookingId = new Types.ObjectId();

    await refundRequestModel.create(
      makeRequestDoc(bookingId, { status: RefundRequestStatus.SUCCEEDED })
    );

    await expect(
      refundRequestModel.create(makeRequestDoc(bookingId))
    ).resolves.toBeDefined();

    const count = await refundRequestModel.countDocuments({ bookingId });
    expect(count).toBe(2);
  });

  it("blocks a new active request while a prior one is still PROCESSING", async () => {
    const bookingId = new Types.ObjectId();

    await refundRequestModel.create(
      makeRequestDoc(bookingId, { status: RefundRequestStatus.PROCESSING })
    );

    await expect(
      refundRequestModel.create(makeRequestDoc(bookingId))
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("blocks a new active request while a prior one is stuck at RECONCILIATION_REQUIRED (NEW#3: provider refunded, DB finalize not yet caught up)", async () => {
    const bookingId = new Types.ObjectId();

    await refundRequestModel.create(
      makeRequestDoc(bookingId, {
        status: RefundRequestStatus.RECONCILIATION_REQUIRED,
        provider: "stripe",
        providerRefundId: "re_stuck",
      })
    );

    await expect(
      refundRequestModel.create(makeRequestDoc(bookingId))
    ).rejects.toMatchObject({ code: 11000 });

    const count = await refundRequestModel.countDocuments({ bookingId });
    expect(count).toBe(1);
  });

  it("allows two different bookings to each have their own active request concurrently", async () => {
    const results = await Promise.allSettled([
      refundRequestModel.create(makeRequestDoc(new Types.ObjectId())),
      refundRequestModel.create(makeRequestDoc(new Types.ObjectId())),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
