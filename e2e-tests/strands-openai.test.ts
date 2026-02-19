import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({ framework: 'Strands', modelProvider: 'OpenAI', requiredEnvVar: 'OPENAI_API_KEY' });
