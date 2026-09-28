// UI copy for the bot's own pages. Locales mirror the main ghfind site so a
// visitor arriving from ghfind.com/<locale>/github-bot keeps their language.
export const LOCALES = ["en", "zh", "ja", "ko", "es", "pt", "id", "vi", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  pt: "Português",
  id: "Bahasa Indonesia",
  vi: "Tiếng Việt",
  ar: "العربية",
};
export const LOCALE_COOKIE = "ghfind_bot_lang";

const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (LOCALES as readonly string[]).includes(value);

/** ?lang= wins, then the saved cookie, then Accept-Language, then English. */
export function pickLocale(request: Request, url: URL): Locale {
  const query = url.searchParams.get("lang");
  if (isLocale(query)) return query;
  const saved = request.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
  if (isLocale(saved)) return saved;
  for (const part of (request.headers.get("accept-language") ?? "").split(",")) {
    const base = part.trim().split(";")[0].split("-")[0].toLowerCase();
    if (isLocale(base)) return base;
  }
  return "en";
}

export function format(text: string, values: Record<string, string>) {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

type Pair = { title: string; body: string };
export type Messages = {
  nav: { site: string; language: string; theme: string; auto: string; light: string; dark: string };
  footer: { source: string; privacy: string; emails: string };
  home: {
    eyebrow: string;
    title: string;
    subtitle: string;
    install: string;
    notOpen: string;
    learnMore: string;
    rollout: string;
    labelsHeading: string;
    labelsLead: string;
    ranges: { low: string; medium: string; high: string; top: string; noScore: string };
    labelsNote: string;
    stepsHeading: string;
    steps: { install: Pair; open: Pair; label: Pair };
    permissions: Pair;
    emails: Pair & { link: string };
    migrate: Pair;
  };
  privacy: { title: string; paragraphs: string[] };
  unsubscribe: { title: string; button: string; doneTitle: string; doneBody: string };
  notifications: {
    disabledTitle: string;
    disabledBody: string;
    title: string;
    body: string;
    authNote: string;
    signIn: string;
    needAuthTitle: string;
    needAuthBody: string;
    signInAgain: string;
    noEmailTitle: string;
    noEmailBody: string;
    prefsTitle: string;
    subscribed: string;
    notSubscribed: string;
    prefsBody: string;
    emailLanguage: string;
    consent: string;
    save: string;
    unsubscribe: string;
  };
  setup: {
    title: string;
    openFromGitHub: string;
    receivedTitle: string;
    receivedBody: string;
    signIn: string;
    refresh: string;
    repository: string;
    task: string;
    status: string;
    action: string;
    empty: string;
    retry: string;
    kinds: { discover: string; initialize: string; label: string };
    states: { pending: string; running: string; done: string; failed: string; cancelled: string };
  };
};

const en: Messages = {
  nav: { site: "ghfind.com", language: "Language", theme: "Theme", auto: "Auto", light: "Light", dark: "Dark" },
  footer: { source: "Source & support", privacy: "Privacy", emails: "Author emails" },
  home: {
    eyebrow: "GitHub App · Free",
    title: "Triage issues and PRs by who opened them",
    subtitle:
      "ghfind Review adds a colour-coded review: label to every new issue and pull request, based on the author's public ghfind score. No workflow, no token, no secret to configure.",
    install: "Install on GitHub",
    notOpen: "Installation is not open yet.",
    learnMore: "Learn more on ghfind.com",
    rollout: "Current rollout: {accounts}",
    labelsHeading: "Five labels, one glance",
    labelsLead: "Missing labels are created on install. Colours or descriptions you have customised are kept.",
    ranges: { low: "0 – 39", medium: "40 – 69", high: "70 – 89", top: "90 – 100", noScore: "No score" },
    labelsNote:
      "The score describes the author's public GitHub profile. It is not a code review or a merge decision, and no-score is not zero.",
    stepsHeading: "How it works",
    steps: {
      install: {
        title: "Install on selected repositories",
        body: "Grant Issues and Pull requests read & write. Choose Only select repositories to start small.",
      },
      open: {
        title: "Someone opens an issue or PR",
        body: "The bot looks up the author's public ghfind score in the background. The issue body is never read or scored.",
      },
      label: {
        title: "A review: label appears",
        body: "It only adds labels — it never comments on, closes or blocks a submission.",
      },
    },
    permissions: {
      title: "Permissions & data",
      body: "No source files, no issue bodies, no pull request code. Only installation, repository, issue number, score and task state are kept; finished tasks are purged after 30 days.",
    },
    emails: {
      title: "Author score emails",
      body: "Authors with a public GitHub email may get one score email per 72 hours across repositories, with one-click unsubscribe.",
      link: "Manage email preferences",
    },
    migrate: {
      title: "Switching from the Actions workflow?",
      body: "Disable the old PR review level workflow so the two don't label the same submission twice.",
    },
  },
  privacy: {
    title: "Privacy",
    paragraphs: [
      "GitHub sends installation, issue, pull request and issue comment events. We verify each event and keep only installation and repository IDs, repository names, issue or pull request numbers, scores and task status. Comment text is only checked for a mention of this App and is never stored.",
      "The author's login is sent to ghfind to retrieve a public-profile score. Issue and pull request text and code are never stored or sent for scoring. The App only writes labels; it does not post comments.",
      "Completed task records expire after 30 days. Failed task records remain until an operator resolves them. Dashboard sessions expire after one hour, and GitHub user tokens are encrypted at rest. Uninstalling the App stops repository access and leaves existing labels in place.",
      "Author score emails are sent by default when a current public GitHub profile email is available. Commit emails are never used. Authors may instead authorise their verified primary email. Addresses are encrypted at rest and email records are kept for 30 days. Unsubscribing removes the stored address, cancels pending mail and keeps the GitHub user ID as a lasting opt-out; a send already in progress may still arrive. Messages whose delivery is uncertain are not resent automatically.",
      "For deletion requests, contact the maintainers through the source repository.",
    ],
  },
  unsubscribe: {
    title: "Unsubscribe",
    button: "Stop author emails",
    doneTitle: "Unsubscribed",
    doneBody: "Your email subscription has been removed.",
  },
  notifications: {
    disabledTitle: "Author emails",
    disabledBody: "Email notifications are not enabled yet.",
    title: "Your ghfind score, in your inbox",
    body: "Authors with a public GitHub profile email receive score notifications by default until they unsubscribe — at most one every 72 hours across repositories. Sign in to use your verified email instead or to manage preferences.",
    authNote: "GitHub authorisation only reads your verified primary email. Signing in alone does not subscribe you.",
    signIn: "Sign in with GitHub",
    needAuthTitle: "Email authorisation needed",
    needAuthBody: "Authorise Email addresses: read for ghfind Review, then sign in again.",
    signInAgain: "Sign in again",
    noEmailTitle: "No verified primary email",
    noEmailBody: "Verify your primary email in GitHub settings and try again.",
    prefsTitle: "Author email preferences",
    subscribed: "Subscribed",
    notSubscribed: "Not subscribed",
    prefsBody:
      "Receive your public-profile score and ghfind ranking for new issues and PRs. This is not an estimate of review time.",
    emailLanguage: "Email language",
    consent:
      "I agree to receive author notifications at my GitHub verified primary email, at most once per 72 hours across repositories.",
    save: "Save subscription",
    unsubscribe: "Unsubscribe",
  },
  setup: {
    title: "Installation status",
    openFromGitHub: "Open this page from your GitHub App installation settings.",
    receivedTitle: "Installation received",
    receivedBody: "Label initialisation runs automatically in the background. Sign in to see repositories and task status.",
    signIn: "Sign in with GitHub",
    refresh: "Refresh to see progress. Only repositories you can access are shown.",
    repository: "Repository",
    task: "Task",
    status: "Status",
    action: "Action",
    empty: "Initialisation is still being discovered, or there are no tasks for your accessible repositories yet.",
    retry: "Retry (admin)",
    kinds: { discover: "Discover", initialize: "Set up labels", label: "Label" },
    states: { pending: "Pending", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" },
  },
};

const zh: Messages = {
  nav: { site: "ghfind.com", language: "语言", theme: "主题", auto: "自动", light: "浅色", dark: "深色" },
  footer: { source: "源代码与支持", privacy: "隐私说明", emails: "作者邮件" },
  home: {
    eyebrow: "GitHub App · 免费",
    title: "先看是谁提的，再决定先处理哪条",
    subtitle:
      "ghfind Review 根据作者的公开 ghfind 评分，为每条新 issue 和 pull request 添加彩色 review: 标签。不用加 workflow，不用配置令牌或 secret。",
    install: "在 GitHub 安装",
    notOpen: "暂未开放安装。",
    learnMore: "在 ghfind.com 了解更多",
    rollout: "当前开放范围：{accounts}",
    labelsHeading: "五个标签，一眼分层",
    labelsLead: "安装时自动补齐缺失标签，你自定义过的颜色或描述会保留。",
    ranges: { low: "0 – 39", medium: "40 – 69", high: "70 – 89", top: "90 – 100", noScore: "无评分" },
    labelsNote: "评分反映作者的公开 GitHub profile，不是代码审查，也不是合并建议；无评分不等于零分。",
    stepsHeading: "工作方式",
    steps: {
      install: { title: "选择仓库安装", body: "授权 Issues 和 Pull requests 读写权限。建议选 Only select repositories 先小范围试用。" },
      open: { title: "有人新建 issue 或 PR", body: "bot 在后台查询作者的公开 ghfind 评分，不读取也不评估 issue 正文。" },
      label: { title: "出现 review: 标签", body: "只打标签，不评论、不关闭、不拦截任何提交。" },
    },
    permissions: {
      title: "权限与数据",
      body: "不读源码、不读 issue 正文、不运行 PR 代码。只保留安装、仓库、issue 编号、评分和任务状态；已完成任务 30 天后清理。",
    },
    emails: {
      title: "作者评分邮件",
      body: "有公开 GitHub 邮箱的作者跨仓库每 72 小时最多收到一封评分邮件，可一键退订。",
      link: "管理邮件设置",
    },
    migrate: { title: "从 Actions workflow 迁移？", body: "请停用旧的 PR review level workflow，避免同一条提交被打两次标签。" },
  },
  privacy: {
    title: "隐私说明",
    paragraphs: [
      "GitHub 会发送安装、issue、pull request 和 issue 评论事件。我们验证每个事件，只保留安装和仓库 ID、仓库名、issue 或 PR 编号、评分和任务状态。评论内容只用于检查是否提及本 App，不会保存。",
      "作者用户名会发送给 ghfind 查询公开 profile 评分。issue、PR 的正文和代码不会被保存，也不会被送去评分。App 只写标签，不发评论。",
      "已完成的任务记录 30 天后过期，失败任务保留到运维人员处理为止。状态页会话一小时过期，GitHub 用户令牌加密保存。卸载 App 会停止访问仓库，已有标签保留。",
      "作者当前 GitHub 主页有公开邮箱时，默认发送评分邮件；不会使用 commit 邮箱。作者也可以改为授权已验证主邮箱。邮箱加密保存，邮件记录保留 30 天。退订会删除保存的邮箱、取消待发邮件，并保留 GitHub 用户 ID 作为长期停发记录；已经开始发送的邮件仍可能送达。发送结果不确定的邮件不会自动重发。",
      "如需删除数据，请通过源代码仓库联系维护者。",
    ],
  },
  unsubscribe: { title: "退订", button: "停止作者邮件", doneTitle: "已退订", doneBody: "已删除你的邮箱订阅。" },
  notifications: {
    disabledTitle: "作者邮件",
    disabledBody: "邮件通知暂未开放。",
    title: "邮箱里的 ghfind 评分",
    body: "有 GitHub 公开邮箱的作者默认收到评分通知，退订后停止，跨仓库每 72 小时最多一封。登录后可改用已验证邮箱或管理偏好。",
    authNote: "GitHub 授权只用于读取已验证主邮箱，仅登录不会订阅。",
    signIn: "使用 GitHub 登录",
    needAuthTitle: "需要邮箱授权",
    needAuthBody: "请为 ghfind Review 授权读取邮箱（Email addresses: read），然后重新登录。",
    signInAgain: "重新登录",
    noEmailTitle: "无已验证主邮箱",
    noEmailBody: "请在 GitHub 设置中验证主邮箱后重试。",
    prefsTitle: "作者邮件设置",
    subscribed: "已订阅",
    notSubscribed: "未订阅",
    prefsBody: "接收新 issue 或 PR 的公开评分及站内排名，不代表审查等待时间。",
    emailLanguage: "邮件语言",
    consent: "我同意通过 GitHub 已验证主邮箱接收作者通知，跨仓库每 72 小时最多一封。",
    save: "保存订阅",
    unsubscribe: "退订",
  },
  setup: {
    title: "安装状态",
    openFromGitHub: "请从 GitHub App 的安装设置中打开此页面。",
    receivedTitle: "已收到安装",
    receivedBody: "标签初始化会在后台自动进行。登录后可查看仓库和任务状态。",
    signIn: "使用 GitHub 登录",
    refresh: "刷新页面查看进度。只显示你有权访问的仓库。",
    repository: "仓库",
    task: "任务",
    status: "状态",
    action: "操作",
    empty: "仍在发现初始化任务，或你有权访问的仓库暂时没有任务。",
    retry: "重试（管理员）",
    kinds: { discover: "发现仓库", initialize: "初始化标签", label: "打标签" },
    states: { pending: "等待中", running: "运行中", done: "已完成", failed: "失败", cancelled: "已取消" },
  },
};

const ja: Messages = {
  nav: { site: "ghfind.com", language: "言語", theme: "テーマ", auto: "自動", light: "ライト", dark: "ダーク" },
  footer: { source: "ソースとサポート", privacy: "プライバシー", emails: "作成者メール" },
  home: {
    eyebrow: "GitHub App · 無料",
    title: "誰が作ったかで issue と PR を振り分ける",
    subtitle:
      "ghfind Review は作成者の公開 ghfind スコアをもとに、新しい issue と pull request に色分けされた review: ラベルを付けます。workflow もトークンも secret の設定も不要です。",
    install: "GitHub でインストール",
    notOpen: "インストールはまだ公開されていません。",
    learnMore: "ghfind.com で詳しく見る",
    rollout: "現在の公開範囲：{accounts}",
    labelsHeading: "5つのラベルでひと目で分類",
    labelsLead: "不足しているラベルはインストール時に作成されます。カスタマイズした色や説明はそのまま残ります。",
    ranges: { low: "0 – 39", medium: "40 – 69", high: "70 – 89", top: "90 – 100", noScore: "スコアなし" },
    labelsNote: "スコアは作成者の公開 GitHub プロフィールを表すもので、コードレビューやマージ判断ではありません。スコアなしは0点ではありません。",
    stepsHeading: "仕組み",
    steps: {
      install: { title: "リポジトリを選んでインストール", body: "Issues と Pull requests の読み書きを許可します。まずは Only select repositories で小さく始めましょう。" },
      open: { title: "誰かが issue や PR を作成", body: "bot がバックグラウンドで作成者の公開 ghfind スコアを取得します。issue 本文は読まず、評価もしません。" },
      label: { title: "review: ラベルが付く", body: "ラベルを付けるだけで、コメント・クローズ・ブロックは一切しません。" },
    },
    permissions: {
      title: "権限とデータ",
      body: "ソースコード、issue 本文、PR のコードは扱いません。保持するのはインストール、リポジトリ、issue 番号、スコア、タスク状態だけで、完了したタスクは30日後に削除されます。",
    },
    emails: {
      title: "作成者へのスコアメール",
      body: "公開 GitHub メールのある作成者には、リポジトリをまたいで72時間に最大1通のスコアメールが届き、ワンクリックで配信停止できます。",
      link: "メール設定を管理",
    },
    migrate: { title: "Actions workflow から移行しますか？", body: "同じ投稿に二重でラベルが付かないよう、旧 PR review level workflow を無効にしてください。" },
  },
  privacy: {
    title: "プライバシー",
    paragraphs: [
      "GitHub からインストール、issue、pull request、issue コメントのイベントが送られます。各イベントを検証し、インストールとリポジトリの ID、リポジトリ名、issue または PR の番号、スコア、タスク状態のみを保持します。コメント本文は本 App へのメンションの確認にのみ使い、保存しません。",
      "作成者のログイン名は公開プロフィールのスコア取得のため ghfind に送られます。issue や PR の本文・コードは保存も採点への送信もしません。App はラベルを書き込むだけで、コメントは投稿しません。",
      "完了したタスク記録は30日で失効し、失敗したタスク記録は運用者が対応するまで残ります。ダッシュボードのセッションは1時間で失効し、GitHub ユーザートークンは暗号化して保存します。App をアンインストールするとリポジトリへのアクセスは止まり、既存のラベルは残ります。",
      "作成者の現在の GitHub プロフィールに公開メールがある場合、スコアメールは既定で送信されます。コミットのメールアドレスは使いません。代わりに検証済みのプライマリメールを許可することもできます。アドレスは暗号化して保存し、メール記録は30日間保持します。配信停止すると保存したアドレスを削除し、未送信のメールを取り消し、GitHub ユーザー ID を恒久的な停止記録として残します。すでに送信中のメールは届く場合があります。配信結果が不確かなメールは自動で再送しません。",
      "削除のご依頼は、ソースリポジトリからメンテナーにご連絡ください。",
    ],
  },
  unsubscribe: { title: "配信停止", button: "作成者メールを停止", doneTitle: "配信を停止しました", doneBody: "メールの購読を削除しました。" },
  notifications: {
    disabledTitle: "作成者メール",
    disabledBody: "メール通知はまだ有効になっていません。",
    title: "ghfind スコアをメールで",
    body: "GitHub プロフィールに公開メールがある作成者には、配信停止するまで既定でスコア通知が届きます。リポジトリをまたいで72時間に最大1通です。ログインすると検証済みメールへの切り替えや設定の管理ができます。",
    authNote: "GitHub の認可は検証済みプライマリメールの読み取りにのみ使います。ログインだけでは購読されません。",
    signIn: "GitHub でログイン",
    needAuthTitle: "メールの認可が必要です",
    needAuthBody: "ghfind Review に Email addresses: read を許可してから、もう一度ログインしてください。",
    signInAgain: "再ログイン",
    noEmailTitle: "検証済みのプライマリメールがありません",
    noEmailBody: "GitHub の設定でプライマリメールを検証してから、もう一度お試しください。",
    prefsTitle: "作成者メールの設定",
    subscribed: "購読中",
    notSubscribed: "未購読",
    prefsBody: "新しい issue や PR について、公開プロフィールのスコアとサイト内順位を受け取ります。レビュー待ち時間の目安ではありません。",
    emailLanguage: "メールの言語",
    consent: "GitHub の検証済みプライマリメールで作成者通知を受け取ることに同意します（リポジトリをまたいで72時間に最大1通）。",
    save: "購読を保存",
    unsubscribe: "配信停止",
  },
  setup: {
    title: "インストール状況",
    openFromGitHub: "GitHub App のインストール設定からこのページを開いてください。",
    receivedTitle: "インストールを受け付けました",
    receivedBody: "ラベルの初期化はバックグラウンドで自動的に行われます。ログインするとリポジトリとタスクの状況を確認できます。",
    signIn: "GitHub でログイン",
    refresh: "更新すると進捗が表示されます。アクセスできるリポジトリのみ表示されます。",
    repository: "リポジトリ",
    task: "タスク",
    status: "状態",
    action: "操作",
    empty: "初期化タスクを検出中か、アクセスできるリポジトリにまだタスクがありません。",
    retry: "再試行（管理者）",
    kinds: { discover: "検出", initialize: "ラベル初期化", label: "ラベル付け" },
    states: { pending: "待機中", running: "実行中", done: "完了", failed: "失敗", cancelled: "取消" },
  },
};

const ko: Messages = {
  nav: { site: "ghfind.com", language: "언어", theme: "테마", auto: "자동", light: "라이트", dark: "다크" },
  footer: { source: "소스 및 지원", privacy: "개인정보", emails: "작성자 메일" },
  home: {
    eyebrow: "GitHub App · 무료",
    title: "누가 올렸는지로 issue와 PR을 분류하세요",
    subtitle:
      "ghfind Review는 작성자의 공개 ghfind 점수를 바탕으로 새 issue와 pull request에 색상별 review: 라벨을 붙입니다. workflow, 토큰, secret 설정이 필요 없습니다.",
    install: "GitHub에서 설치",
    notOpen: "아직 설치가 열리지 않았습니다.",
    learnMore: "ghfind.com에서 자세히 보기",
    rollout: "현재 공개 범위: {accounts}",
    labelsHeading: "다섯 개 라벨로 한눈에",
    labelsLead: "없는 라벨은 설치 시 자동으로 만들어집니다. 직접 바꾼 색상이나 설명은 유지됩니다.",
    ranges: { low: "0 – 39", medium: "40 – 69", high: "70 – 89", top: "90 – 100", noScore: "점수 없음" },
    labelsNote: "점수는 작성자의 공개 GitHub 프로필을 나타낼 뿐 코드 리뷰나 병합 판단이 아닙니다. 점수 없음은 0점이 아닙니다.",
    stepsHeading: "작동 방식",
    steps: {
      install: { title: "저장소를 골라 설치", body: "Issues와 Pull requests 읽기·쓰기 권한을 허용합니다. Only select repositories로 작게 시작하세요." },
      open: { title: "누군가 issue나 PR을 엶", body: "bot이 백그라운드에서 작성자의 공개 ghfind 점수를 조회합니다. issue 본문은 읽거나 평가하지 않습니다." },
      label: { title: "review: 라벨이 붙음", body: "라벨만 붙이며 댓글, 닫기, 차단은 하지 않습니다." },
    },
    permissions: {
      title: "권한과 데이터",
      body: "소스 코드, issue 본문, PR 코드는 다루지 않습니다. 설치, 저장소, issue 번호, 점수, 작업 상태만 보관하며 완료된 작업은 30일 후 삭제됩니다.",
    },
    emails: {
      title: "작성자 점수 메일",
      body: "공개 GitHub 이메일이 있는 작성자는 저장소 전체에서 72시간에 최대 한 통의 점수 메일을 받으며, 한 번에 수신 거부할 수 있습니다.",
      link: "메일 설정 관리",
    },
    migrate: { title: "Actions workflow에서 옮겨 오나요?", body: "같은 제출에 라벨이 두 번 붙지 않도록 기존 PR review level workflow를 꺼 주세요." },
  },
  privacy: {
    title: "개인정보",
    paragraphs: [
      "GitHub는 설치, issue, pull request, issue 댓글 이벤트를 보냅니다. 각 이벤트를 검증하고 설치·저장소 ID, 저장소 이름, issue 또는 PR 번호, 점수, 작업 상태만 보관합니다. 댓글 내용은 이 App 멘션 여부 확인에만 쓰이며 저장하지 않습니다.",
      "작성자 로그인은 공개 프로필 점수를 조회하기 위해 ghfind로 전송됩니다. issue와 PR의 본문 및 코드는 저장하거나 채점에 보내지 않습니다. App은 라벨만 작성하며 댓글을 달지 않습니다.",
      "완료된 작업 기록은 30일 후 만료되며, 실패한 작업 기록은 운영자가 처리할 때까지 남습니다. 대시보드 세션은 1시간 후 만료되고 GitHub 사용자 토큰은 암호화되어 저장됩니다. App을 삭제하면 저장소 접근이 중단되며 기존 라벨은 그대로 남습니다.",
      "작성자의 현재 GitHub 프로필에 공개 이메일이 있으면 점수 메일이 기본으로 발송됩니다. 커밋 이메일은 사용하지 않습니다. 대신 인증된 기본 이메일을 허용할 수도 있습니다. 주소는 암호화되어 저장되며 메일 기록은 30일간 보관됩니다. 수신 거부하면 저장된 주소를 삭제하고 대기 중인 메일을 취소하며 GitHub 사용자 ID를 영구 수신 거부 기록으로 남깁니다. 이미 발송 중인 메일은 도착할 수 있습니다. 전달 여부가 불확실한 메일은 자동으로 다시 보내지 않습니다.",
      "삭제 요청은 소스 저장소를 통해 관리자에게 문의해 주세요.",
    ],
  },
  unsubscribe: { title: "수신 거부", button: "작성자 메일 중지", doneTitle: "수신 거부됨", doneBody: "이메일 구독이 삭제되었습니다." },
  notifications: {
    disabledTitle: "작성자 메일",
    disabledBody: "메일 알림이 아직 활성화되지 않았습니다.",
    title: "ghfind 점수를 메일로",
    body: "GitHub 프로필에 공개 이메일이 있는 작성자는 수신 거부할 때까지 기본으로 점수 알림을 받습니다. 저장소 전체에서 72시간에 최대 한 통입니다. 로그인하면 인증된 이메일로 바꾸거나 설정을 관리할 수 있습니다.",
    authNote: "GitHub 권한은 인증된 기본 이메일을 읽는 데만 사용합니다. 로그인만으로는 구독되지 않습니다.",
    signIn: "GitHub로 로그인",
    needAuthTitle: "이메일 권한이 필요합니다",
    needAuthBody: "ghfind Review에 Email addresses: read 권한을 허용한 뒤 다시 로그인하세요.",
    signInAgain: "다시 로그인",
    noEmailTitle: "인증된 기본 이메일이 없습니다",
    noEmailBody: "GitHub 설정에서 기본 이메일을 인증한 뒤 다시 시도하세요.",
    prefsTitle: "작성자 메일 설정",
    subscribed: "구독 중",
    notSubscribed: "구독 안 함",
    prefsBody: "새 issue와 PR에 대한 공개 프로필 점수와 사이트 내 순위를 받습니다. 리뷰 대기 시간 예측이 아닙니다.",
    emailLanguage: "메일 언어",
    consent: "GitHub 인증 기본 이메일로 작성자 알림을 받는 데 동의합니다(저장소 전체에서 72시간에 최대 한 통).",
    save: "구독 저장",
    unsubscribe: "수신 거부",
  },
  setup: {
    title: "설치 상태",
    openFromGitHub: "GitHub App 설치 설정에서 이 페이지를 여세요.",
    receivedTitle: "설치를 받았습니다",
    receivedBody: "라벨 초기화는 백그라운드에서 자동으로 진행됩니다. 로그인하면 저장소와 작업 상태를 볼 수 있습니다.",
    signIn: "GitHub로 로그인",
    refresh: "새로 고치면 진행 상황이 보입니다. 접근 가능한 저장소만 표시됩니다.",
    repository: "저장소",
    task: "작업",
    status: "상태",
    action: "동작",
    empty: "초기화 작업을 찾는 중이거나, 접근 가능한 저장소에 아직 작업이 없습니다.",
    retry: "재시도(관리자)",
    kinds: { discover: "탐색", initialize: "라벨 초기화", label: "라벨 지정" },
    states: { pending: "대기", running: "실행 중", done: "완료", failed: "실패", cancelled: "취소됨" },
  },
};

const es: Messages = {
  nav: { site: "ghfind.com", language: "Idioma", theme: "Tema", auto: "Auto", light: "Claro", dark: "Oscuro" },
  footer: { source: "Código y soporte", privacy: "Privacidad", emails: "Emails de autor" },
  home: {
    eyebrow: "GitHub App · Gratis",
    title: "Prioriza issues y PRs según quién los abre",
    subtitle:
      "ghfind Review añade una etiqueta review: de color a cada issue y pull request nuevo, según la puntuación pública de ghfind del autor. Sin workflow, sin token, sin secretos que configurar.",
    install: "Instalar en GitHub",
    notOpen: "La instalación aún no está abierta.",
    learnMore: "Más información en ghfind.com",
    rollout: "Despliegue actual: {accounts}",
    labelsHeading: "Cinco etiquetas, un vistazo",
    labelsLead: "Las etiquetas que falten se crean al instalar. Se respetan los colores o descripciones que hayas personalizado.",
    ranges: { low: "0 – 39", medium: "40 – 69", high: "70 – 89", top: "90 – 100", noScore: "Sin puntuación" },
    labelsNote:
      "La puntuación describe el perfil público de GitHub del autor. No es una revisión de código ni una decisión de merge, y sin puntuación no significa cero.",
    stepsHeading: "Cómo funciona",
    steps: {
      install: { title: "Instala en los repositorios elegidos", body: "Concede lectura y escritura en Issues y Pull requests. Elige Only select repositories para empezar poco a poco." },
      open: { title: "Alguien abre un issue o PR", body: "El bot consulta en segundo plano la puntuación pública de ghfind del autor. Nunca lee ni evalúa el cuerpo del issue." },
      label: { title: "Aparece una etiqueta review:", body: "Solo añade etiquetas: nunca comenta, cierra ni bloquea una contribución." },
    },
    permissions: {
      title: "Permisos y datos",
      body: "Ni código fuente, ni cuerpos de issues, ni código de PRs. Solo guarda la instalación, el repositorio, el número de issue, la puntuación y el estado de la tarea; las tareas terminadas se borran a los 30 días.",
    },
    emails: {
      title: "Emails de puntuación para autores",
      body: "Los autores con email público en GitHub pueden recibir como máximo un email de puntuación cada 72 horas entre repositorios, con baja en un clic.",
      link: "Gestionar preferencias de email",
    },
    migrate: { title: "¿Vienes del workflow de Actions?", body: "Desactiva el antiguo workflow PR review level para que no se etiquete dos veces la misma contribución." },
  },
  privacy: {
    title: "Privacidad",
    paragraphs: [
      "GitHub envía eventos de instalación, issues, pull requests y comentarios de issues. Verificamos cada evento y solo guardamos los IDs de instalación y repositorio, los nombres de repositorio, los números de issue o PR, las puntuaciones y el estado de las tareas. El texto de los comentarios solo se revisa para detectar una mención a esta App y nunca se guarda.",
      "El login del autor se envía a ghfind para obtener una puntuación de su perfil público. El texto y el código de issues y PRs nunca se guardan ni se envían para puntuar. La App solo escribe etiquetas; no publica comentarios.",
      "Los registros de tareas completadas caducan a los 30 días. Los de tareas fallidas se conservan hasta que un operador las resuelve. Las sesiones del panel caducan a la hora y los tokens de usuario de GitHub se guardan cifrados. Desinstalar la App corta el acceso a los repositorios y mantiene las etiquetas existentes.",
      "Los emails de puntuación se envían por defecto cuando el perfil actual de GitHub del autor tiene un email público. Nunca se usan los emails de los commits. El autor puede autorizar en su lugar su email principal verificado. Las direcciones se guardan cifradas y los registros de email se conservan 30 días. Darse de baja elimina la dirección guardada, cancela los envíos pendientes y conserva el ID de usuario de GitHub como exclusión permanente; un envío ya en curso aún puede llegar. Los mensajes con entrega incierta no se reenvían automáticamente.",
      "Para solicitudes de borrado, contacta con los mantenedores a través del repositorio del código.",
    ],
  },
  unsubscribe: { title: "Darse de baja", button: "Dejar de recibir emails de autor", doneTitle: "Baja completada", doneBody: "Se ha eliminado tu suscripción por email." },
  notifications: {
    disabledTitle: "Emails de autor",
    disabledBody: "Las notificaciones por email aún no están activadas.",
    title: "Tu puntuación de ghfind, en tu bandeja",
    body: "Los autores con un email público en su perfil de GitHub reciben notificaciones de puntuación por defecto hasta que se dan de baja: como máximo una cada 72 horas entre repositorios. Inicia sesión para usar tu email verificado o gestionar tus preferencias.",
    authNote: "La autorización de GitHub solo lee tu email principal verificado. Iniciar sesión no te suscribe.",
    signIn: "Iniciar sesión con GitHub",
    needAuthTitle: "Hace falta autorizar el email",
    needAuthBody: "Autoriza Email addresses: read para ghfind Review y vuelve a iniciar sesión.",
    signInAgain: "Volver a iniciar sesión",
    noEmailTitle: "Sin email principal verificado",
    noEmailBody: "Verifica tu email principal en los ajustes de GitHub y vuelve a intentarlo.",
    prefsTitle: "Preferencias de email de autor",
    subscribed: "Suscrito",
    notSubscribed: "No suscrito",
    prefsBody: "Recibe la puntuación de tu perfil público y tu posición en ghfind por cada issue o PR nuevo. No es una estimación del tiempo de revisión.",
    emailLanguage: "Idioma del email",
    consent: "Acepto recibir notificaciones de autor en mi email principal verificado de GitHub, como máximo una vez cada 72 horas entre repositorios.",
    save: "Guardar suscripción",
    unsubscribe: "Darse de baja",
  },
  setup: {
    title: "Estado de la instalación",
    openFromGitHub: "Abre esta página desde los ajustes de instalación de la GitHub App.",
    receivedTitle: "Instalación recibida",
    receivedBody: "La inicialización de etiquetas se ejecuta automáticamente en segundo plano. Inicia sesión para ver repositorios y tareas.",
    signIn: "Iniciar sesión con GitHub",
    refresh: "Recarga para ver el progreso. Solo se muestran los repositorios a los que tienes acceso.",
    repository: "Repositorio",
    task: "Tarea",
    status: "Estado",
    action: "Acción",
    empty: "Aún se está descubriendo la inicialización o todavía no hay tareas para tus repositorios.",
    retry: "Reintentar (admin)",
    kinds: { discover: "Descubrir", initialize: "Preparar etiquetas", label: "Etiquetar" },
    states: { pending: "Pendiente", running: "En curso", done: "Hecho", failed: "Fallida", cancelled: "Cancelada" },
  },
};

const pt: Messages = {
  nav: { site: "ghfind.com", language: "Idioma", theme: "Tema", auto: "Auto", light: "Claro", dark: "Escuro" },
  footer: { source: "Código e suporte", privacy: "Privacidade", emails: "E-mails do autor" },
  home: {
    eyebrow: "GitHub App · Grátis",
    title: "Faça a triagem de issues e PRs por quem os abriu",
    subtitle:
      "O ghfind Review adiciona um rótulo review: colorido a cada novo issue e pull request, com base na pontuação pública do autor no ghfind. Sem workflow, sem token, sem segredos para configurar.",
    install: "Instalar no GitHub",
    notOpen: "A instalação ainda não está aberta.",
    learnMore: "Saiba mais em ghfind.com",
    rollout: "Liberação atual: {accounts}",
    labelsHeading: "Cinco rótulos, uma olhada",
    labelsLead: "Rótulos ausentes são criados na instalação. Cores ou descrições personalizadas são mantidas.",
    ranges: { low: "0 – 39", medium: "40 – 69", high: "70 – 89", top: "90 – 100", noScore: "Sem pontuação" },
    labelsNote:
      "A pontuação descreve o perfil público do autor no GitHub. Não é revisão de código nem decisão de merge, e sem pontuação não significa zero.",
    stepsHeading: "Como funciona",
    steps: {
      install: { title: "Instale nos repositórios escolhidos", body: "Conceda leitura e escrita em Issues e Pull requests. Escolha Only select repositories para começar pequeno." },
      open: { title: "Alguém abre um issue ou PR", body: "O bot consulta em segundo plano a pontuação pública do autor no ghfind. O corpo do issue nunca é lido nem avaliado." },
      label: { title: "Aparece um rótulo review:", body: "Só adiciona rótulos: nunca comenta, fecha ou bloqueia uma contribuição." },
    },
    permissions: {
      title: "Permissões e dados",
      body: "Nada de código-fonte, corpo de issues ou código de PRs. Guarda só a instalação, o repositório, o número do issue, a pontuação e o estado da tarefa; tarefas concluídas são apagadas após 30 dias.",
    },
    emails: {
      title: "E-mails de pontuação para autores",
      body: "Autores com e-mail público no GitHub podem receber no máximo um e-mail de pontuação a cada 72 horas entre repositórios, com descadastro em um clique.",
      link: "Gerenciar preferências de e-mail",
    },
    migrate: { title: "Vindo do workflow do Actions?", body: "Desative o antigo workflow PR review level para que a mesma contribuição não seja rotulada duas vezes." },
  },
  privacy: {
    title: "Privacidade",
    paragraphs: [
      "O GitHub envia eventos de instalação, issues, pull requests e comentários em issues. Verificamos cada evento e guardamos apenas IDs de instalação e repositório, nomes de repositório, números de issue ou PR, pontuações e status das tarefas. O texto dos comentários só é verificado para detectar uma menção a este App e nunca é armazenado.",
      "O login do autor é enviado ao ghfind para obter a pontuação do perfil público. Texto e código de issues e PRs nunca são armazenados nem enviados para pontuação. O App só escreve rótulos; não publica comentários.",
      "Registros de tarefas concluídas expiram após 30 dias. Registros de tarefas com falha ficam até um operador resolvê-los. Sessões do painel expiram em uma hora e tokens de usuário do GitHub são criptografados em repouso. Desinstalar o App encerra o acesso aos repositórios e mantém os rótulos existentes.",
      "E-mails de pontuação são enviados por padrão quando o perfil atual do autor no GitHub tem um e-mail público. E-mails de commits nunca são usados. O autor pode, em vez disso, autorizar seu e-mail principal verificado. Os endereços são criptografados e os registros de e-mail são mantidos por 30 dias. O descadastro remove o endereço armazenado, cancela envios pendentes e mantém o ID de usuário do GitHub como exclusão permanente; um envio já em andamento ainda pode chegar. Mensagens com entrega incerta não são reenviadas automaticamente.",
      "Para pedidos de exclusão, contate os mantenedores pelo repositório do código.",
    ],
  },
  unsubscribe: { title: "Descadastrar", button: "Parar e-mails do autor", doneTitle: "Descadastrado", doneBody: "Sua inscrição por e-mail foi removida." },
  notifications: {
    disabledTitle: "E-mails do autor",
    disabledBody: "As notificações por e-mail ainda não estão ativadas.",
    title: "Sua pontuação do ghfind, na sua caixa de entrada",
    body: "Autores com e-mail público no perfil do GitHub recebem notificações de pontuação por padrão até se descadastrarem — no máximo uma a cada 72 horas entre repositórios. Entre para usar seu e-mail verificado ou gerenciar preferências.",
    authNote: "A autorização do GitHub só lê seu e-mail principal verificado. Entrar não faz a inscrição.",
    signIn: "Entrar com GitHub",
    needAuthTitle: "Autorização de e-mail necessária",
    needAuthBody: "Autorize Email addresses: read para o ghfind Review e entre novamente.",
    signInAgain: "Entrar novamente",
    noEmailTitle: "Nenhum e-mail principal verificado",
    noEmailBody: "Verifique seu e-mail principal nas configurações do GitHub e tente de novo.",
    prefsTitle: "Preferências de e-mail do autor",
    subscribed: "Inscrito",
    notSubscribed: "Não inscrito",
    prefsBody: "Receba a pontuação do seu perfil público e sua posição no ghfind para novos issues e PRs. Não é uma estimativa do tempo de revisão.",
    emailLanguage: "Idioma do e-mail",
    consent: "Aceito receber notificações de autor no meu e-mail principal verificado do GitHub, no máximo uma vez a cada 72 horas entre repositórios.",
    save: "Salvar inscrição",
    unsubscribe: "Descadastrar",
  },
  setup: {
    title: "Status da instalação",
    openFromGitHub: "Abra esta página pelas configurações de instalação da GitHub App.",
    receivedTitle: "Instalação recebida",
    receivedBody: "A inicialização dos rótulos roda automaticamente em segundo plano. Entre para ver repositórios e tarefas.",
    signIn: "Entrar com GitHub",
    refresh: "Atualize para ver o progresso. Só aparecem repositórios aos quais você tem acesso.",
    repository: "Repositório",
    task: "Tarefa",
    status: "Status",
    action: "Ação",
    empty: "A inicialização ainda está sendo descoberta ou ainda não há tarefas para seus repositórios.",
    retry: "Tentar de novo (admin)",
    kinds: { discover: "Descobrir", initialize: "Preparar rótulos", label: "Rotular" },
    states: { pending: "Pendente", running: "Em andamento", done: "Concluída", failed: "Falhou", cancelled: "Cancelada" },
  },
};

const id: Messages = {
  nav: { site: "ghfind.com", language: "Bahasa", theme: "Tema", auto: "Otomatis", light: "Terang", dark: "Gelap" },
  footer: { source: "Kode sumber & dukungan", privacy: "Privasi", emails: "Email penulis" },
  home: {
    eyebrow: "GitHub App · Gratis",
    title: "Pilah issue dan PR berdasarkan siapa pembuatnya",
    subtitle:
      "ghfind Review menambahkan label review: berwarna ke setiap issue dan pull request baru, berdasarkan skor ghfind publik penulisnya. Tanpa workflow, token, atau secret yang perlu diatur.",
    install: "Pasang di GitHub",
    notOpen: "Pemasangan belum dibuka.",
    learnMore: "Pelajari lebih lanjut di ghfind.com",
    rollout: "Cakupan saat ini: {accounts}",
    labelsHeading: "Lima label, sekali lihat",
    labelsLead: "Label yang belum ada dibuat saat pemasangan. Warna atau deskripsi yang sudah Anda ubah tetap dipertahankan.",
    ranges: { low: "0 – 39", medium: "40 – 69", high: "70 – 89", top: "90 – 100", noScore: "Tanpa skor" },
    labelsNote: "Skor menggambarkan profil GitHub publik penulis. Ini bukan review kode atau keputusan merge, dan tanpa skor tidak berarti nol.",
    stepsHeading: "Cara kerja",
    steps: {
      install: { title: "Pasang di repositori pilihan", body: "Beri izin baca & tulis untuk Issues dan Pull requests. Pilih Only select repositories untuk mulai kecil." },
      open: { title: "Seseorang membuka issue atau PR", body: "Bot mencari skor ghfind publik penulis di latar belakang. Isi issue tidak pernah dibaca atau dinilai." },
      label: { title: "Label review: muncul", body: "Hanya menambahkan label — tidak pernah berkomentar, menutup, atau memblokir kiriman." },
    },
    permissions: {
      title: "Izin & data",
      body: "Tidak menyentuh kode sumber, isi issue, atau kode PR. Hanya menyimpan instalasi, repositori, nomor issue, skor, dan status tugas; tugas selesai dihapus setelah 30 hari.",
    },
    emails: {
      title: "Email skor untuk penulis",
      body: "Penulis dengan email GitHub publik bisa menerima paling banyak satu email skor per 72 jam lintas repositori, dengan berhenti langganan sekali klik.",
      link: "Kelola preferensi email",
    },
    migrate: { title: "Pindah dari workflow Actions?", body: "Nonaktifkan workflow PR review level lama agar kiriman yang sama tidak diberi label dua kali." },
  },
  privacy: {
    title: "Privasi",
    paragraphs: [
      "GitHub mengirim event instalasi, issue, pull request, dan komentar issue. Kami memverifikasi setiap event dan hanya menyimpan ID instalasi dan repositori, nama repositori, nomor issue atau PR, skor, dan status tugas. Teks komentar hanya diperiksa untuk mendeteksi mention ke App ini dan tidak pernah disimpan.",
      "Login penulis dikirim ke ghfind untuk mengambil skor profil publik. Teks dan kode issue maupun PR tidak pernah disimpan atau dikirim untuk dinilai. App hanya menulis label; tidak memposting komentar.",
      "Catatan tugas yang selesai kedaluwarsa setelah 30 hari. Catatan tugas yang gagal disimpan sampai operator menanganinya. Sesi dasbor kedaluwarsa setelah satu jam dan token pengguna GitHub dienkripsi saat disimpan. Mencopot App menghentikan akses ke repositori dan membiarkan label yang ada.",
      "Email skor dikirim secara default bila profil GitHub penulis saat ini memiliki email publik. Email commit tidak pernah digunakan. Penulis dapat mengotorisasi email utama terverifikasi sebagai gantinya. Alamat dienkripsi dan catatan email disimpan selama 30 hari. Berhenti langganan menghapus alamat yang tersimpan, membatalkan email tertunda, dan menyimpan ID pengguna GitHub sebagai penolakan permanen; pengiriman yang sedang berlangsung mungkin tetap sampai. Pesan dengan status pengiriman tidak pasti tidak dikirim ulang otomatis.",
      "Untuk permintaan penghapusan, hubungi pengelola melalui repositori kode sumber.",
    ],
  },
  unsubscribe: { title: "Berhenti langganan", button: "Hentikan email penulis", doneTitle: "Berhenti berlangganan", doneBody: "Langganan email Anda telah dihapus." },
  notifications: {
    disabledTitle: "Email penulis",
    disabledBody: "Notifikasi email belum diaktifkan.",
    title: "Skor ghfind Anda, di kotak masuk",
    body: "Penulis dengan email publik di profil GitHub menerima notifikasi skor secara default sampai berhenti langganan — paling banyak satu per 72 jam lintas repositori. Masuk untuk memakai email terverifikasi atau mengatur preferensi.",
    authNote: "Otorisasi GitHub hanya membaca email utama terverifikasi Anda. Masuk saja tidak membuat Anda berlangganan.",
    signIn: "Masuk dengan GitHub",
    needAuthTitle: "Perlu otorisasi email",
    needAuthBody: "Izinkan Email addresses: read untuk ghfind Review, lalu masuk lagi.",
    signInAgain: "Masuk lagi",
    noEmailTitle: "Tidak ada email utama terverifikasi",
    noEmailBody: "Verifikasi email utama di pengaturan GitHub lalu coba lagi.",
    prefsTitle: "Preferensi email penulis",
    subscribed: "Berlangganan",
    notSubscribed: "Tidak berlangganan",
    prefsBody: "Terima skor profil publik dan peringkat ghfind Anda untuk issue dan PR baru. Ini bukan perkiraan waktu review.",
    emailLanguage: "Bahasa email",
    consent: "Saya setuju menerima notifikasi penulis di email utama terverifikasi GitHub saya, paling banyak sekali per 72 jam lintas repositori.",
    save: "Simpan langganan",
    unsubscribe: "Berhenti langganan",
  },
  setup: {
    title: "Status instalasi",
    openFromGitHub: "Buka halaman ini dari pengaturan instalasi GitHub App.",
    receivedTitle: "Instalasi diterima",
    receivedBody: "Inisialisasi label berjalan otomatis di latar belakang. Masuk untuk melihat repositori dan status tugas.",
    signIn: "Masuk dengan GitHub",
    refresh: "Muat ulang untuk melihat progres. Hanya repositori yang bisa Anda akses yang ditampilkan.",
    repository: "Repositori",
    task: "Tugas",
    status: "Status",
    action: "Aksi",
    empty: "Inisialisasi masih ditemukan, atau belum ada tugas untuk repositori yang bisa Anda akses.",
    retry: "Coba lagi (admin)",
    kinds: { discover: "Temukan", initialize: "Siapkan label", label: "Beri label" },
    states: { pending: "Menunggu", running: "Berjalan", done: "Selesai", failed: "Gagal", cancelled: "Dibatalkan" },
  },
};

const vi: Messages = {
  nav: { site: "ghfind.com", language: "Ngôn ngữ", theme: "Giao diện", auto: "Tự động", light: "Sáng", dark: "Tối" },
  footer: { source: "Mã nguồn & hỗ trợ", privacy: "Quyền riêng tư", emails: "Email tác giả" },
  home: {
    eyebrow: "GitHub App · Miễn phí",
    title: "Phân loại issue và PR theo người tạo",
    subtitle:
      "ghfind Review gắn nhãn review: có màu cho mọi issue và pull request mới, dựa trên điểm ghfind công khai của tác giả. Không cần workflow, token hay secret.",
    install: "Cài trên GitHub",
    notOpen: "Chưa mở cài đặt.",
    learnMore: "Tìm hiểu thêm trên ghfind.com",
    rollout: "Phạm vi hiện tại: {accounts}",
    labelsHeading: "Năm nhãn, nhìn là biết",
    labelsLead: "Nhãn còn thiếu sẽ được tạo khi cài. Màu hoặc mô tả bạn đã tùy chỉnh được giữ nguyên.",
    ranges: { low: "0 – 39", medium: "40 – 69", high: "70 – 89", top: "90 – 100", noScore: "Không có điểm" },
    labelsNote: "Điểm mô tả hồ sơ GitHub công khai của tác giả, không phải review mã hay quyết định merge; không có điểm không có nghĩa là 0 điểm.",
    stepsHeading: "Cách hoạt động",
    steps: {
      install: { title: "Cài vào các repo đã chọn", body: "Cấp quyền đọc & ghi cho Issues và Pull requests. Chọn Only select repositories để thử quy mô nhỏ." },
      open: { title: "Có người mở issue hoặc PR", body: "Bot tra cứu điểm ghfind công khai của tác giả ở chế độ nền. Nội dung issue không bao giờ được đọc hay chấm điểm." },
      label: { title: "Nhãn review: xuất hiện", body: "Chỉ gắn nhãn — không bình luận, đóng hay chặn bất kỳ đóng góp nào." },
    },
    permissions: {
      title: "Quyền & dữ liệu",
      body: "Không đụng đến mã nguồn, nội dung issue hay mã PR. Chỉ lưu bản cài đặt, repo, số issue, điểm và trạng thái tác vụ; tác vụ đã xong bị xóa sau 30 ngày.",
    },
    emails: {
      title: "Email điểm cho tác giả",
      body: "Tác giả có email GitHub công khai nhận tối đa một email điểm mỗi 72 giờ trên mọi repo, hủy đăng ký chỉ với một cú nhấp.",
      link: "Quản lý tùy chọn email",
    },
    migrate: { title: "Chuyển từ workflow Actions?", body: "Hãy tắt workflow PR review level cũ để một đóng góp không bị gắn nhãn hai lần." },
  },
  privacy: {
    title: "Quyền riêng tư",
    paragraphs: [
      "GitHub gửi các sự kiện cài đặt, issue, pull request và bình luận issue. Chúng tôi xác minh từng sự kiện và chỉ lưu ID cài đặt và repo, tên repo, số issue hoặc PR, điểm và trạng thái tác vụ. Nội dung bình luận chỉ được kiểm tra xem có nhắc đến App này không và không bao giờ được lưu.",
      "Tên đăng nhập của tác giả được gửi tới ghfind để lấy điểm hồ sơ công khai. Nội dung và mã của issue, PR không bao giờ được lưu hay gửi đi chấm điểm. App chỉ ghi nhãn, không đăng bình luận.",
      "Bản ghi tác vụ đã xong hết hạn sau 30 ngày. Bản ghi tác vụ lỗi được giữ đến khi người vận hành xử lý. Phiên bảng điều khiển hết hạn sau một giờ và token người dùng GitHub được mã hóa khi lưu. Gỡ App sẽ dừng truy cập repo và giữ nguyên các nhãn hiện có.",
      "Email điểm được gửi mặc định khi hồ sơ GitHub hiện tại của tác giả có email công khai. Email trong commit không bao giờ được dùng. Tác giả có thể ủy quyền email chính đã xác minh thay thế. Địa chỉ được mã hóa và bản ghi email được giữ 30 ngày. Hủy đăng ký sẽ xóa địa chỉ đã lưu, hủy thư đang chờ và giữ ID người dùng GitHub làm bản ghi từ chối lâu dài; thư đang gửi dở vẫn có thể đến. Thư có trạng thái gửi không rõ sẽ không tự động gửi lại.",
      "Để yêu cầu xóa dữ liệu, hãy liên hệ người duy trì qua repo mã nguồn.",
    ],
  },
  unsubscribe: { title: "Hủy đăng ký", button: "Dừng email tác giả", doneTitle: "Đã hủy đăng ký", doneBody: "Đăng ký email của bạn đã được xóa." },
  notifications: {
    disabledTitle: "Email tác giả",
    disabledBody: "Thông báo email chưa được bật.",
    title: "Điểm ghfind của bạn, ngay trong hộp thư",
    body: "Tác giả có email công khai trên hồ sơ GitHub mặc định nhận thông báo điểm cho đến khi hủy đăng ký — tối đa một thư mỗi 72 giờ trên mọi repo. Đăng nhập để dùng email đã xác minh hoặc quản lý tùy chọn.",
    authNote: "Ủy quyền GitHub chỉ đọc email chính đã xác minh của bạn. Chỉ đăng nhập sẽ không đăng ký.",
    signIn: "Đăng nhập bằng GitHub",
    needAuthTitle: "Cần ủy quyền email",
    needAuthBody: "Hãy cấp quyền Email addresses: read cho ghfind Review rồi đăng nhập lại.",
    signInAgain: "Đăng nhập lại",
    noEmailTitle: "Không có email chính đã xác minh",
    noEmailBody: "Hãy xác minh email chính trong cài đặt GitHub rồi thử lại.",
    prefsTitle: "Tùy chọn email tác giả",
    subscribed: "Đã đăng ký",
    notSubscribed: "Chưa đăng ký",
    prefsBody: "Nhận điểm hồ sơ công khai và thứ hạng ghfind cho issue và PR mới. Đây không phải ước tính thời gian review.",
    emailLanguage: "Ngôn ngữ email",
    consent: "Tôi đồng ý nhận thông báo tác giả qua email chính đã xác minh trên GitHub, tối đa một lần mỗi 72 giờ trên mọi repo.",
    save: "Lưu đăng ký",
    unsubscribe: "Hủy đăng ký",
  },
  setup: {
    title: "Trạng thái cài đặt",
    openFromGitHub: "Hãy mở trang này từ phần cài đặt GitHub App.",
    receivedTitle: "Đã nhận bản cài đặt",
    receivedBody: "Việc khởi tạo nhãn chạy tự động ở chế độ nền. Đăng nhập để xem repo và trạng thái tác vụ.",
    signIn: "Đăng nhập bằng GitHub",
    refresh: "Tải lại để xem tiến độ. Chỉ hiển thị các repo bạn có quyền truy cập.",
    repository: "Repo",
    task: "Tác vụ",
    status: "Trạng thái",
    action: "Thao tác",
    empty: "Đang tìm tác vụ khởi tạo, hoặc chưa có tác vụ nào cho các repo bạn truy cập được.",
    retry: "Thử lại (quản trị)",
    kinds: { discover: "Khám phá", initialize: "Khởi tạo nhãn", label: "Gắn nhãn" },
    states: { pending: "Đang chờ", running: "Đang chạy", done: "Xong", failed: "Lỗi", cancelled: "Đã hủy" },
  },
};

const ar: Messages = {
  nav: { site: "ghfind.com", language: "اللغة", theme: "المظهر", auto: "تلقائي", light: "فاتح", dark: "داكن" },
  footer: { source: "الشيفرة والدعم", privacy: "الخصوصية", emails: "رسائل الكاتب" },
  home: {
    eyebrow: "تطبيق GitHub · مجاني",
    title: "رتّب الـ issues والـ PRs حسب من فتحها",
    subtitle:
      "يضيف ghfind Review وسم review: ملوّنًا إلى كل issue و pull request جديد، استنادًا إلى درجة ghfind العامة للكاتب. لا workflow ولا رمز وصول ولا أسرار تحتاج إلى إعداد.",
    install: "التثبيت على GitHub",
    notOpen: "التثبيت غير متاح بعد.",
    learnMore: "اعرف المزيد على ghfind.com",
    rollout: "نطاق الإتاحة الحالي: {accounts}",
    labelsHeading: "خمسة وسوم، ونظرة واحدة",
    labelsLead: "تُنشأ الوسوم الناقصة عند التثبيت، وتبقى الألوان أو الأوصاف التي خصّصتها كما هي.",
    ranges: { low: "0 – 39", medium: "40 – 69", high: "70 – 89", top: "90 – 100", noScore: "بلا درجة" },
    labelsNote: "تصف الدرجة ملف الكاتب العام على GitHub، وليست مراجعة للشيفرة ولا قرار دمج، و«بلا درجة» لا تعني صفرًا.",
    stepsHeading: "كيف يعمل",
    steps: {
      install: { title: "التثبيت على مستودعات محددة", body: "امنح صلاحية القراءة والكتابة لـ Issues و Pull requests. اختر Only select repositories للبدء على نطاق صغير." },
      open: { title: "يفتح أحدهم issue أو PR", body: "يبحث البوت في الخلفية عن درجة ghfind العامة للكاتب. لا يُقرأ نص الـ issue ولا يُقيَّم أبدًا." },
      label: { title: "يظهر وسم review:", body: "يضيف الوسوم فقط، ولا يعلّق أو يغلق أو يحظر أي مساهمة." },
    },
    permissions: {
      title: "الصلاحيات والبيانات",
      body: "لا شيفرة مصدرية ولا نصوص issues ولا شيفرة PRs. يحتفظ فقط بالتثبيت والمستودع ورقم الـ issue والدرجة وحالة المهمة، وتُحذف المهام المكتملة بعد 30 يومًا.",
    },
    emails: {
      title: "رسائل الدرجة للكتّاب",
      body: "قد يتلقى الكتّاب ذوو البريد العام على GitHub رسالة درجة واحدة كل 72 ساعة كحد أقصى عبر المستودعات، مع إلغاء اشتراك بنقرة واحدة.",
      link: "إدارة تفضيلات البريد",
    },
    migrate: { title: "تنتقل من workflow الخاص بـ Actions؟", body: "عطّل workflow القديم PR review level حتى لا تُوسَم المساهمة نفسها مرتين." },
  },
  privacy: {
    title: "الخصوصية",
    paragraphs: [
      "يرسل GitHub أحداث التثبيت والـ issues والـ pull requests وتعليقات الـ issues. نتحقق من كل حدث ونحتفظ فقط بمعرّفات التثبيت والمستودع وأسماء المستودعات وأرقام الـ issues أو الـ PRs والدرجات وحالة المهام. يُفحص نص التعليق فقط لمعرفة ما إذا كان يذكر هذا التطبيق، ولا يُخزَّن أبدًا.",
      "يُرسَل اسم دخول الكاتب إلى ghfind للحصول على درجة ملفه العام. لا تُخزَّن نصوص الـ issues والـ PRs ولا شيفرتها ولا تُرسل للتقييم. يكتب التطبيق الوسوم فقط ولا ينشر تعليقات.",
      "تنتهي سجلات المهام المكتملة بعد 30 يومًا، وتبقى سجلات المهام الفاشلة حتى يعالجها أحد المشغّلين. تنتهي جلسات لوحة المتابعة بعد ساعة، وتُشفَّر رموز مستخدمي GitHub عند التخزين. إلغاء تثبيت التطبيق يوقف الوصول إلى المستودعات ويُبقي الوسوم الحالية.",
      "تُرسل رسائل الدرجة افتراضيًا عندما يحتوي ملف الكاتب الحالي على GitHub على بريد عام. لا تُستخدم عناوين البريد في الـ commits أبدًا. يمكن للكاتب بدلًا من ذلك تفويض بريده الأساسي الموثّق. تُشفَّر العناوين وتُحفظ سجلات البريد 30 يومًا. يؤدي إلغاء الاشتراك إلى حذف العنوان المخزَّن وإلغاء الرسائل المعلّقة والاحتفاظ بمعرّف مستخدم GitHub كسجل دائم لإيقاف الإرسال؛ وقد تصل رسالة كانت قيد الإرسال بالفعل. لا يُعاد إرسال الرسائل غير المؤكد تسليمها تلقائيًا.",
      "لطلبات الحذف، تواصل مع المشرفين عبر مستودع الشيفرة المصدرية.",
    ],
  },
  unsubscribe: { title: "إلغاء الاشتراك", button: "إيقاف رسائل الكاتب", doneTitle: "تم إلغاء الاشتراك", doneBody: "تمت إزالة اشتراكك بالبريد." },
  notifications: {
    disabledTitle: "رسائل الكاتب",
    disabledBody: "إشعارات البريد غير مفعّلة بعد.",
    title: "درجتك في ghfind، في بريدك",
    body: "يتلقى الكتّاب الذين لديهم بريد عام في ملفهم على GitHub إشعارات الدرجة افتراضيًا حتى يلغوا الاشتراك — رسالة واحدة كل 72 ساعة كحد أقصى عبر المستودعات. سجّل الدخول لاستخدام بريدك الموثّق أو لإدارة التفضيلات.",
    authNote: "يقرأ تفويض GitHub بريدك الأساسي الموثّق فقط. تسجيل الدخول وحده لا يشترك بك.",
    signIn: "تسجيل الدخول عبر GitHub",
    needAuthTitle: "يلزم تفويض البريد",
    needAuthBody: "امنح ghfind Review صلاحية Email addresses: read ثم سجّل الدخول مجددًا.",
    signInAgain: "تسجيل الدخول مجددًا",
    noEmailTitle: "لا يوجد بريد أساسي موثّق",
    noEmailBody: "وثّق بريدك الأساسي في إعدادات GitHub ثم حاول مرة أخرى.",
    prefsTitle: "تفضيلات بريد الكاتب",
    subscribed: "مشترك",
    notSubscribed: "غير مشترك",
    prefsBody: "استلم درجة ملفك العام وترتيبك في ghfind للـ issues والـ PRs الجديدة. هذا ليس تقديرًا لوقت المراجعة.",
    emailLanguage: "لغة البريد",
    consent: "أوافق على تلقي إشعارات الكاتب على بريدي الأساسي الموثّق في GitHub، مرة واحدة كل 72 ساعة كحد أقصى عبر المستودعات.",
    save: "حفظ الاشتراك",
    unsubscribe: "إلغاء الاشتراك",
  },
  setup: {
    title: "حالة التثبيت",
    openFromGitHub: "افتح هذه الصفحة من إعدادات تثبيت تطبيق GitHub.",
    receivedTitle: "تم استلام التثبيت",
    receivedBody: "تجري تهيئة الوسوم تلقائيًا في الخلفية. سجّل الدخول لرؤية المستودعات وحالة المهام.",
    signIn: "تسجيل الدخول عبر GitHub",
    refresh: "حدّث الصفحة لمتابعة التقدم. تظهر فقط المستودعات التي يمكنك الوصول إليها.",
    repository: "المستودع",
    task: "المهمة",
    status: "الحالة",
    action: "الإجراء",
    empty: "ما زال اكتشاف التهيئة جاريًا، أو لا توجد مهام بعد للمستودعات المتاحة لك.",
    retry: "إعادة المحاولة (مسؤول)",
    kinds: { discover: "اكتشاف", initialize: "تهيئة الوسوم", label: "وسم" },
    states: { pending: "قيد الانتظار", running: "قيد التشغيل", done: "مكتملة", failed: "فشلت", cancelled: "أُلغيت" },
  },
};

export const MESSAGES: Record<Locale, Messages> = { en, zh, ja, ko, es, pt, id, vi, ar };
