# Telegram Storage — 설계 노트 (M1+M2)

> 원본 계획서: [plan.md](./plan.md)
> 이 문서는 분석 후 확정된 설계 결정을 기록한 핸드오프 문서. M3/M4 구현 시 이 문서를 기준으로 이어간다.

## 확정된 결정 (2025-08 기준 검증)

| 항목 | 결정 | 근거 |
|---|---|---|
| 백엔드 | **Hono + TypeScript** (Node 24) | 사용자 요구. Hono는 추후 Cloudflare Workers로 이식 가능 |
| DB | **SQLite** (better-sqlite3 또는 node:sqlite) | 20명 규모에 충분, 디버깅 쉬움, WAL 모드 |
| Telegram 클라이언트 | **grammY** + throttler 플러그인 | 429(flood control) 대응·재시도 내장 |
| 청크 크기 | **15MB 고정** | 공개 Bot API: 업로드 50MB / 다운로드 20MB → 양쪽 여유 있음 |
| 저장 채팅 | **전용 비공개 채널/그룹** (팀 그룹 금지) | 그룹 rate limit 20msg/min vs 개인 ~1msg/sec → 2GB(134청크)가 2.3분 vs 6.7분, 채팅 오염 방지. chat id는 `.env` 주입 |
| 무결성 | parts에 **sha256 checksum** 기록 + 다운로드 시 검증 | 전송 손상 감지 |
| file_id 수명 | parts에 **tg_chat_id + tg_message_id + tg_file_id** 모두 저장 | file_id는 봇 계정 종속·비영구 → 메시지 기반 복구 경로 확보 |
| 보안 | **서버만** getFile → 스트리밍 프록시. file_path URL(봇 토큰 포함)·file_id를 API 응답에 노출 금지 | 권한 우회/토큰 유출 방지 |
| 업로드 경로 | 요청 본문 → 임시 디스크 스트리밍 → 15MB 분할 → sendDocument → 전부 성공 후 files 커밋 → 정리 | 메모리 폭발 방지 |

## 스키마 (이번 범위: files, parts만)

```sql
files(
  id, name, size, mime, folder_id NULL, owner_id NULL,
  created_at, updated_at
)
parts(
  id, file_id FK, part_index, offset, part_size,
  tg_message_id, tg_chat_id, tg_file_id, checksum
)
```
- users / folders / permissions 는 **M3** 범위 (plan 스키마 참고, 지금 구현하지 않음)

## API

- `POST /api/files` — multipart 업로드 → 분할 → Telegram 저장 → 메타데이터 기록
- `GET /api/files` — 목록
- `GET /api/files/:id/download` — 권한 없음 단계(미인증), 파트 정렬 → 재조립 → checksum 검증 → 스트리밍
- `DELETE /api/files/:id` — 논리 삭제(Telegram 메시지 삭제는 선택)

## 검증 기준 (M1+M2 완료 조건)

1. `npm run test` 통과 — mock Telegram 클라이언트로 >15MB 파일 왕복 무결성
2. `tsc --noEmit` 통과
3. checksum 불일치 감지 / 파트 순서 보존 / 큐 동작 테스트
4. 실제 봇 토큰 없이 전체 동작 + 토큰 주입 시 실전 스모크 검증만 남음

## 다음 마일스톤 (이번 범위 아님)

- M3: users/folders/permissions + 인증 (텔레그램 로그인 위젯 vs 초대 코드+JWT — 미확정)
- M4: 웹 UI (React)
- M5: 캐시 계층, 동시성 점검

---

## M3 확정 (2025-08, 구현 완료)

| 항목 | 결정 |
|---|---|
| 인증 | **텔레그램 로그인 위젯** — `secret_key = SHA256(봇 토큰)`, `data_check_string` 정렬 후 `\n` 연결, `HMAC-SHA256` hex 비교 + `auth_date` 24h 이내. 검증은 순수 함수 `verifyTelegramAuth`로 분리 (known test vector) |
| 세션 | httpOnly + SameSite=Lax 쿠키 `tg_session`, HMAC 서명 페이로드 `{uid, exp}` (7일). `SESSION_SECRET` env, 미설정 시 임시 키(재시작 시 세션 소멸) |
| 개발 우회 | `DEV_AUTH=true` 시 `POST /api/auth/dev-login` (username → 세션). 실전 모드에선 위젯 검증만 통과 |
| users | id, telegram_id(unique, nullable), username, display_name, role('admin'\|'member'), created_at. **첫 로그인 사용자가 admin** (bootstrap) |
| folders | id, name, parent_id(자기참조 FK, CASCADE), owner_id(FK users), created_at. 순환/중복 이름/부모 존재 검증 |
| permissions | id, scope('user'\|'group' — group은 스키마 정의만), scope_id, folder_id, role('read'\|'write'\|'admin'), UNIQUE(scope, scope_id, folder_id) |
| 권한 해석 | 직접 행 → 조상 체인에서 가장 가까운 행 상속 → 기본 `read` (member 전체 읽기 허용). 소유자/전역 admin = 항상 admin. 루트(folder_id NULL) = member 기본 `write` |
| 파일 | files.folder_id/owner_id 기록. 다운로드 ≥ read, 업로드/삭제 ≥ write (소속 폴더 기준) |

### M3 API (간략)

- `POST /api/auth/telegram` (위젯 form data) · `POST /api/auth/dev-login` · `GET /api/auth/me` · `POST /api/auth/logout`
- `GET|POST /api/folders` · `PATCH|DELETE /api/folders/:id` · `GET|POST /api/folders/:id/permissions` · `DELETE /api/folders/:id/permissions?userId=`
- 기존 파일 라우트에 인증 + 권한 + `folder_id`(multipart 필드 / query) 적용

상세 스펙/응답 형태는 README의 API 섹션 참고 (M4 UI 구현 기준).

## 다음 마일스톤 (이번 범위 아님)

- M4: 웹 UI (React) — README의 API 스펙 기준으로 제작
- M5: 캐시 계층, 동시성 점검
