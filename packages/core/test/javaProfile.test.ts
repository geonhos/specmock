// packages/core/test/javaProfile.test.ts
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchesAny } from "../src/generate/glob.js";
import { readStaticFiles } from "../src/generate/llm.js";
import { launchCommand } from "../src/generate/lock.js";
import { SUPPORTED_LANGUAGES, getProfile } from "../src/generate/profiles/index.js";
import { javaProfile } from "../src/generate/profiles/java.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const JAVA_TEMPLATES = path.resolve(here, "..", "templates", "java");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("javaProfile", () => {
  it("정적 파일은 mvnw(실행 권한)·mvnw.cmd·wrapper 설정·FormBody.java 네 개이고 내용은 3.3.4 only-script 배포본과 같다", async () => {
    const files = await readStaticFiles(javaProfile);
    expect(files.map((f) => f.path)).toEqual(["mvnw", "mvnw.cmd", ".mvn/wrapper/maven-wrapper.properties", "src/main/java/specmock/runtime/FormBody.java"]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(sha256(byPath["mvnw"]!.content!)).toBe("cae96cef89ebea3531221f4ae17c23cf8edf67d00eae8306d4186ae1bbed4d02");
    expect(sha256(byPath["mvnw.cmd"]!.content!)).toBe("46eedb8419bd14fe70d5bb2916d7b6f51806e51b39d5b76a42610384ca929c1c");
    expect(byPath["mvnw"]!.mode).toBe(0o755);
    expect(byPath["mvnw.cmd"]!).not.toHaveProperty("mode");
    expect(byPath[".mvn/wrapper/maven-wrapper.properties"]!.content).toMatch(/distributionType=only-script/);
    expect(byPath[".mvn/wrapper/maven-wrapper.properties"]!.content).toMatch(/apache-maven-3\.9\.16-bin\.zip/);
    // 템플릿 파일 자체도 실행 권한을 가진다(git이 보존).
    expect((await stat(path.join(JAVA_TEMPLATES, "mvnw"))).mode & 0o111).not.toBe(0);
  });

  it("FormBody.java는 정적 파일이면서 보호 경로이고 고정 패키지 specmock.runtime에 있다", async () => {
    const p = "src/main/java/specmock/runtime/FormBody.java";
    expect(javaProfile.staticFiles.map((f) => f.path)).toContain(p);
    expect(matchesAny(javaProfile.protectedPaths, p)).toBe(true);
    const files = await readStaticFiles(javaProfile);
    expect(files.find((f) => f.path === p)!.content).toMatch(/^package specmock\.runtime;/);
  });

  it("install은 플랫폼별로 갈린다(Windows는 cmd.exe /c mvnw.cmd)", () => {
    const unix = { command: "./mvnw", args: ["-q", "-DskipTests", "package"] };
    expect(javaProfile.install("darwin")).toEqual(unix);
    expect(javaProfile.install("linux")).toEqual(unix);
    expect(javaProfile.install("win32")).toEqual({ command: "cmd.exe", args: ["/c", "mvnw.cmd", "-q", "-DskipTests", "package"] });
    expect(javaProfile.start).toEqual({ command: "java", args: ["-jar", "target/mock.jar"] });
  });

  it("설치 결과물·설치 키 입력·산출물이 Maven 빌드에 맞다", () => {
    expect(javaProfile).toMatchObject({ installCheck: "target/mock.jar", installInputs: ["pom.xml", "src/**"], artifacts: ["target"] });
  });

  it("lock에 기록될 install·start로 실행 안내를 만든다", () => {
    const lock = { language: "java", install: javaProfile.install("darwin"), start: javaProfile.start };
    expect(launchCommand(lock)).toBe("./mvnw -q -DskipTests package && java -jar target/mock.jar");
  });

  it("모델은 pom.xml·src/**만 쓰고 wrapper·fixtures·target은 보호한다", () => {
    for (const p of ["pom.xml", "src/main/java/specmock/petstore/Main.java", "src/main/resources/x.json"]) {
      expect(matchesAny(javaProfile.sourceGlobs, p)).toBe(true);
    }
    for (const p of ["mvnw", "mvnw.cmd", ".mvn/wrapper/maven-wrapper.properties", "fixtures/getPet/200.json", "contracts/getPet.json", "specmock.lock.json", ".specmock-installed", "target/mock.jar"]) {
      expect(matchesAny(javaProfile.protectedPaths, p)).toBe(true);
    }
    expect(matchesAny(javaProfile.sourceGlobs, "build.gradle")).toBe(false);
  });

  it("환경 오류(JDK·네트워크)만 재시도 없이 멈추고 컴파일 오류는 재시도 대상이다", () => {
    const env = (log: string) => (javaProfile.environmentErrors ?? []).some((re) => re.test(log));
    // mvnw 실제 문구(templates/java/mvnw 57·75·196·199행)와 대조해 둔 패턴이다. 목록을 바꾸면 다시 대조한다.
    expect(env("The JAVA_HOME environment variable is not defined correctly, so mvnw cannot run.")).toBe(true);
    expect(env("The java/javac command does not exist in PATH nor is JAVA_HOME set, so mvnw cannot run.")).toBe(true);
    expect(env("curl: Failed to fetch https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.16/apache-maven-3.9.16-bin.zip")).toBe(true);
    expect(env("wget: Failed to fetch https://repo.maven.apache.org/x.zip")).toBe(true);
    expect(env("[ERROR] Fatal error compiling: error: release version 17 not supported")).toBe(true);
    expect(env("error: invalid flag: --release")).toBe(true);   // JDK 8 javac
    expect(env("Error: JAVA_HOME is not defined correctly.")).toBe(true);
    expect(env("[ERROR] Failed to execute goal on project mock: Could not resolve dependencies for project")).toBe(true);
    expect(env("[ERROR] Failed to execute goal … Could not transfer artifact io.javalin:javalin:pom:6.7.0 from/to central")).toBe(true);
    expect(env("java.net.UnknownHostException: repo.maven.apache.org")).toBe(true);
    expect(env("[ERROR] /x/src/main/java/specmock/petstore/Main.java:[12,5] cannot find symbol")).toBe(false);
  });

  it("규칙·참조·요구 사항이 프롬프트에 들어갈 수 있게 채워져 있다", async () => {
    expect(javaProfile).toMatchObject({
      language: "java", displayName: "Java (Maven + Javalin)", healthPath: "/__specmock/health",
      startTimeoutMs: 60_000, installTimeoutMs: 600_000, maxFiles: 200, requires: "JDK 17 이상과 네트워크(첫 빌드)",
      referenceFiles: ["reference/pom.xml", "reference/Main.java"],
    });
    expect(javaProfile.rules.join("\n")).toMatch(/Javalin 6\.7\.0/);
    expect(javaProfile.rules.join("\n")).toMatch(/target\/mock\.jar/);
    expect(javaProfile.rules.join("\n")).toMatch(/127\.0\.0\.1/);
    expect(javaProfile.rules.join("\n")).toContain("specmock.<name>에 둔다. <name>은 system을 소문자로 바꾸고 [^a-z0-9]를 _로 바꾼 것이며, 숫자로 시작하면 _를 앞에 붙인다");
    expect(await readFile(path.join(JAVA_TEMPLATES, ".mvn", "wrapper", "maven-wrapper.properties"), "utf8")).toMatch(/wrapperVersion=3\.3\.4/);
  });

  it("참조 발췌는 참조 mock과 같은 내용이다(프롬프트의 예시가 실제로 빌드·검증되는 코드)", async () => {
    const FIXTURE = path.resolve(here, "fixtures", "java-petstore");
    expect(await readFile(path.join(JAVA_TEMPLATES, "reference", "pom.xml"), "utf8")).toBe(await readFile(path.join(FIXTURE, "pom.xml"), "utf8"));
    expect(await readFile(path.join(JAVA_TEMPLATES, "reference", "Main.java"), "utf8"))
      .toBe(await readFile(path.join(FIXTURE, "src", "main", "java", "specmock", "petstore", "Main.java"), "utf8"));
  });

  it("java는 등록표에 있다", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["ts", "java"]);
    expect(getProfile("java")).toBe(javaProfile);
  });
});
