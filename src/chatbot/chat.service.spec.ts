import { Test, TestingModule } from "@nestjs/testing";
import { ChatService } from "./chat.service";
import { getModelToken } from "@nestjs/mongoose";
import { Event } from "@src/schemas/event.schema";

describe("ChatService", () => {
  let service: ChatService;
  let eventModel: Record<string, jest.Mock>;

  const mockEventData = {
    _id: "64c1f2e1e1e1e1e1e1e1e1e1",
    title: "Concert ABC",
    description: "Mô tả concert",
    startDate: new Date("2030-06-01"),
    endDate: new Date("2030-06-05"),
    location: "Hà Nội",
    thumbnail: "https://example.com/thumb.jpg",
    status: "active",
    isDeleted: false,
  };

  const makeFindChain = (resolved: any) => ({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolved),
  });

  const makeFindOneChain = (resolved: any) => ({
    exec: jest.fn().mockResolvedValue(resolved),
  });

  beforeEach(async () => {
    eventModel = {
      find: jest.fn(),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: getModelToken(Event.name), useValue: eventModel },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ================= detectIntent (private) =================
  describe("detectIntent", () => {
    const detectIntent = (query: string) =>
      (service as any).detectIntent(query);

    it('should return "view_events" for queries containing "xem vé"', () => {
      expect(detectIntent("tôi muốn xem vé sự kiện")).toBe("view_events");
    });

    it('should return "view_events" for queries containing "danh sách"', () => {
      expect(detectIntent("danh sách sự kiện")).toBe("view_events");
    });

    it('should return "event_details" for queries containing "chi tiết"', () => {
      expect(detectIntent("cho tôi chi tiết sự kiện")).toBe("event_details");
    });

    it('should return "event_details" for queries containing a 24-char hex ID', () => {
      expect(detectIntent("thông tin sự kiện 64c1f2e1e1e1e1e1e1e1e1e1")).toBe(
        "event_details"
      );
    });

    it('should return "recommend_events" for queries containing "đề xuất"', () => {
      expect(detectIntent("đề xuất sự kiện cho tôi")).toBe("recommend_events");
    });

    it('should return "recommend_events" for queries containing "gợi ý"', () => {
      expect(detectIntent("gợi ý sự kiện hay")).toBe("recommend_events");
    });

    it('should return "active_events" for queries containing "đang diễn ra"', () => {
      expect(detectIntent("sự kiện đang diễn ra")).toBe("active_events");
    });

    it('should return "active_events" for queries containing "hiện tại"', () => {
      expect(detectIntent("sự kiện hiện tại")).toBe("active_events");
    });

    it('should return "upcoming_events" for queries containing "sắp diễn ra"', () => {
      expect(detectIntent("sự kiện sắp diễn ra")).toBe("upcoming_events");
    });

    it('should return "upcoming_events" for queries containing "sắp tới"', () => {
      expect(detectIntent("sự kiện sắp tới")).toBe("upcoming_events");
    });

    it('should return "booking_info" for queries containing "giá"', () => {
      expect(detectIntent("giá vé bao nhiêu")).toBe("booking_info");
    });

    it('should return "booking_info" for queries containing "mua vé"', () => {
      expect(detectIntent("mua vé sự kiện")).toBe("booking_info");
    });

    it('should return "general" for unrecognized queries', () => {
      expect(detectIntent("xin chào")).toBe("general");
    });

    it('should return "general" for empty string', () => {
      expect(detectIntent("")).toBe("general");
    });

    it("should not trigger match() on shorter path for rate-limiting check", () => {
      expect(detectIntent("của và hoặc")).toBe("general");
    });

    it('should return "event_details" purely by hex match without "chi tiết"', () => {
      expect(detectIntent("64c1f2e1e1e1e1e1e1e1e1e1")).toBe("event_details");
    });
  });

  // ================= sanitizeUserInput (private) =================
  describe("sanitizeUserInput", () => {
    const sanitize = (input: string) =>
      (service as any).sanitizeUserInput(input);

    it("should truncate input to 500 characters", () => {
      const longInput = "a".repeat(1000);
      const result = sanitize(longInput);
      expect(result.length).toBe(500);
    });

    it("should escape double quotes and backslashes", () => {
      const result = sanitize('test "quote" \\backslash');
      expect(result).toBe('test \\"quote\\" \\\\backslash');
    });

    it("should replace newlines with spaces", () => {
      const result = sanitize("line1\nline2\nline3");
      expect(result).toBe("line1 line2 line3");
    });
  });

  // ================= getKeywords (private) =================
  describe("getKeywords", () => {
    const getKeywords = (query: string) => (service as any).getKeywords(query);

    it("should filter out stop words", () => {
      const result = getKeywords(
        "của và hoặc nào cho tôi bạn có không concert"
      );
      expect(result).toEqual(["concert"]);
    });

    it("should remove duplicate keywords", () => {
      const result = getKeywords("concert concert nhạc nhạc");
      expect(result).toEqual(["concert", "nhạc"]);
    });

    it("should filter words shorter than 3 characters", () => {
      const result = getKeywords("a an the cat dog bird");
      expect(result).toEqual(["the", "cat", "dog", "bird"]);
    });

    it("should split on punctuation", () => {
      const result = getKeywords("concert,nhạc.sự kiện!");
      expect(result).toEqual(["concert", "nhạc", "kiện"]);
    });

    it("should return empty array for only stop words", () => {
      const result = getKeywords("của và hoặc");
      expect(result).toEqual([]);
    });
  });

  // ================= getEventIdFromQuery (private) =================
  describe("getEventIdFromQuery", () => {
    const getEventId = (query: string) =>
      (service as any).getEventIdFromQuery(query);

    it("should extract a 24-character hex ID from query", () => {
      const result = getEventId("thông tin sự kiện 64c1f2e1e1e1e1e1e1e1e1e1");
      expect(result).toBe("64c1f2e1e1e1e1e1e1e1e1e1");
    });

    it("should return null if no hex ID found", () => {
      const result = getEventId("cho tôi xem sự kiện");
      expect(result).toBeNull();
    });
  });

  // ================= checkEventActive (private) =================
  describe("checkEventActive", () => {
    const checkActive = (event: any) =>
      (service as any).checkEventActive(event);

    it("should return true for active event within date range", () => {
      const now = new Date();
      const event = {
        status: "active",
        startDate: new Date(now.getTime() - 86400000),
        endDate: new Date(now.getTime() + 86400000),
      };
      expect(checkActive(event)).toBe(true);
    });

    it("should return false for non-active status", () => {
      const event = {
        status: "draft",
        startDate: new Date("2020-01-01"),
        endDate: new Date("2030-01-01"),
      };
      expect(checkActive(event)).toBe(false);
    });

    it("should return false when current date is before startDate", () => {
      const event = {
        status: "active",
        startDate: new Date("2099-01-01"),
        endDate: new Date("2099-12-31"),
      };
      expect(checkActive(event)).toBe(false);
    });

    it("should return false when current date is after endDate", () => {
      const event = {
        status: "active",
        startDate: new Date("2020-01-01"),
        endDate: new Date("2020-01-02"),
      };
      expect(checkActive(event)).toBe(false);
    });
  });

  // ================= getEventsByIntent (private) =================
  describe("getEventsByIntent", () => {
    const getEvents = (query: string, intent: string) =>
      (service as any).getEventsByIntent(query, intent);

    it('should fetch all active events sorted by startDate for "view_events"', async () => {
      eventModel.find.mockReturnValue(makeFindChain([mockEventData]));

      const result = await getEvents("xem vé", "view_events");

      expect(eventModel.find).toHaveBeenCalledWith({
        isDeleted: false,
        status: "active",
      });
      expect(result).toEqual([mockEventData]);
    });

    it('should fetch current active events for "active_events"', async () => {
      eventModel.find.mockReturnValue(makeFindChain([mockEventData]));

      const result = await getEvents("đang diễn ra", "active_events");

      const findCall = eventModel.find.mock.calls[0][0];
      expect(findCall.startDate).toBeDefined();
      expect(findCall.endDate).toBeDefined();
      expect(findCall.startDate.$lte).toBeInstanceOf(Date);
      expect(findCall.endDate.$gte).toBeInstanceOf(Date);
      expect(result).toEqual([mockEventData]);
    });

    it('should fetch upcoming events for "upcoming_events"', async () => {
      eventModel.find.mockReturnValue(makeFindChain([mockEventData]));

      const result = await getEvents("sắp diễn ra", "upcoming_events");

      const findCall = eventModel.find.mock.calls[0][0];
      expect(findCall.startDate.$gt).toBeInstanceOf(Date);
      expect(result).toEqual([mockEventData]);
    });

    it('should recommend upcoming events for "recommend_events"', async () => {
      eventModel.find.mockReturnValue(makeFindChain([mockEventData]));

      const result = await getEvents("đề xuất", "recommend_events");

      expect(eventModel.find).toHaveBeenCalled();
      expect(result).toEqual([mockEventData]);
    });

    describe('for "event_details"', () => {
      it("should find event by ID when query contains hex ID", async () => {
        eventModel.findOne.mockReturnValue(makeFindOneChain(mockEventData));

        const result = await getEvents(
          "chi tiết 64c1f2e1e1e1e1e1e1e1e1e1",
          "event_details"
        );

        expect(eventModel.findOne).toHaveBeenCalledWith({
          _id: expect.anything(),
          isDeleted: false,
        });
        expect(result).toEqual([mockEventData]);
      });

      it("should return empty array when event not found by ID", async () => {
        eventModel.findOne.mockReturnValue(makeFindOneChain(null));

        const result = await getEvents(
          "chi tiết 64c1f2e1e1e1e1e1e1e1e1e1",
          "event_details"
        );

        expect(result).toEqual([]);
      });

      it("should search by keywords when no ID found", async () => {
        eventModel.find.mockReturnValue(makeFindChain([mockEventData]));

        const result = await getEvents("concert abc", "event_details");

        const findCall = eventModel.find.mock.calls[0][0];
        expect(findCall.$or).toBeDefined();
        expect(findCall.$or).toHaveLength(3);
        expect(result).toEqual([mockEventData]);
      });

      it("should return empty array when no keywords extracted", async () => {
        const result = await getEvents("của và", "event_details");

        expect(result).toEqual([]);
      });
    });

    it("should return empty array for default intent", async () => {
      const result = await getEvents("xin chào", "general");

      expect(result).toEqual([]);
    });
  });

  // ================= createPrompt =================
  describe("createPrompt", () => {
    it("should build prompt with events when events found", async () => {
      eventModel.find.mockReturnValue(makeFindChain([mockEventData]));

      const prompt = await service.createPrompt("xem vé");

      expect(prompt).toContain("Có 1 sự kiện phù hợp");
      expect(prompt).toContain(mockEventData.title);
      expect(prompt).toContain(mockEventData.location);
      expect(prompt).toContain("Bạn là trợ lý bán vé sự kiện");
    });

    it("should build prompt without events when none found", async () => {
      eventModel.find.mockReturnValue(makeFindChain([]));

      const prompt = await service.createPrompt("xin chào");

      expect(prompt).toContain("Hiện không có sự kiện phù hợp");
    });

    it("should include intent-specific suggestion for view_events", async () => {
      eventModel.find.mockReturnValue(makeFindChain([]));

      const prompt = await service.createPrompt("xem vé");

      expect(prompt).toContain("Liệt kê các sự kiện");
    });

    it("should include intent-specific suggestion for event_details", async () => {
      eventModel.find.mockReturnValue(makeFindChain([]));
      eventModel.findOne.mockReturnValue(makeFindOneChain(null));

      const prompt = await service.createPrompt(
        "chi tiết 64c1f2e1e1e1e1e1e1e1e1e1"
      );

      expect(prompt).toContain("Mô tả chi tiết sự kiện nếu có");
    });

    it("should include intent-specific suggestion for recommend_events", async () => {
      eventModel.find.mockReturnValue(makeFindChain([]));

      const prompt = await service.createPrompt("đề xuất");

      expect(prompt).toContain("Đề xuất sự kiện phù hợp");
    });

    it("should include intent-specific suggestion for booking_info", async () => {
      eventModel.find.mockReturnValue(makeFindChain([]));

      const prompt = await service.createPrompt("giá vé");

      expect(prompt).toContain("Hướng dẫn cách mua vé");
    });

    it("should include default suggestion for general intent", async () => {
      eventModel.find.mockReturnValue(makeFindChain([]));

      const prompt = await service.createPrompt("xin chào");

      expect(prompt).toContain("Trả lời tự nhiên");
    });

    it("should fallback to simple prompt on error", async () => {
      eventModel.find.mockImplementation(() => {
        throw new Error("DB error");
      });

      const prompt = await service.createPrompt("xem vé");

      expect(prompt).toContain("Bạn là trợ lý bán vé sự kiện");
      expect(prompt).toContain("Bạn cần hỗ trợ gì thêm không?");
    });

    it("should include description substring when event has description", async () => {
      eventModel.find.mockReturnValue(makeFindChain([mockEventData]));

      const prompt = await service.createPrompt("xem vé");

      expect(prompt).toContain("Mô tả:");
    });

    it("should handle event without description", async () => {
      eventModel.find.mockReturnValue(
        makeFindChain([{ ...mockEventData, description: undefined }])
      );

      const prompt = await service.createPrompt("xem vé");

      expect(prompt).not.toContain("Mô tả:");
    });

    it("should show 'Đang diễn ra' for events active at current time", async () => {
      const now = new Date();
      const activeEvent = {
        ...mockEventData,
        startDate: new Date(now.getTime() - 86400000),
        endDate: new Date(now.getTime() + 86400000),
      };
      eventModel.find.mockReturnValue(makeFindChain([activeEvent]));

      const prompt = await service.createPrompt("xem vé");

      expect(prompt).toContain("Đang diễn ra");
    });
  });

  // ================= processAIResponse =================
  describe("processAIResponse", () => {
    it("should return ChatResponse with event data", async () => {
      eventModel.find.mockReturnValue(makeFindChain([mockEventData]));

      const result = await service.processAIResponse(
        "xem vé",
        "Đây là danh sách sự kiện"
      );

      expect(result.response).toBe("Đây là danh sách sự kiện");
      expect(result.eventData).toHaveLength(1);
      expect(result.eventData[0].title).toBe("Concert ABC");
      expect(result.eventData[0].isActiveNow).toBeDefined();
      expect(result.intent).toBe("view_events");
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it("should return empty eventData when no events found", async () => {
      eventModel.find.mockReturnValue(makeFindChain([]));

      const result = await service.processAIResponse("xin chào", "Xin chào");

      expect(result.eventData).toHaveLength(0);
      expect(result.intent).toBe("general");
    });

    it("should include thumbnail when event has one", async () => {
      eventModel.find.mockReturnValue(makeFindChain([mockEventData]));

      const result = await service.processAIResponse("xem vé", "OK");

      expect(result.eventData[0].thumbnail).toBe(mockEventData.thumbnail);
    });

    it("should set thumbnail as undefined when event has none", async () => {
      eventModel.find.mockReturnValue(
        makeFindChain([{ ...mockEventData, thumbnail: undefined }])
      );

      const result = await service.processAIResponse("xem vé", "OK");

      expect(result.eventData[0].thumbnail).toBeUndefined();
    });

    it("should set description as undefined when event has none", async () => {
      eventModel.find.mockReturnValue(
        makeFindChain([{ ...mockEventData, description: undefined }])
      );

      const result = await service.processAIResponse("xem vé", "OK");

      expect(result.eventData[0].description).toBeUndefined();
    });
  });

  // ================= handleChatMessage =================
  describe("handleChatMessage", () => {
    it("should delegate to processAIResponse", async () => {
      eventModel.find.mockReturnValue(makeFindChain([]));

      const result = await service.handleChatMessage("xin chào", "Chào bạn!");

      expect(result.response).toBe("Chào bạn!");
      expect(result.intent).toBe("general");
      expect(result.timestamp).toBeInstanceOf(Date);
    });
  });

  // ================= getEventsForIds =================
  describe("getEventsForIds", () => {
    it("should fetch events by valid IDs", async () => {
      const validIds = ["64c1f2e1e1e1e1e1e1e1e1e1"];
      eventModel.find.mockReturnValue(makeFindOneChain([mockEventData]));

      const result = await service.getEventsForIds(validIds);

      expect(eventModel.find).toHaveBeenCalledWith({
        _id: { $in: expect.any(Array) },
        isDeleted: false,
      });
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Concert ABC");
    });

    it("should filter out invalid ObjectIds", async () => {
      const mixedIds = ["64c1f2e1e1e1e1e1e1e1e1e1", "invalid", "abc"];
      eventModel.find.mockReturnValue(makeFindOneChain([mockEventData]));

      const result = await service.getEventsForIds(mixedIds);

      expect(result).toHaveLength(1);
    });

    it("should return empty array when no valid IDs", async () => {
      const result = await service.getEventsForIds(["invalid"]);

      expect(result).toEqual([]);
      expect(eventModel.find).not.toHaveBeenCalled();
    });

    it("should return empty array on error", async () => {
      eventModel.find.mockImplementation(() => {
        throw new Error("DB error");
      });

      const result = await service.getEventsForIds([
        "64c1f2e1e1e1e1e1e1e1e1e1",
      ]);

      expect(result).toEqual([]);
    });

    it("should handle event without description and thumbnail", async () => {
      const eventWithoutOptional = {
        ...mockEventData,
        description: undefined,
        thumbnail: undefined,
      };
      eventModel.find.mockReturnValue(makeFindOneChain([eventWithoutOptional]));

      const result = await service.getEventsForIds([
        "64c1f2e1e1e1e1e1e1e1e1e1",
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].description).toBeUndefined();
      expect(result[0].thumbnail).toBeUndefined();
    });

    it("should return isActiveNow status for each event", async () => {
      const now = new Date();
      const activeEvent = {
        ...mockEventData,
        startDate: new Date(now.getTime() - 86400000),
        endDate: new Date(now.getTime() + 86400000),
      };
      eventModel.find.mockReturnValue(makeFindOneChain([activeEvent]));

      const result = await service.getEventsForIds([
        "64c1f2e1e1e1e1e1e1e1e1e1",
      ]);

      expect(result[0].isActiveNow).toBe(true);
    });
  });

  // ================= getSimplePrompt (private) =================

  it("should fallback to simple prompt on createPrompt error", async () => {
    eventModel.find.mockImplementation(() => {
      throw new Error("DB error");
    });

    const prompt = await service.createPrompt("test");

    expect(prompt).toContain("Bạn là trợ lý bán vé sự kiện");
  });
});
