import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);
  private readonly ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  private readonly model = process.env.OLLAMA_MODEL || 'llama3';

  async generateResponse(prompt: string): Promise<string> {
    try {
      const response = await axios.post(`${this.ollamaUrl}/api/generate`, {
        model: this.model,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 1000
        }
      });

      return response.data.response;
    } catch (error) {
      this.logger.error('Ollama API error:', error);
      throw new Error(`Failed to generate response: ${error.message}`);
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await axios.get(`${this.ollamaUrl}/api/tags`);
      return true;
    } catch {
      return false;
    }
  }
}