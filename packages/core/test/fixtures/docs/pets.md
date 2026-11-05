# Pets API

Base URL: `https://api.example.com/v1`. All requests need `Authorization: Bearer <token>`.

## List pets

`GET /pets` returns an array of pets. Query `limit` (integer, max 100).

```json
[{"id": 1, "name": "Rex", "tag": "dog"}]
```

## Get a pet

`GET /pets/{petId}` returns one pet. Responds `404` with `{"code": 404, "message": "not found"}` when missing.

```json
{"id": 1, "name": "Rex", "tag": "dog"}
```

## Create a pet

`POST /pets` with body `{"name": string, "tag"?: string}`. Returns `201` and the created pet.

## Delete a pet

`DELETE /pets/{petId}` returns `204`.
