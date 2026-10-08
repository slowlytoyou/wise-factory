# Supabase 클라우드 설정

**이 문서는 클라우드 저장·공식 순위를 선택할 때만 필요합니다.** 개인 로컬 플레이는 `npm start` 또는 `npm run local`로 바로 실행하며 로그인·인터넷·Supabase 설정이 필요 없습니다. 채굴·상점·레이더·전송기·환생을 모두 이용할 수 있습니다. 개인 플레이의 `L`은 내 공장 기록을 표시합니다.

공개 저장소에는 실제 서버 주소·키·로그인 세션이 포함되지 않습니다. 공유 서버를 사용하는 플레이어는 운영자에게 받은 **프로젝트 URL과 publishable key**를 4절에 입력하면 됩니다. 직접 서버를 운영하려면 아래 순서대로 Supabase 프로젝트, OAuth, DB와 Edge Functions를 설정하세요. 같은 프로젝트를 사용하는 플레이어끼리 순위를 공유합니다.

## 1. Supabase 프로젝트 준비

[Supabase Dashboard](https://supabase.com/dashboard)에서 프로젝트를 만들고 프로젝트 URL, 프로젝트 식별자(`PROJECT_REF`), publishable key를 확인합니다. 아래 예제의 `PROJECT_REF`는 모두 본인의 프로젝트 식별자로 바꿉니다. 요금제와 리전은 운영 환경에 맞게 선택하세요.

클라이언트에는 공개 키만 사용합니다. `sb_secret_...`, `service_role`, DB 비밀번호, OAuth Client Secret은 게임 설정에 넣지 않습니다. 게임은 관리자 키가 설정되면 실행을 거부합니다. [공식 API 키 안내](https://supabase.com/docs/guides/getting-started/api-keys)

## 2. GitHub 또는 Google 회원가입 연결

처음 소셜 로그인하면 Supabase Auth 계정이 생성되고, 처음 클라우드 공장에 접속하면 기본 닉네임과 새 공장이 생성됩니다. 별도 비밀번호나 이메일 발송 서비스를 준비할 필요가 없습니다. 사용할 공급자만 활성화하면 됩니다.

프로젝트 Dashboard의 Authentication에서 사용할 OAuth 제공자를 활성화합니다. GitHub 또는 Google 중 설정한 공급자로만 로그인할 수 있습니다.

GitHub 기준:

1. GitHub Settings → Developer settings → OAuth Apps에서 앱을 만듭니다.
2. Homepage URL에는 게임의 안내 페이지를 입력합니다. 로컬 개발 중에는 `http://127.0.0.1:53682`를 사용할 수 있습니다.
3. **Authorization callback URL**에는 `https://PROJECT_REF.supabase.co/auth/v1/callback`을 입력합니다. 별도 프로젝트를 사용한다면 해당 프로젝트 주소로 바꿉니다.
4. 발급받은 Client ID와 Client Secret을 **Supabase Dashboard → Authentication → Sign In / Providers → GitHub**에 입력하고 활성화합니다. Secret은 게임 저장소에 넣지 않습니다.

[GitHub 공식 연결 절차](https://supabase.com/docs/guides/auth/social-login/auth-github). Google을 선택하면 Google Cloud OAuth 웹 클라이언트를 만들고 같은 Supabase callback URL을 등록한 뒤 Supabase의 Google 공급자를 활성화합니다. Google 앱이 테스트 모드라면 플레이할 계정을 테스트 사용자에 추가합니다. [Google 공식 연결 절차](https://supabase.com/docs/guides/auth/social-login/auth-google)

Supabase **Authentication → URL Configuration**을 다음과 같이 설정합니다.

| 설정 | 값 |
| --- | --- |
| Site URL | `http://127.0.0.1:53682` |
| Redirect URLs | `http://127.0.0.1:53682/auth/callback/*` |

GitHub/Google에 등록하는 callback은 **Supabase HTTPS 주소**, Supabase에 등록하는 Redirect URL은 **내 기기의 loopback 주소**입니다. 게임은 `127.0.0.1`에만 임시 서버를 열고, 로그인마다 다른 무작위 callback 경로와 PKCE S256 검증자를 사용합니다. 위의 마지막 `*`는 무작위 경로 한 칸을 허용하기 위해 필요합니다. [Redirect URL 문서](https://supabase.com/docs/guides/auth/redirect-urls) · [PKCE 문서](https://supabase.com/docs/guides/auth/sessions/pkce-flow)

로그인은 게임을 실행한 컴퓨터의 브라우저에서 완료하세요. 기본 포트를 다른 프로그램이 사용하면 `config/cloud.json`의 `port`를 바꾸고 위의 두 URL에도 같은 포트를 적용합니다. 환경 변수 `STARFALL_AUTH_PORT`도 지원합니다. 원격 SSH 호스트에서 실행하는 경우 기본 구성의 브라우저 loopback이 해당 호스트에 도달하지 않으므로, 우선 로컬 터미널에서 로그인하는 구성을 권장합니다.

## 3. DB와 서버 함수 배포

서버 운영자가 한 번 수행하는 단계입니다. 공유 서버에 접속만 하는 플레이어는 4절로 이동합니다. Node.js 20 이상이 필요하고, `npx`는 Supabase CLI를 실행할 때만 내려받습니다. 게임 실행에 npm 라이브러리를 추가하지 않습니다. [Supabase CLI 안내](https://supabase.com/docs/guides/local-development/cli/getting-started)

저장소 최상위 디렉터리에서 실행합니다. `PROJECT_REF`를 본인 프로젝트 식별자로 바꿉니다.

```sh
npx supabase@latest login
npx supabase@latest link --project-ref PROJECT_REF
npx supabase@latest db push
npx supabase@latest functions deploy factory-sync --project-ref PROJECT_REF
npx supabase@latest functions deploy factory-leaderboard --project-ref PROJECT_REF
```

이미 `supabase/config.toml`이 있으므로 `supabase init`은 필요하지 않습니다. 마이그레이션은 공장·요청·요청 제한·월별 점수 테이블과 서버 전용 RPC를 만듭니다. 사용자 테이블은 모두 RLS가 켜지고, `anon`·`authenticated`의 테이블 접근 및 RPC 실행 권한이 제거됩니다. 함수 내부의 서버 자격 증명으로만 공장 상태와 순위를 기록합니다.

저장 시각이 과거로 되돌아가지 않도록 서버에서 검사하며, 중복 요청은 요청 ID와 revision으로 구분합니다.

서버는 Supabase가 제공하는 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`를 사용합니다. 기존 `SUPABASE_ANON_KEY`·`SUPABASE_SERVICE_ROLE_KEY`도 지원합니다. 일반적인 호스팅 프로젝트에서는 별도 비밀 키를 코드에 적을 필요가 없습니다. 환경 변수가 없는 자체 호스팅 구성이라면 서버 환경에만 키를 설정하세요. [Edge 환경 변수 안내](https://supabase.com/docs/guides/functions/secrets)

`supabase/config.toml`의 두 함수는 `verify_jwt = false`입니다. 각 함수가 받은 `Authorization: Bearer <사용자 토큰>`을 **Auth `/auth/v1/user`에 조회해 직접 검증**하므로, 공개 키만 가진 요청이나 위조 JWT는 거부됩니다. 게이트웨이의 레거시 키 검사에 의존하지 않으며, 사용자 ID를 클라이언트가 지정할 수도 없습니다. 이 인증 검사를 제거하면 안 됩니다. [Auth 서버를 통한 JWT 검증](https://supabase.com/docs/guides/auth/jwts)

## 4. 게임에 공개 설정 입력

`config/cloud.example.json`을 복사하고 운영자에게 받은 설정 또는 직접 만든 프로젝트의 설정을 입력합니다. 이미 `config/cloud.json`이 있다면 복사로 덮어쓰지 말고 기존 파일을 편집하세요.

```sh
cp config/cloud.example.json config/cloud.json
```

`config/cloud.json`을 열어 URL과 공개 키를 채웁니다.

```json
{
  "url": "https://PROJECT_REF.supabase.co",
  "publishableKey": "sb_publishable_여기에_실제_공개_키",
  "port": 53682
}
```

환경 변수를 선호하면 다음 값을 설정할 수 있습니다. 환경 변수가 파일보다 우선합니다. `.env` 파일을 자동으로 읽지는 않습니다.

```sh
export SUPABASE_URL='https://PROJECT_REF.supabase.co'
export SUPABASE_PUBLISHABLE_KEY='sb_publishable_실제_공개_키'
```

로그인 제공자와 리다이렉트 URL 설정을 마친 뒤 실행합니다.

```sh
npm start -- --login github
npm start -- --cloud --nickname 'WISE FACTORY'
```

Google을 활성화했다면 `--login google`을 사용합니다. 선택한 공급자가 활성화된 경우에만 로그인 URL을 표시하고 기본 브라우저를 엽니다. 비활성 상태라면 브라우저·임시 로그인 서버를 열지 않고 `npm start` 개인 플레이를 안내합니다. 첫 닉네임은 임시 값이며, `--nickname`으로 변경할 수 있습니다. 닉네임은 2~20자이고 문자·숫자·공백·`_`·`-`를 허용합니다. 닉네임은 다른 플레이어에게 공개되며 중복 사용이 가능합니다.

플레이 중 `L`로 상위 10명과 내 순위, `--leaderboard`로 상위 20명을 확인합니다. 점수는 서버가 확인한 **이번 달 판매 금액**이며, **초당 평균 골드 = 해당 월 판매액 ÷ 서버가 생산에 반영한 시간(초)**입니다. 한국 시간 **매월 1일 00:00**에 새 월의 점수로 자동 전환하며 공장·보유 골드·OH 코어는 유지합니다. 열린 순위 화면도 월 전환 시 자동 갱신합니다. 오프라인 플레이어의 순위는 다음 동기화 때 갱신됩니다. 이메일·토큰·다른 사용자의 공장 배치는 순위 응답에 포함하지 않습니다.

```sh
npm start -- --leaderboard
npm start -- --logout
```

로그인 토큰은 사용자 홈의 `~/.config/starfall-idle/cloud/<프로젝트 해시>.json`에 저장되고 파일 권한은 `0600`입니다. 프로젝트별 세션을 분리하고 갱신 토큰을 자동 갱신합니다. 이는 OS 계정의 파일 권한으로 보호하는 저장이며 Keychain 암호화는 아닙니다. `--logout`은 이 기기의 세션을 해제하고 파일을 삭제합니다. 네트워크 오류가 있어도 로컬 로그인 정보는 삭제되며 서버 세션 해제 여부를 안내합니다.

## 저장과 충돌 처리

- 클라우드 공장은 서버에서 새로 시작합니다. 로컬 저장 파일이나 데모의 재화·배치는 가져오지 않습니다.
- 건설·회전·강화·조합 변경 등은 서버가 비용과 조건을 검사합니다. 화면은 즉시 예측해서 표시하고 서버의 결과로 맞춥니다.
- 상점 구매와 환생도 명령만 전송합니다. 설계도·레이더 가격, 전송기 재고, 환생 자격과 코어 수는 서버가 계산합니다. 환생 후에도 월간 판매액과 전체 누적 판매액은 유지됩니다. 월간 순위는 공장 상태와 분리된 월별 집계 테이블을 사용합니다.
- 저장 형식은 v3, 콘텐츠 버전은 2이며 기존 v2 공장은 다음 동기화 때 이관됩니다. 원목·석영·금은 새 레이더로 해금하며 기존 광맥과 건설 배치는 유지합니다. 구형 v2 저장에 성장 정보가 없으면 기존 설비와 광맥을 유지하도록 해금하고, 새 공장과 환생 후에는 설계도·레이더를 구매해야 합니다. 구버전 클라이언트도 최신 게임 코드로 업데이트하세요.
- DB는 저장 형식 또는 콘텐츠 버전을 낮추는 커밋을 거부합니다. 월별 집계를 누락하는 구형 서버의 저장도 거부합니다. 배포 도중 실행 중인 구형 서버 요청도 새 저장을 덮어쓰지 못합니다. 지원하지 않는 진행 형식을 읽으면 서버는 저장을 보존하고 `426 update_required`를 반환합니다.
- 플레이 중에는 작업을 모아 최소 0.6초 간격으로 동기화하고, 작업이 없으면 60초마다 동기화합니다. 정상 종료 시 진행 중 요청과 남은 작업을 확인합니다. 요청 제한은 서버의 `Retry-After` 동안 대기한 뒤 자동 재시도합니다.
- 서버가 마지막으로 저장한 시각부터 경과 시간을 계산하며 한 번에 최대 8시간을 인정합니다. 오래 접속하지 않았다면 최근 8시간을 반영하고, 월 경계에서는 판매액과 반영 시간을 각 달에 나누어 기록합니다. 게임을 닫아 둔 동안 서버가 매초 실행되는 구조는 아닙니다.
- 클라우드 모드의 `P`는 화면 정지입니다. 서버 시간에 따른 생산은 계속됩니다.
- 서버 revision과 DB 행 잠금으로 동시에 두 기기가 수정할 때 한 요청만 반영합니다. 오래된 revision은 최신 공장과 함께 `409`로 응답합니다.
- 같은 request ID와 같은 내용의 재전송은 결제나 환생 보상을 반복하지 않습니다. 다른 내용으로 ID를 재사용하면 거부합니다. 요청 영수증은 7일간 보관하고, 더 오래된 작업도 revision 검사로 재적용을 방지합니다.
- 연결이 끊기면 클라우드 건설을 중지합니다. 연결 문제로 반영 여부를 모르는 요청은 같은 ID로 재확인합니다. 로컬 게임을 하려면 클라우드 모드를 종료하고 `npm start`로 시작합니다.

## 월간 순위 집계

`factory_monthly_scores`는 사용자·한국 시간 월별로 판매액과 생산 반영 시간을 저장합니다. 서버가 시간을 기준으로 이번 달만 조회하므로 월초마다 별도 cron이나 전체 공장 초기화를 실행할 필요가 없습니다. 지난달 기록은 보관되지만 이번 달 점수에는 합산하지 않습니다. 동기화 시 공장 저장·월별 증분·요청 영수증을 한 트랜잭션에서 커밋하므로 재전송이나 기기 간 충돌이 점수를 중복 지급하지 않습니다.

새 프로젝트는 빈 월간 집계로 시작합니다. 이미 운영 중인 구버전 프로젝트에 적용할 때는 주의가 필요합니다. 월간 마이그레이션의 초기 이관은 이번 달에 저장된 공장의 누적 판매액과 `elapsed`를 이번 달 기록으로 추정합니다. 이전 달부터 플레이한 공장이 있다면 기존 저장에는 월별 내역이 없으므로, 적용 전에 이관 쿼리를 운영 데이터에 맞게 조정해야 합니다.

`scripts/monthly-leaderboard-check.sql`은 임시 데이터와 함께 전체 롤백하는 DB 검증입니다. SQL Editor에서 실행하면 한국 시간 월초·연말·윤년 경계, 점수·평균, 중복 요청·충돌, 버전 보호, 접근 권한을 검사합니다. 개발용 프로젝트에서 먼저 실행하세요.

## 무료 사용량

무료 요금제에도 DB·트래픽·사용자·함수 호출 한도가 있습니다. 최신 제공량과 비활성 프로젝트 정책은 [공식 요금표](https://supabase.com/pricing)를 확인하세요.

회원 수 한도보다 **함수 호출·데이터 전송량**이 먼저 제한이 될 수 있습니다. 예를 들어 한 사람이 30일 내내 게임을 켜 놓고 60초마다 동기화하면 기본 저장만 약 **43,200회/월**입니다. 건설·로그인·순위 조회와 재시도는 별도이고, 공장 크기에 따라 전송량도 증가합니다. 소수 테스터로 시작해서 Dashboard Usage에서 확인하세요. 접속하지 않은 플레이어는 주기적인 함수 호출을 발생시키지 않습니다. 이 구현에는 상시 서버, Realtime 구독, cron 작업이 필요하지 않습니다.

서버는 인증 사용자마다 분당 동기화 120회, 순위 조회 30회, 요청당 작업 32개·JSON 16 KiB 제한을 둡니다. 초과하면 `429` 또는 `413`을 반환합니다. 이 제한은 무제한 무료 사용을 보장하지 않으며, 공개 출시 전 사용량과 실제 배치의 성능을 확인해야 합니다.

## 배포 확인

```sh
npm test
npm run test:pty
npm run test:cloud-pty
```

자동 테스트는 가짜 인증 응답과 임시 저장 파일을 사용하며 실제 Supabase 계정이나 외부 서버에 접속하지 않습니다. PTY 테스트에는 Python 3과 macOS/Linux가 필요합니다. 서버를 배포한 뒤에는 로그인·저장·리더보드 조회를 직접 확인하세요.

DB Advisor의 INFO 항목 `RLS Enabled No Policy`는 이 설계에서 의도한 상태입니다. 게임 클라이언트가 테이블에 직접 접근하지 않고 인증을 확인한 Edge Function만 서버 자격 증명으로 접근하므로, 사용자용 RLS 정책을 만들지 않았습니다. 이 INFO를 없애기 위해 RLS를 끄거나 사용자 쓰기 정책을 추가하지 마세요. [공식 진단 설명](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)

운영 서버의 확인 순서:

1. 로그인 후 새 공장이 생성되고 채굴→판매 금액이 증가하는지 확인합니다. 첫 동기화 이후 Dashboard의 `factory_states`에 계정당 한 행이 생겨야 합니다.
2. 설비를 설치한 뒤 정상 종료하고, 다른 컴퓨터에서 같은 공급자의 같은 계정으로 로그인해 배치와 닉네임을 확인합니다.
3. 게임을 닫아 두었다가 다시 열어 보상이 생기는지 확인합니다. PC 시계를 바꾸거나 로컬 캐시의 코인을 수정해도 서버 점수에는 반영되지 않아야 합니다.
4. 두 기기에서 동시에 공장을 수정해 `409` 재동기화가 발생하고 돈이 중복 지출되지 않는지 확인합니다. 연결을 끊었다가 다시 연결했을 때 미확인 요청이 한 번만 반영되는지도 확인합니다.
5. 다른 계정으로 로그인해 독립된 공장과 각자 순위를 확인합니다. 순위 항목에는 닉네임·월간 점수·초당 평균 골드·순위만, 시즌 정보에는 월·시간대·다음 초기화 시각만 있어야 합니다.
6. 로그인한 사용자의 JWT로 `factory_states`를 직접 수정하거나 `factory_commit_monthly` RPC를 실행하는 요청도 권한 오류인지 확인합니다. 미인증·위조 JWT 요청도 거부되는지 확인합니다.

SQL Editor에서 다음 쿼리의 모든 값이 `false`인지 확인할 수 있습니다. 이는 권한을 변경하지 않는 점검입니다.

```sql
select
  has_table_privilege('anon', 'public.factory_states', 'SELECT,INSERT,UPDATE,DELETE') as anon_table_access,
  has_table_privilege('authenticated', 'public.factory_states', 'SELECT,INSERT,UPDATE,DELETE') as user_table_access,
  has_function_privilege('authenticated',
    'public.factory_commit_monthly(uuid,bigint,uuid,text,jsonb,numeric,text,jsonb,numeric,numeric,jsonb)',
    'EXECUTE') as user_can_commit;
```

문제 해결:

| 증상 | 확인할 항목 |
| --- | --- |
| 로그인 후 터미널로 돌아오지 않음 | 두 종류의 callback URL, `127.0.0.1` 표기, 포트, 마지막 `*` 확인 |
| `Unsupported provider: provider is not enabled` / 공급자 비활성 | 개인 플레이는 `npm start`로 바로 실행. 클라우드를 선택할 때만 Provider 설정과 OAuth 앱 Client ID/Secret 확인 |
| `server_not_configured` | Edge 환경 변수의 공개/서버 키 확인 |
| `database_unavailable` | DB 마이그레이션 적용, 서버 키, Data API의 public schema 노출 확인 |
| `401` | 다시 로그인, 프로젝트 URL·공개 키가 같은 프로젝트인지 확인 |
| `429` | 안내된 대기 후 자동 재시도. 여러 창에서 같은 계정을 빠르게 조작하고 있지 않은지 확인 |
| `426 update_required` | 저장을 지우지 말고 클라이언트와 두 Edge 함수를 같은 최신 버전으로 업데이트 |
| 무료 프로젝트가 중지됨 | Supabase Dashboard에서 프로젝트 상태 확인 후 재개 |

시뮬레이션 규칙을 바꿀 때는 클라이언트와 두 Edge Function을 함께 업데이트하세요. 서버와 클라이언트는 동일한 `supabase/functions/_shared/factory.mjs`를 사용합니다.
