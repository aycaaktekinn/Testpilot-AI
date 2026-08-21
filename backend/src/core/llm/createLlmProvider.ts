import type { LlmProvider } from './LlmProvider.js';
import { OpenRouterProvider } from './OpenRouterProvider.js';
import { GeminiProvider } from './GeminiProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { env } from '../../config/env.js';

/**
 * Factory: env.LLM_PROVIDER değerine göre doğru LlmProvider implementasyonunu döner.
 * Yeni bir sağlayıcı eklemek istendiğinde sadece burada bir case eklemek yeterlidir;
 * geri kalan tüm sistem LlmProvider arayüzüne bağımlıdır, somut sınıfa değil.
 */
export function createLlmProvider(): LlmProvider {
  switch (env.LLM_PROVIDER) {
    case 'openrouter':
      return new OpenRouterProvider();
    case 'gemini':
      return new GeminiProvider();
    case 'ollama':
      return new OllamaProvider();
    default:
      throw new Error(`Bilinmeyen LLM_PROVIDER: ${env.LLM_PROVIDER as string}`);
  }
}
