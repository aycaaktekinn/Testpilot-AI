import { ScenarioSuggester } from '../core/scenario/ScenarioSuggester.js';
import { createLlmProvider } from '../core/llm/createLlmProvider.js';

// legacyTestServiceInstance.ts ile aynı desen: tek bir paylaşılan LlmProvider örneği üzerinden
// kurulan, süreç ömrü boyunca yaşayan tek bir singleton.
export const scenarioSuggester = new ScenarioSuggester(createLlmProvider());
