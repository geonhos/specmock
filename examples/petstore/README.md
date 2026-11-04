# Petstore 예제

가장 작은 end-to-end 예제. 기능 5개짜리 OpenAPI 3.0 스펙(`petstore.yaml`)으로 mock 서버를 만들고 호출해 본다. 저장소 루트에서 실행한다.

```bash
pnpm specmock run petstore examples/petstore/petstore.yaml --select all
cd mock/petstore && npm install && npm start      # http://localhost:4010 (PORT 환경변수로 변경)
```

다른 터미널에서:

```bash
curl -s localhost:4010/pets/1                     # {"id":1,"name":"Rex","tag":"dog"}  ← 스펙의 example
curl -s localhost:4010/pets                       # 스키마로 생성한 임의 배열
curl -s -X POST localhost:4010/pets               # 400 validation_failed: 필수 바디 누락
curl -s localhost:4010/store/inventory            # {}  ← 스키마가 additionalProperties뿐이라 빈 객체
curl -s localhost:4010/__specmock/health          # {"ok":true,"system":"petstore","features":5}
```

`run`은 생성 직후 contract test까지 실행한다(`contract: 통과 6 / 실패 0 / 전체 6`). 결과는 `.specmock/petstore/coverage.md`에 남는다.

## 일부만 생성하기

서버를 멈추고 `--select`를 바꿔 다시 실행한다. 선택하지 않은 기능의 라우트·contract·fixture는 정리되고, 해당 경로는 `501 not_mocked`로 응답한다.

```bash
pnpm specmock run petstore examples/petstore/petstore.yaml --select "getPet,listPets" --no-verify
cd mock/petstore && npm start
curl -s -X POST localhost:4010/pets
# {"error":"not_mocked","feature":"createPet","hint":"specmock select petstore --add createPet && specmock generate petstore"}
```

안내대로 추가하면 다시 포함된다.

```bash
pnpm specmock select petstore --add createPet
pnpm specmock generate petstore
pnpm specmock verify petstore
```

## 응답 바꿔 보기

`mock/petstore/fixtures/getPet/200.json`을 수정하면 재시작 없이 다음 요청부터 반영된다. 수정한 파일은 `generate`를 다시 실행해도 보존된다(`--force`로 덮어쓰기).
