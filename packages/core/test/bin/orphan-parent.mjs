// 빌드된 procGroup(node로 직접 실행, tsx 아님)으로 손자까지 있는 자식을 띄우고 기다리는 부모. 시그널 정리 테스트용.
// argv: <procGroup.js 경로> <pid 기록 파일> [with-listener]
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [mod, pidFile, mode] = process.argv.slice(2);
const { spawnGroup } = await import(pathToFileURL(mod).href);
if (mode === "with-listener") process.on("SIGTERM", () => { writeFileSync(`${pidFile}.listener`, "ran"); setTimeout(() => process.exit(7), 50); });
const child = spawnGroup("sh", ["-c", `sleep 60 & echo "$$ $!" > '${pidFile}'; wait`], { stdio: "ignore" });
if (mode !== "with-listener") child.on("close", () => process.exit(0));
setInterval(() => {}, 1000);
