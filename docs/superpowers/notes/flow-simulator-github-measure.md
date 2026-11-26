# GitHub REST API 스펙 측정 결과

측정일 2026-11-26. 이슈 #29, 상위 이슈 #28. 소스, 테스트, 설정은 바꾸지 않았습니다.

## 결론

- 현재 코드는 GitHub 스펙(1,281개 기능)을 모든 단계에서 처리합니다. 실패한 단계는 없고, 가장 큰 단계도 1.6 GB, 2초 이내입니다.
- 크기 문제는 시간이 아니라 파일 크기입니다. 원본 14.3 MB가 `source.json` 56.8 MB, `catalog.json` 37.3 MB로 늘고, 전체 선택의 `mockspec.json`은 87.2 MB입니다.
- 기능 6개만 고르면 `mockspec.json`은 2.3 MB입니다. 기능 하나가 평균 0.4 MB이고, 응답 스키마가 `$ref`마다 펼쳐지기 때문입니다.
- 한도를 둔다면 시간과 메모리가 아니라 `mockspec.json` 크기 기준이 맞습니다. 이번 측정으로는 처리 불가 지점을 찾지 못했습니다.
- "고른 기능만 처리"는 시간을 줄이지 못하지만(analyze 1.1초) 산출물을 줄입니다. ingest와 analyze는 이미 충분히 빠르므로 그 단계를 바꿀 필요는 없습니다.

## 측정 환경

| 항목 | 값 |
|---|---|
| 기기 | Apple M4 Pro, 메모리 48 GB, macOS (Darwin 25.6.0) |
| Node | v26.10.0 |
| 실행 방식 | `tsx packages/cli/src/cli.ts <명령>` (core는 빌드한 dist 사용) |
| 스펙 출처 | `https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json` |
| 받은 시각 | 2026-11-26 12:17 UTC |
| 스펙 버전 | OpenAPI 3.0.3, `info.version` 1.1.4. 저장소 커밋 해시는 확인하지 못했고, ETag는 `8533af687f064150b4c06c4e3253f3885fe031abfbfd6f51a4509dca23011b7e`입니다. |
| 파일 크기 | 14,283,088 바이트 |

최대 메모리(peak RSS)에는 tsx 시작 비용이 들어 있습니다. `--version`만 실행해도 약 0.3 GB, 0.5초입니다.

## 단계별 측정

각 단계는 한 번씩 측정했습니다(select는 같은 값을 두 번 확인). 시간은 `/usr/bin/time -l`의 real입니다.

| 단계 | 시간 | 최대 메모리 | 산출물 크기 | 결과 |
|---|---|---|---|---|
| ingest | 4.09초 | 1.88 GB | `source.json` 56,778,732 바이트 | 성공. 원문 50,499,052자로 읽음 |
| analyze (OpenAPI, LLM 없음) | 1.11초 | 1.12 GB | `catalog.json` 37,316,645 바이트 | 성공. 기능 1,281개, 그룹 46개, 거절 0개 |
| select 6개 | 0.92초 | 0.81 GB | `mockspec.json` 2,266,577 바이트 | 성공 |
| generate (6개, ts) | 0.58초 | 0.35 GB | 출력 1.3 MB, 파일 22개 | 성공 |
| select `group:issues` (66개) | 0.96초 | 0.90 GB | `mockspec.json` 14,075,058 바이트 | 성공 |
| select `group:repos` (204개) | 0.96초 | 0.89 GB | `mockspec.json` 11,202,061 바이트 | 성공 |
| select `all` (1,281개) | 1.72초 | 1.60 GB | `mockspec.json` 87,220,959 바이트 | 성공 |
| generate (전체, ts) | 1.88초 | 1.01 GB | 출력 53 MB, 파일 2,616개 | 성공. 요청 범위 밖의 참고 측정 |

- 기능 수보다 스키마 크기가 `mockspec.json`을 좌우합니다. issues 66개가 14.1 MB이고 repos 204개가 11.2 MB입니다. issues 기능 하나가 repos 기능 하나의 약 4배입니다.
- generate는 출력을 저장소 밖(`/tmp`)에 만들었습니다. 저장소에는 `mock/`을 만들지 않았습니다.

가장 큰 그룹 10개(기능 수):

| 그룹 | 기능 수 |
|---|---|
| repos | 204 |
| actions | 200 |
| orgs | 116 |
| issues | 66 |
| users | 55 |
| codespaces | 48 |
| copilot | 44 |
| apps | 37 |
| pulls | 36 |
| activity | 34 |

