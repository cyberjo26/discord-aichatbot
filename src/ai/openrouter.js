// Backward-compatible facade. Existing commands keep this import path while
// provider selection and failover live in router.js.
export { chatCompletion, getAiStats } from './router.js';
export { default } from './router.js';
