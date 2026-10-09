// This limit mirrors the Gemini engine prompt budget, which the web package cannot import. A
// controller test checks both values for drift.
export const GEMINI_PRONUNCIATION_MAX = 300;