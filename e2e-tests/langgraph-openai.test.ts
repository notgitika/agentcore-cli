import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({ framework: 'LangChain_LangGraph', modelProvider: 'OpenAI', requiredEnvVar: 'OPENAI_API_KEY' });
