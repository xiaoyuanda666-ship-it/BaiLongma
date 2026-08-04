// Public, storage-independent primitives for the knowledge cortex pipeline.
export {
  normalizePlainText,
  normalizeHtml,
  normalizeCsv,
  normalizeKnowledgeText,
  canonicalizeSourceUri,
  hashContent,
  hashSource,
} from './text.js'
export { estimateTokenCount, chunkText } from './chunker.js'
export { formatKnowledgeLocator, formatKnowledgeEvidence } from './formatter.js'
export { buildKnowledgeQuery, shouldRetrieveKnowledge, rerankEvidence } from './retrieval.js'
