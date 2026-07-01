import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import config from "@src/config/config";

const OLLAMA_GENERATE_TIMEOUT_MS = 30_000;
const OLLAMA_PING_TIMEOUT_MS = 5_000;

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);
  private readonly ollamaUrl = config.OLLAMA_URL;
  private readonly model = config.OLLAMA_MODEL;

  async generateResponse(prompt: string): Promise<string> {
    try {
      const response = await axios.post(
        `${this.ollamaUrl}/api/generate`,
        {
          model: this.model,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 1000,
          },
        },
        { timeout: OLLAMA_GENERATE_TIMEOUT_MS }
      );

      return response.data.response;
    } catch (error) {
      this.logger.error("Ollama API error:", error);
      throw new Error(
        `Failed to generate response: ${(error as Error).message}`
      );
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await axios.get(`${this.ollamaUrl}/api/tags`, {
        timeout: OLLAMA_PING_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }
}
