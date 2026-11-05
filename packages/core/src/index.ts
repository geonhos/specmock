export const VERSION = "0.1.0";

export * from "./types.js";
export { Workspace } from "./workspace.js";
export { hashJson, hashText } from "./util/hash.js";
export { ingest, ingestOne, detectKind } from "./ingest/index.js";
export { maskSecrets } from "./ingest/mask.js";
export { analyze } from "./analyze/index.js";
export { analyzeOpenApiDocument } from "./analyze/openapi.js";
export { orderFeatures, type OrderedFeature } from "./catalog/order.js";
export { formatCatalog } from "./catalog/format.js";
export { resolveSelection } from "./select/expression.js";
export { select, type SelectOptions, type SelectResult } from "./select/index.js";
export { generate, defaultMockDir, type GenerateOptions } from "./generate/index.js";
export { readLock, type Lock } from "./generate/lock.js";
export type { GenerateReport } from "./generate/tsHono.js";
export { verify, loadContracts, type VerifyOptions, type VerifyResult, type ContractResult } from "./verify/index.js";
export { startMock, ensureInstalled, type RunningMock, type StartMockOptions } from "./verify/server.js";
export { renderCoverage } from "./verify/coverage.js";
