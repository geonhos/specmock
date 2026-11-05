# 수동 수확 (ego-browser)

자동 수확이 안 됐거나(미설치 · 로그인 필요 · 타임아웃), 자동 수확이 다루지 않는 요소(커스텀 드롭다운 listbox/combobox)가 있거나, 수확 후에도 기능이 0건일 때.

**실제 ego-browser 사용법은 `ego-browser skill` 출력이 기준이다.** 버전에 따라 API가 바뀌므로 먼저 실행해 읽는다. 핵심 요약:

- 사용자 목표 하나에 **TaskSpace는 하나만** 만든다(`taskSpace("이름")`). 막혀도 새 TaskSpace로 우회하지 않는다.
- 스크립트는 `ego-browser nodejs`로 실행한다. 매 실행마다 JS 변수는 사라지므로 `spaceId`와 페이지 라벨(`p1`)을 출력해 두고 이어서 쓴다.
- 페이지를 열고 `page.snapshot()`으로 구조를 본다. 탭, 셀렉트박스, "더 보기", 아코디언을 찾는다.
- 요소는 `loc=role:button[name='...']` 같은 셀렉터로 조작한다. Playwright API(`getByRole` 등)는 없다.
- 드러난 영역의 텍스트는 `page.evaluate`로 가져온다(코드 블록은 그대로).
- 로그인이 필요하면 `await task.handOff()`로 사용자에게 넘기고 라운드를 끝낸다. 사용자가 로그인했다고 하면 같은 space를 이어서 쓴다. **자격 증명을 대신 입력하지 않는다.**
- 작업이 끝나면 마지막에 한 번만 `task.finish({ keep: [] })`.

## specmock에 반영

1. 가져온 내용을 `.specmock/<system>/source.json`의 해당 input에 추가한다:
   `harvested.interactions.push({ "type": "tab" | "select" | "details" | "listbox", "label": "<무엇을 눌렀는지>", "content": "<Markdown 또는 텍스트>" })`
   (`harvested`가 없으면 `{ "pages": [], "interactions": [], "notes": [] }`로 만든다.)
2. **비밀값(API 키, 토큰, 비밀번호, 세션 쿠키 등)이 보이면 넣기 전에 지운다.** 자동 수확은 마스킹을 거치지만 수동으로 넣는 내용은 마스킹되지 않는다.
3. `specmock analyze <system>`을 다시 실행하면 prepare가 수확 내용을 "## [수확] …" 섹션으로 청크에 포함한다.
