/**
 * Real-MongoDB proof that `upsertReceivedStripeEvent`'s
 * `findOneAndUpdate({provider,eventId}, {$setOnInsert:...}, {upsert:true})`
 * is safe under truly concurrent duplicate webhook delivery — Stripe (or a
 * client replaying a signed payload) can and does deliver the same event
 * more than once. A mocked model can't prove the upsert+unique-index
 * combination is race-free; this uses a real MongoMemoryServer.
 */
import { MongooseModule, getConnectionToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Connection } from "mongoose";

import {
  PaymentWebhookEvent,
  PaymentWebhookEventSchema,
  PaymentWebhookEventStatus,
  PaymentWebhookProvider,
} from "@src/schemas/payment-webhook-event.schema";

import { PaymentWebhookEventRepository } from "../infrastructure/persistence/payment-webhook-event.repository";

jest.setTimeout(60000);

let mongod: MongoMemoryServer;
let moduleRef: TestingModule;
let connection: Connection;
let repository: PaymentWebhookEventRepository;
let webhookEventModel: any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(mongod.getUri(), {
        dbName: "payment_webhook_event_concurrency_test",
      }),
      MongooseModule.forFeature([
        { name: PaymentWebhookEvent.name, schema: PaymentWebhookEventSchema },
      ]),
    ],
    providers: [PaymentWebhookEventRepository],
  }).compile();

  connection = moduleRef.get(getConnectionToken());
  repository = moduleRef.get(PaymentWebhookEventRepository);
  webhookEventModel = connection.model(PaymentWebhookEvent.name);
  await webhookEventModel.syncIndexes();
}, 60000);

afterAll(async () => {
  await moduleRef?.close();
  await mongod?.stop();
});

afterEach(async () => {
  await webhookEventModel.deleteMany({});
});

function makeStripeEvent(id: string) {
  return { id, type: "checkout.session.completed" } as never;
}

describe("PaymentWebhookEventRepository.upsertReceivedStripeEvent — real Mongo", () => {
  it("persists exactly one row when the same Stripe event is delivered 10 times concurrently", async () => {
    const event = makeStripeEvent("evt_dup_10x");

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        repository.upsertReceivedStripeEvent(event, { raw: "payload" })
      )
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const count = await webhookEventModel.countDocuments({
      provider: PaymentWebhookProvider.STRIPE,
      eventId: "evt_dup_10x",
    });
    expect(count).toBe(1);

    const stored = await webhookEventModel.findOne({ eventId: "evt_dup_10x" });
    expect(stored.status).toBe(PaymentWebhookEventStatus.RECEIVED);
    expect(stored.retryCount).toBe(0);
  });

  it("does not overwrite an already-processed event's fields on a later duplicate delivery", async () => {
    const event = makeStripeEvent("evt_already_processed");
    await repository.upsertReceivedStripeEvent(event, { raw: "payload" });
    await webhookEventModel.updateOne(
      { eventId: "evt_already_processed" },
      { $set: { status: PaymentWebhookEventStatus.SUCCEEDED } }
    );

    // A duplicate delivery arrives after the event was already processed —
    // $setOnInsert must not touch the existing document's status.
    await repository.upsertReceivedStripeEvent(event, { raw: "payload" });

    const stored = await webhookEventModel.findOne({
      eventId: "evt_already_processed",
    });
    expect(stored.status).toBe(PaymentWebhookEventStatus.SUCCEEDED);
  });

  it("keeps separate rows for the same eventId across different providers", async () => {
    await webhookEventModel.create({
      provider: PaymentWebhookProvider.STRIPE,
      eventId: "shared-id",
      eventType: "x",
      payload: {},
    });
    await webhookEventModel.create({
      provider: PaymentWebhookProvider.PAYPAL,
      eventId: "shared-id",
      eventType: "x",
      payload: {},
    });

    const count = await webhookEventModel.countDocuments({
      eventId: "shared-id",
    });
    expect(count).toBe(2);
  });
});
