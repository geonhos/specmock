export type ServiceStage = "ingest" | "analyze" | "extract" | "merge" | "select" | "generate" | "verify" | "generating" | "building" | "verifying" | "record";

/** 서비스가 흘리는 진행 이벤트. message는 사람이 읽는 한 줄이며 CLI는 그대로 stderr에 쓴다. */
export interface ServiceEvent { stage: ServiceStage; message: string; done?: number; total?: number }

export type OnEvent = (event: ServiceEvent) => void;
