# telegram-storage

Telegram 기반 무제한 파일 스토리지 — **실제 바이너리는 Telegram 봇에, 메타데이터는 SQLite에** 저장하는 개인 프로젝트(M1+M2).

- **백엔드**: Hono + TypeScript (Node 24)
- **DB**: SQLite (better-sqlite3, WAL)
- **Telegram 클라이언트**: grammY (+ throttler, autoRetry) — **토큰이 없으면 mock 클라이언트로 전체 동작 검증 가능**
- **청크**: 15MB 고정 (Telegram 공개 Bot API: 업로드 50MB / 다운로드 20MB 한도 이내)
- **무결성**: 파트별 sha256 checksum 저장 + 다운로드 시 검증
- **속도제한**: 앱 레벨 큐(직렬 실행 + 최소 간격 + 429 시 `retry_after` 존중 + 지수 백오프)

> 이번 범위(M1+M2): 파일 업로드/다운로드/목록/논리삭제, 15MB 분할·조립, checksum, mock 검증.
> M3(폴더·권한·인증) / M4(웹 UI) 는 범위 외입니다.

## 아키텍처

```
클라이언트 ──REST──▶ Hono API ──▶ SQLite (files / parts)
                      │
                      └─ 속도제한 큐 ──▶ TgClient (grammY 실전 / mock 로컬 저장)
                                          └─ Telegram 전용 비공개 채널
```

업로드: 요청 본문 → 임시 디스크 스트리밍 → 15MB 분할 → 청크별 `sendDocument` → 전 청크 성공 후 `files`+`parts` 원자 커밋 → 임시 파일 정리 (실패 시 DB 롤백, 부분 전송된 Telegram 메시지는 고아로 남음 — 설계상 허용).
다운로드: `parts`를 `part_index` 순으로 조회 → `getFile` → 파트별 sha256 검증 → 스트리밍 응답.

## 요구사항

- Node.js **24 이상** (권장: 24.x LTS)

## 설치

```bash
npm install
```

## 설정 (.env)

```bash
cp .env.example .env
```

토큰이 **없어도** mock 모드로 전체 동작이 가능합니다. 실전(REAL) 모드만 아래 4단계가 필요합니다.

### 1) 봇 생성 (@BotFather)

1. Telegram에서 [@BotFather](https://t.me/BotFather)를 열고 `/newbot` 실행
2. 봇 이름/유저네임 입력 → 발급되는 토큰을 `.env`의 `TELEGRAM_BOT_TOKEN`에 입력

### 2) 전용 비공개 채널 생성 (팀 그룹 금지!)

1. Telegram에서 **새 채널 생성** (유형: Private)
2. 채널명은 저장소 전용으로 (예: "tg-storage")
3. 채널 설정 → **Administrators** → 봇 유저네임 검색 → **Add Administrator**
   (관리자 권한은 기본값으로 충분 — 메시지 게시 권한 포함)

### 3) chat id 확인

`npm run chatid` 헬퍼 사용 (토큰 필요):

```bash
# 공개 유저네임이 있는 경우
npm run chatid -- @mychannel
# 완전 비공개 채널: 채널에 아무 메시지나 게시한 뒤
npm run chatid
```

또는 직접: `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` 후 `channel_post.chat.id` 확인.
채널 id는 보통 `-100...` 형태의 숫자입니다. `.env`의 `STORAGE_CHAT_ID`에 입력.

### 4) 실행

```bash
npm run dev        # 개발 모드 (tsx watch)
# 또는
npm start          # 실행
```

시작 로그에 `telegram client: MOCK` 또는 `grammY (real)`이 표시됩니다.

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/api/files` | multipart(`file` 필드) 업로드 → 분할 → Telegram 저장 → 메타데이터 기록 |
| `GET` | `/api/files` | 파일 목록 (tg 식별자 미노출) |
| `GET` | `/api/files/:id/download` | 파트 재조립 + checksum 검증 + 스트리밍 다운로드 |
| `DELETE` | `/api/files/:id` | 논리 삭제 (`deleted_at` 설정) |
| `GET` | `/health` | 헬스 체크 |

```bash
# 업로드
curl -F "file=@/path/to/big.bin" http://localhost:3000/api/files
# → {"id":"1","name":"big.bin","size":125829120,"mime":"application/octet-stream","partCount":8}

# 목록
curl http://localhost:3000/api/files

# 다운로드 (원본 파일명으로 저장)
curl -OJ http://localhost:3000/api/files/1/download

# 삭제
curl -X DELETE http://localhost:3000/api/files/1
```

> 보안: `tg_file_id`, `tg_message_id`, `tg_chat_id`, 그리고 봇 토큰이 포함된 `file_path` URL은
> **어떤 API 응답에도 노출되지 않습니다.** 다운로드는 서버가 Telegram에서 직접 조립해 스트리밍합니다.

## 테스트 / 검증

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest — mock Telegram 왕복 무결성, checksum 불일치 감지,
                    # 파트 순서, 업로드 실패 롤백, 큐 동작(직렬화/백오프)
```

스모크 테스트 (토큰 없으면 mock, 있으면 실전):

```bash
npm run smoke                       # mock: 32MB 랜덤 파일 왕복 sha256 검증
SMOKE_FILE_SIZE_MB=120 npm run smoke # 100MB+ 검증 (8개 파트)
```

실전 검증: `.env`에 `TELEGRAM_BOT_TOKEN` + `STORAGE_CHAT_ID`를 넣고 `npm run smoke` 실행.
(실전 기본 8MB, `SMOKE_FILE_SIZE_MB`로 조절)

## 프로젝트 구조

```
src/
  index.ts        서버 엔트리 (env → deps 조립 → serve)
  app.ts          Hono 앱 팩토리 (에러/로깅/라우팅 — 테스트에서 주입)
  config.ts       env 로딩 (.env 자동 로드, CHUNK_SIZE=15MB 고정)
  db.ts           SQLite 스키마 + 마이그레이션(user_version) + 리포지토리
  queue.ts        속도제한 큐 (직렬 + 최소 간격 + 429 retry_after + 지수 백오프)
  multipart.ts    busboy 기반 스트리밍 multipart 파서 (메모리 안전)
  upload.ts       업로드 파이프라인 (스풀 → 분할 → 전송 → 원자 커밋)
  download.ts     다운로드 파이프라인 (part_index 정렬 → 검증 → 스트리밍)
  tg/
    types.ts      TgClient 인터페이스
    grammy.ts     grammY 실전 구현 (throttler + autoRetry)
    mock.ts       로컬 파일 mock (토큰 불필요, 실패 주입 지원)
  routes/files.ts REST 라우트
scripts/
  smoke.ts        왕복 무결성 스모크 (mock/실전)
  chatid.ts       chat id 확인 헬퍼
test/             vitest 테스트
```

## 알려진 동작 / 주의사항

- 업로드 실패 시 DB에는 아무것도 커밋되지 않지만, **이미 전송된 Telegram 메시지는 고아로 남습니다** (저장소 무제한 전제의 설계상 허용).
- `file_id`는 봇 계정 종속·비영구이므로 parts에 `tg_chat_id` + `tg_message_id` + `tg_file_id`를 모두 저장합니다.
- 텔레그램 약관상 **전용 비공개 채널** 사용을 전제로 합니다 (팀 그룹/공개 채널 금지).

## 다음 마일스톤 (범위 외)

- M3: users / folders / permissions + 인증
- M4: 웹 UI
- M5: 캐시 계층, 동시성 점검
