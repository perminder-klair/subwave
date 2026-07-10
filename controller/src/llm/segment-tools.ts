// Public surface for the segment-director's real-world data tools.
// Implementation in internal/tools/segment-tools.ts. Barrel so call sites keep
// importing from `llm/segment-tools.js` unchanged.

export { buildSegmentTools, fetchSegmentData } from './internal/tools/segment-tools.js';
