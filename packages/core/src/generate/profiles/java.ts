// packages/core/src/generate/profiles/java.ts
import type { LanguageProfile } from "./types.js";

const MVN_ARGS = ["-q", "-DskipTests", "package"];

/** Java 17 + Maven + Javalin. 빌드는 Maven Wrapper(only-script)가 Maven을 내려받아 한다. */
export const javaProfile: LanguageProfile = {
  language: "java",
  displayName: "Java (Maven + Javalin)",
  rules: [
    "Java 17로 컴파일한다(pom.xml의 maven.compiler.release = 17).",
    "의존성은 Javalin 6.7.0(io.javalin:javalin), com.fasterxml.jackson.core:jackson-databind 2.19.4, com.networknt:json-schema-validator 1.5.9, org.slf4j:slf4j-simple 2.0.20만 쓴다. 다른 라이브러리를 더하지 않는다.",
    "빌드 플러그인은 maven-compiler-plugin 3.15.0과 maven-shade-plugin 3.6.2. finalName은 mock이고 shade가 Main-Class 매니페스트를 가진 target/mock.jar 하나를 만든다.",
    "소스는 패키지 specmock.<name>에 둔다. <name>은 system을 소문자로 바꾸고 [^a-z0-9]를 _로 바꾼 것이며, 숫자로 시작하면 _를 앞에 붙인다(petstore → specmock.petstore). 진입점은 그 패키지의 Main 클래스다.",
    "포트는 환경 변수 PORT(없으면 4010), 바인드 주소는 127.0.0.1이다.",
    "요청 검증은 기능별 validation 스키마({params, query, body})를 networknt(Draft 7)로 한다. path·query 값은 스키마의 type(integer·number·boolean)에 맞춰 바꾼 뒤 검증한다. 실패하면 400 {\"error\":\"validation_failed\",\"details\":[...]}.",
    "응답 바디는 요청마다 작업 디렉터리 기준 fixtures/<기능 id>/<status>.json을 읽어 그대로 보낸다(application/json). 204·205는 바디 없이 상태만 보낸다.",
    "GET /__specmock/health는 200 {\"ok\":true,\"system\":<system>,\"features\":<선택 기능 수>}.",
    "notMocked의 method·경로에 맞는 요청은 501 {\"error\":\"not_mocked\",\"feature\":<id>,\"hint\":\"specmock select <system> --add <id> && specmock generate <system>\"}. 그 밖의 경로는 404 {\"error\":\"unknown_path\",\"method\":<method>,\"path\":<path>}.",
    "끝 슬래시는 구분하지 않는다. SIGTERM을 받으면 서버를 멈추고 종료한다.",
    "네트워크 호출·파일 쓰기를 하지 않는다. 파일은 pom.xml과 src/** 아래에만 낸다(mvnw·.mvn·fixtures·contracts는 이미 있다).",
  ],
  staticFiles: [
    { path: "mvnw", mode: 0o755 },
    { path: "mvnw.cmd" },
    { path: ".mvn/wrapper/maven-wrapper.properties" },
  ],
  install: (platform) => platform === "win32"
    ? { command: "cmd.exe", args: ["/c", "mvnw.cmd", ...MVN_ARGS] }
    : { command: "./mvnw", args: [...MVN_ARGS] },
  start: { command: "java", args: ["-jar", "target/mock.jar"] },
  healthPath: "/__specmock/health",
  startTimeoutMs: 60_000,
  installTimeoutMs: 600_000,
  installCheck: "target/mock.jar",
  installInputs: ["pom.xml", "src/**"],
  artifacts: ["target"],
  sourceGlobs: ["pom.xml", "src/**"],
  protectedPaths: ["fixtures/**", "contracts/**", "specmock.lock.json", ".specmock-installed", "mvnw*", ".mvn/**", "target/**"],
  maxFiles: 200,
  requires: "JDK 17 이상과 네트워크(첫 빌드)",
  referenceFiles: ["reference/pom.xml", "reference/Main.java"],
  environmentErrors: [
    /Could not transfer artifact/,
    /Could not resolve dependencies/,
    /JAVA_HOME (environment variable )?is not defined/,
    /UnknownHostException/,
    // mvnw 자체 문구(templates/java/mvnw 75·196·199행)와 javac의 JDK 버전 오류
    /does not exist in PATH nor is JAVA_HOME set/,
    /Failed to fetch/,
    /release version 17 not supported/,
    /invalid flag: --release/,   // JDK 8 javac
  ],
};
