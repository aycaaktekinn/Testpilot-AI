import { LegacyTestService } from '../core/legacy/LegacyTestService.js';
import { createLlmProvider } from '../core/llm/createLlmProvider.js';

/** Uygulama boyunca tek bir örnek — /api/tests/stop'ın "aktif run" durumunu paylaşabilmesi için. */
export const legacyTestService = new LegacyTestService(createLlmProvider());
