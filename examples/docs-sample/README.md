# 문서(Markdown) 예제

OpenAPI가 없는 문서에서 기능을 추출해 mock을 만드는 흐름. 저장소 루트에서 실행한다.

## A. 로컬 Claude Code로 자동 추출

```bash
pnpm specmock ingest docs examples/docs-sample/pets-api.md
pnpm specmock analyze docs --llm claude-code        # 청크별로 claude --print 호출 → 표 출력
pnpm specmock select docs all
pnpm specmock generate docs && pnpm specmock verify docs
```

표의 `출처` 열이 `doc`, `신뢰` 열이 1.0 미만인 행은 문서에서 추출한 것이다. `specmock show docs pets.get`으로 근거 인용을 볼 수 있다.

## B. LLM 호출 없이 재현 (녹음된 응답 사용)

```bash
pnpm specmock ingest docs examples/docs-sample/pets-api.md
pnpm specmock analyze docs --prepare
cp examples/docs-sample/extracted/*.json .specmock/docs/extracted/
pnpm specmock analyze docs --merge
```

`extracted/000.json`은 2026-11-05에 `claude --print --model sonnet`이 돌려준 결과 그대로다(청크 1개, 엔드포인트 4개). 같은 입력이라도 모델 출력은 달라질 수 있으므로 아래 표는 B 기준이다.

```
docs — 4개 기능 (openapi 0 · 문서추출 4 · 추론 0)

  #   id           method  path           출처  신뢰  샘플
── Pets (4) ────────────────────────────────────────
  1   pets.list    GET     /pets          doc   1.0   ●
  2   pets.create  POST    /pets          doc   0.8   —
  3   pets.get     GET     /pets/{petId}  doc   1.0   ●
  4   pets.delete  DELETE  /pets/{petId}  doc   0.8   —
```

## C. Claude Code 세션에서 (스킬)

`claude --plugin-dir ./plugin` 으로 세션을 열고 "examples/docs-sample/pets-api.md 로 mock 만들어줘"라고 하면 스킬이 위 단계를 안내하며 추출을 Claude가 직접 수행한다. [plugin/README.md](../../plugin/README.md) 참고.
