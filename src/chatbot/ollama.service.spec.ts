import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { OllamaService } from "./ollama.service";
import axios from "axios";

jest.mock("axios");
jest.mock("@src/config/config", () => ({
  __esModule: true,
  default: {
    OLLAMA_URL: "http://localhost:11434",
    OLLAMA_MODEL: "llama2",
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("OllamaService", () => {
  let service: OllamaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, "error").mockImplementation();

    const module: TestingModule = await Test.createTestingModule({
      providers: [OllamaService],
    }).compile();

    service = module.get<OllamaService>(OllamaService);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  describe("generateResponse", () => {
    it("should return response from Ollama API", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { response: "Generated response" },
      });

      const result = await service.generateResponse("Test prompt");

      expect(result).toBe("Generated response");
    });

    it("should send correct payload to configured endpoint", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { response: "test" },
      });

      await service.generateResponse("User query");

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "http://localhost:11434/api/generate",
        {
          model: "llama2",
          prompt: "User query",
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 1000,
          },
        },
        { timeout: 30000 }
      );
    });

    it("should handle multi-line responses", async () => {
      const multiLine = "Event 1: Concert\nEvent 2: Theater\nEvent 3: Sports";
      mockedAxios.post.mockResolvedValueOnce({
        data: { response: multiLine },
      });

      const result = await service.generateResponse("List events");

      expect(result).toContain("\n");
      expect(result).toContain("Event 1");
    });

    it("should handle long prompts", async () => {
      const longPrompt = "A".repeat(5000);
      mockedAxios.post.mockResolvedValueOnce({
        data: { response: "Response" },
      });

      const result = await service.generateResponse(longPrompt);

      expect(result).toBeDefined();
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ prompt: longPrompt }),
        expect.any(Object)
      );
    });

    it("should handle empty prompt", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { response: "" },
      });

      const result = await service.generateResponse("");

      expect(result).toBe("");
    });

    it("should handle special characters in prompt", async () => {
      const prompt = "Events with symbols: @#$%^&()";
      mockedAxios.post.mockResolvedValueOnce({
        data: { response: "Response with @#$" },
      });

      const result = await service.generateResponse(prompt);

      expect(result).toBe("Response with @#$");
    });

    it("should throw on connection error", async () => {
      mockedAxios.post.mockRejectedValueOnce(
        new Error("Ollama connection failed")
      );

      await expect(service.generateResponse("test")).rejects.toThrow(
        "Failed to generate response: Ollama connection failed"
      );
    });

    it("should throw on timeout", async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error("Request timeout"));

      await expect(
        service.generateResponse("long running task")
      ).rejects.toThrow("Failed to generate response: Request timeout");
    });

    it("should throw on model not found", async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error("Model not found"));

      await expect(service.generateResponse("test")).rejects.toThrow(
        "Failed to generate response: Model not found"
      );
    });

    it("should log errors via logger", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "error");
      mockedAxios.post.mockRejectedValueOnce(new Error("API error"));

      await expect(service.generateResponse("test")).rejects.toThrow();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Ollama API error: API error")
      );
    });
  });

  describe("testConnection", () => {
    it("should return true when Ollama is reachable", async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { models: [] } });

      const result = await service.testConnection();

      expect(result).toBe(true);
    });

    it("should call the correct endpoint for connection test", async () => {
      mockedAxios.get.mockResolvedValueOnce({});

      await service.testConnection();

      expect(mockedAxios.get).toHaveBeenCalledWith(
        "http://localhost:11434/api/tags",
        { timeout: 5000 }
      );
    });

    it("should return false when connection fails", async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await service.testConnection();

      expect(result).toBe(false);
    });

    it("should return false on network error", async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error("Network error"));

      const result = await service.testConnection();

      expect(result).toBe(false);
    });

    it("should return false on timeout", async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error("Timeout"));

      const result = await service.testConnection();

      expect(result).toBe(false);
    });

    it("should not throw errors during connection test", async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error("Any error"));

      const result = await service.testConnection();

      expect(result).toBe(false);
    });
  });
});
