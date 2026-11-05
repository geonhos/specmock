import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PETSTORE = path.join(here, "fixtures", "petstore.yaml");
export const CIRCULAR = path.join(here, "fixtures", "circular.yaml");
/** 루트 node_modules. 생성된 mock에 심볼릭 링크하여 설치 없이 기동할 때 쓴다. */
export const ROOT_NODE_MODULES = path.resolve(here, "..", "..", "..", "node_modules");
