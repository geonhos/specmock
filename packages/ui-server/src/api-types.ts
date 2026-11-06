import type { ApiErrorBody } from "./errors.js";

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = ApiErrorBody;
export type EnvInfo = { root: string; claude: boolean };
