// Public surface for the picker's music-discovery tools. Implementation in
// internal/tools/picker/ (one file per tool + the shared scope). Barrel so call
// sites keep importing from `llm/tools.js` unchanged.

export { buildPickerTools, pickerScope, PICKER_TOOLS } from './internal/tools/picker/index.js';
export type { PickerScope, PickerContext, PickerToolModule } from './internal/tools/picker/index.js';

export { clearPickerSourceCache } from './internal/tools/picker/source-pool-cache.js';
