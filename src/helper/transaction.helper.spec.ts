import { Test, TestingModule } from "@nestjs/testing";
import { getConnectionToken } from "@nestjs/mongoose";
import { TransactionHelper } from "./transaction.helper";

describe("TransactionHelper", () => {
  let helper: TransactionHelper;
  let mockSession: any;
  let mockConnection: any;

  beforeEach(async () => {
    mockSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      abortTransaction: jest.fn().mockResolvedValue(undefined),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    mockConnection = {
      startSession: jest.fn().mockResolvedValue(mockSession),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionHelper,
        { provide: getConnectionToken(), useValue: mockConnection },
      ],
    }).compile();

    helper = module.get(TransactionHelper);
  });

  it("commits transaction and returns result on success", async () => {
    const callback = jest.fn().mockResolvedValue("done");
    const result = await helper.runInTransaction(callback);
    expect(result).toBe("done");
    expect(mockSession.startTransaction).toHaveBeenCalled();
    expect(mockSession.commitTransaction).toHaveBeenCalled();
    expect(mockSession.endSession).toHaveBeenCalled();
  });

  it("aborts transaction on error and re-throws", async () => {
    const callback = jest.fn().mockRejectedValue(new Error("db error"));
    await expect(helper.runInTransaction(callback)).rejects.toThrow("db error");
    expect(mockSession.abortTransaction).toHaveBeenCalled();
    expect(mockSession.endSession).toHaveBeenCalled();
    expect(mockSession.commitTransaction).not.toHaveBeenCalled();
  });

  it("calls endSession in finally block", async () => {
    const callback = jest.fn().mockResolvedValue("ok");
    await helper.runInTransaction(callback);
    expect(mockSession.endSession).toHaveBeenCalled();
  });

  it("throws when startSession fails", async () => {
    mockConnection.startSession.mockRejectedValue(
      new Error("connection error")
    );
    const callback = jest.fn();
    await expect(helper.runInTransaction(callback)).rejects.toThrow(
      "connection error"
    );
  });

  it("propagates abortTransaction error when both callback and abortTransaction fail", async () => {
    const callback = jest.fn().mockRejectedValue(new Error("cb error"));
    mockSession.abortTransaction.mockRejectedValue(new Error("abort error"));

    await expect(helper.runInTransaction(callback)).rejects.toThrow(
      "abort error"
    );
    expect(mockSession.endSession).toHaveBeenCalled();
  });
});
