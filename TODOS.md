# TODOS.md — 남은 할 일

> 진행 현황: M1+M2(분할 저장) · M3(인증/폴더/권한) · M4(웹 UI) · **M5(폴리싱/보안/기능) 구현 완료**.
> i18n(ko/en/ja) + 설정 모달 + Taskfile.yaml + 검색/이동/다중업로드/통계/세션 무효화/rate limit/캐시 반영.
> 테스트 88개 · typecheck · 웹 빌드 전부 통과.

---

## 🔴 크레덴셜 필요 (사용자 직접 실행 필요 — 코드로 해결 불가)

- [ ] **실전(REAL) 스모크 검증**: `.env`에 `TELEGRAM_BOT_TOKEN` + `STORAGE_CHAT_ID` + `DEV_AUTH=true` 넣고 `npm run smoke` → 실제 봇/채널로 왕복 무결성 확인
- [ ] **실제 팀원 로그인 테스트**: HTTPS 도메인 + @BotFather `/setdomain` 등록 후 텔레그램 위젯 로그인 (절차는 `docs/DEPLOY.md`)
- [ ] **배포 실행**: `docs/DEPLOY.md` 따라 리버스 프록시(Caddy/Nginx) + systemd + `SESSION_SECRET` 고정 + `DEV_AUTH=false` + `COOKIE_SECURE=true`

## 🟡 선택 개선 (구현 완료된 항목의 후속)

- [ ] **파일 복사** (파트 공유 방식 — 삭제/무결성 시맨틱 설계 필요, 미구현 상태로 TODO 유지)
- [ ] **캐시 실측 검증**: `CACHE_DIR` 활성 후 큰 파일 반복 다운로드 지연 개선 확인
- [ ] **rate limit 영속화**: 현재 인메모리(프로세스 재시작 시 리셋, 단일 노드 전제) — 멀티 노드 배포 시 Redis 등 공유 저장소 고려
- [ ] **로그인 429 UX**: 프론트에서 Retry-After 기반 카운트다운 표시 (현재는 서버 429 메시지 그대로 토스트)

## 🔵 문서/유지보수

- [ ] `docs/plan.md`의 M5 체크리스트 최종 확인
- [ ] 스크린샷/사용 가이드 (팀원 온보딩용) 작성
- [ ] 릴리스 태그 (v0.1.0) + CHANGELOG 정리

---

## 참고: 완료된 것

- ✅ M1+M2: 15MB 청크 업로드/다운로드, sha256 checksum, 속도제한 큐, mock 클라이언트 검증
- ✅ M3: 텔레그램 로그인 위젯, httpOnly 세션 쿠키, 사용자/폴더 CRUD, 권한 부여/회수/상속
- ✅ M4: React SPA — 폴더 트리/파일 목록/업로드 진행률/다운로드/삭제/권한 관리/로그인
- ✅ i18n: ko/en/ja, localStorage 영속화, 로그인 페이지 포함 전체 적용
- ✅ 설정: topbar ⚙️ → 설정 모달 (언어 선택 + 저장소 사용량)
- ✅ Taskfile.yaml
- ✅ M5 백엔드: 세션 무효화(sess_version), 로그인 rate limit, 파일 검색 API, 파일 이동 API, 스토리지 통계 API, 다운로드 디스크 캐시(opt-in), 요청 로깅, 동시성 테스트
- ✅ M5 프론트: 검색 UI(디바운스+folderPath), 파일 이동 모달, 다중 업로드+드래그앤드롭(순차 큐/진행률/취소), 설정에 저장소 사용량
- ✅ 문서: docs/DEPLOY.md, README, plan.md, .env.example 갱신