## 원본 스펙에서 확인한 것

| 항목 | 값 |
|---|---|
| OpenAPI 버전 | 3.0.3 |
| 경로 수 / operation 수 | 842 / 1,281 |
| 응답의 `links` | 0개. 선언한 응답이 없습니다. |
| `security`, `securitySchemes` | 둘 다 선언하지 않았습니다. operation 단위 `security`도 0개입니다. 카탈로그의 `auth`는 1,281개 전부 `none`입니다. |
| `requestBody`가 있는 operation | 370개. 그중 `required` 키가 있는 것은 366개, 값이 `true`인 것은 301개 |
| 경로 변수가 `/`를 담을 수 있는 operation | `{path}` 3개, `{ref}` 11개, `{basehead}` 2개, `{branch}` 36개(브랜치 이름에 `/`가 들어갈 수 있음) |
| operationId 형식 | `그룹/동작` 슬래시 형식. 예: `meta/root`, `security-advisories/list-global-advisories`, `security-advisories/get-global-advisory` |

카탈로그의 기능 id는 operationId의 `/`를 `_`로 바꾼 형태입니다(예: `issues_create`).

## 추론 가정 확인

6개 기능의 카탈로그 내용입니다. 응답 열은 2xx 응답 스키마의 최상위 필드입니다.

| 기능 id | 경로 | 경로 변수 | 필수 본문 필드 | 2xx 응답의 최상위 필드 |
|---|---|---|---|---|
| `repos_create-for-authenticated-user` | `POST /user/repos` | 없음 | `name` (속성 23개) | 201: `name`, `id`, `full_name`, `html_url`, `owner.login` 있음 (최상위 속성 105개) |
| `repos_get` | `GET /repos/{owner}/{repo}` | `owner`, `repo` | 본문 없음 | 200: 위와 같음 |
| `repos_delete` | `DELETE /repos/{owner}/{repo}` | `owner`, `repo` | 본문 없음 | 204: 본문 없음 |
| `issues_create` | `POST /repos/{owner}/{repo}/issues` | `owner`, `repo` | `title` (속성 10개) | 201: `number`, `id`, `html_url` 있음. `name`과 `owner.login`은 최상위에 없음 (속성 41개) |
| `issues_get` | `GET /repos/{owner}/{repo}/issues/{issue_number}` | `owner`, `repo`, `issue_number` | 본문 없음 | 200: `issues_create`와 같음 |
| `issues_update` | `PATCH /repos/{owner}/{repo}/issues/{issue_number}` | `owner`, `repo`, `issue_number` | 필수 필드 없음(`required` 없음, 속성 12개) | 200: 스키마가 `allOf`로 감싸여 있어 최상위 `properties`가 비어 있습니다. 필드를 읽으려면 `allOf`를 풀어야 합니다. |

- 경로 변수 이름과 응답 필드 이름이 맞는 경우: `repo`←`name`, `issue_number`←`number`, `owner`←`owner.login`. 이름 일치 규칙만으로는 `repo`와 `name`, `issue_number`와 `number`가 이어지지 않습니다.
- `issues_create` 응답에는 `owner`가 없습니다. `owner`는 앞 단계(`repos_create`) 응답의 `owner.login`에서 가져와야 합니다.
- 필수 본문 필드는 스키마의 `required`로 남아 있습니다. `requestBody.required` 자체(본문이 필수인지)는 카탈로그에 없습니다. 설계 문서의 사실과 같습니다.
- `issues_update`의 `title`은 `oneOf`(문자열 또는 정수)에 `nullable`입니다. 값을 만드는 규칙이 `oneOf`를 처리해야 합니다.

## 실패와 우회

실패한 단계는 없습니다. 우회는 쓰지 않았습니다. `--max-old-space-size`도 기본값 그대로 실행했습니다.

측정하지 않은 것:

- 문서(markdown, HTML) 입력 경로와 LLM 경로
- Java 생성기
- 생성한 mock 서버의 실행과 `verify`

측정 중 한 가지 규칙을 어겼습니다. 스펙 커밋 해시를 찾으려고 `api.github.com`의 커밋 조회 API를 토큰 없이 한 번 호출했습니다. 응답은 사용하지 않았고(출력을 버림), 그 외 `api.github.com` 호출은 없습니다.
