const RED_FLAG_LABELS = {
  new_account_mass_repos: {
    zh: "新账号短期创建大量仓库",
    en: "New account with unusually many repositories",
  },
  mostly_forks: {
    zh: "几乎全部仓库为 Fork",
    en: "Mostly forked repositories",
  },
  no_original_work: {
    zh: "没有非空原创仓库",
    en: "No non-empty original repositories",
  },
  mostly_empty_repos: {
    zh: "大部分仓库内容为空",
    en: "Mostly empty repositories",
  },
  follow_farming: {
    zh: "关注关系呈现异常增长特征",
    en: "Unusual follow-growth pattern",
  },
  ghost_profile: {
    zh: "公开资料与开发活动都很少",
    en: "Very little public profile or development activity",
  },
  burst_then_dormant: {
    zh: "短期爆发后长期沉寂",
    en: "Short activity burst followed by dormancy",
  },
  social_only_dormant_profile: {
    zh: "社交数据较高但开发活动长期沉寂",
    en: "Social-only profile with dormant development activity",
  },
  possible_star_inflation: {
    zh: "Star 分布存在异常膨胀迹象",
    en: "Possible star inflation",
  },
  trivial_pr_farming: {
    zh: "大量低实质 PR 贡献",
    en: "High volume of trivial pull requests",
  },
  templated_pr_flooding: {
    zh: "大量模板化 PR",
    en: "Templated pull-request flooding",
  },
  high_pr_rejection: {
    zh: "PR 拒绝率异常偏高",
    en: "Unusually high pull-request rejection rate",
  },
} as const;

export function scoreRedFlagLabel(flag: string, lang: "zh" | "en"): string {
  return RED_FLAG_LABELS[flag as keyof typeof RED_FLAG_LABELS]?.[lang] ??
    flag.replaceAll("_", " ");
}
