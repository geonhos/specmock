# specmock Claude Code 플러그인

Claude Code 안에서 "이 스펙으로 mock 만들어줘"라고 하면 `specmock` 스킬이 CLI 단계를 안내하고, 웹 문서처럼 LLM이 읽어야 하는 스펙은 세션의 Claude가 직접 추출한다(추가 API 키 없음).

## 로드

```bash
# 이 저장소를 clone한 뒤, 세션에 한해 로드
claude --plugin-dir ./plugin
```

로드하면 **스킬과 MCP 서버(`specmock`)가 함께 켜진다.** MCP 서버는 저장소의 빌드 산출물(`packages/mcp/dist/server.js`)을 `node`로 실행하므로 먼저 빌드가 필요하다:

```bash
pnpm install && pnpm build
```

MCP 서버는 Claude Code를 실행한 디렉터리를 프로젝트 루트로 쓴다. 상태는 `.specmock/`, mock은 `mock/` 아래에 생긴다. `/mcp`에서 specmock 서버와 도구 11개를 확인할 수 있다. 도구가 보이지 않으면 스킬은 CLI 흐름으로 진행한다.

CLI는 PATH에 `specmock`이 있거나(`pnpm build && npm link packages/cli`) 저장소 루트에서 `pnpm specmock`으로 실행돼야 한다.

## 구성

- `skills/specmock/SKILL.md` — 흐름과 사용자에게 보여줄 형식
- `skills/specmock/references/extraction.md` — 세션 내 LLM 추출 절차
- `skills/specmock/references/manual-harvest.md` — ego-browser 수동 수확
- `.claude-plugin/plugin.json`의 `mcpServers` — `../packages/mcp/dist/server.js` 실행 (stdio)
