# specmock Claude Code 플러그인

Claude Code 안에서 "이 스펙으로 mock 만들어줘"라고 하면 `specmock` 스킬이 CLI 단계를 안내하고, 웹 문서처럼 LLM이 읽어야 하는 스펙은 세션의 Claude가 직접 추출한다(추가 API 키 없음).

## 로드

```bash
# 이 저장소를 clone한 뒤, 세션에 한해 로드
claude --plugin-dir ./plugin
```

CLI는 PATH에 `specmock`이 있거나(`pnpm --filter @specmock/cli build && npm link packages/cli`) 저장소 루트에서 `pnpm specmock`으로 실행돼야 한다.

## 구성

- `skills/specmock/SKILL.md` — 흐름과 사용자에게 보여줄 형식
- `skills/specmock/references/extraction.md` — 세션 내 LLM 추출 절차
- `skills/specmock/references/manual-harvest.md` — ego-browser 수동 수확

2단계에서 MCP 서버를 같은 플러그인에 추가한다.
