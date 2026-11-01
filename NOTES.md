# Cultivation realm localization notes (PR #615)

Display-only realms. Scoring / stored Tier keys unchanged.

## English (canonical ladder)

Adjusted from the initial baseline toward the most widespread **Wuxiaworld / RMJI** English ladder
(A Record of a Mortal’s Journey to Immortality):

| # | zh | Chosen EN (≤22 in `realm.ts`) | Short | Notes |
|---|----|-------------------------------|-------|-------|
| 1 | 练气 | Qi Condensation | Qi Cond. | WW/RMJI; baseline “Qi Refining” is also common |
| 2 | 筑基 | Foundation Est. | Foundation | Full “Foundation Establishment” in `en.json` (23 chars) |
| 3 | 金丹 | Core Formation | Core Form. | Realm is 结丹; zh UI keeps familiar 金丹 |
| 4 | 元婴 | Nascent Soul | Nascent Soul | Unchanged |
| 5 | 化神 | Deity Transformation | Deity Trans. | RMJI abbreviation DT |
| 6 | 炼虚 | Spatial Tempering | Spatial Temp. | RMJI wiki; WW ch.127 also said “Void level” |
| 7 | 合体 | Body Integration | Body Integ. | Unchanged |
| 8 | 大乘 | Grand Ascension | Grand Asc. | RMJI/WW; baseline “Mahayana” is a Buddhist calque |

### Sources (term → URL)

| Term | URL |
|------|-----|
| Qi Condensation / realm ladder | https://rmji.wiki/faq/cultivation/ |
| Qi Condensation page | https://rmji.wiki/realms/qi-condensation/ |
| Foundation Establishment | https://rmji.wiki/realms/foundation-establishment/ |
| Cultivation realms (zh-hant table + EN) | https://rmji.wiki/zh-hant/realms/ |
| WW ch.127 lower/middle realm names | https://www.wuxiaworld.com/novel/rmji/rmji-chapter-127 |
| Chinese–English glossary | https://rmji.wiki/glossary/ |
| JA 練気→大乗 ladder | https://www.donghuafan.com/ja/donghua/record-of-mortal/puissance |
| JA syosetu glossary (煉気/築基/結丹…) | https://ncode.syosetu.com/n4157kr/41/ |
| KO 연기기→대승기 | https://m.blog.naver.com/yangyangoppa/223488613882 |
| KO murim/선협 기초 경지 | https://gall.dcinside.com/mgallery/board/view/?id=wuxiagame&no=1717 |
| VI Luyện Khí…Đại Thừa | https://rmji.wiki/vi/realms/ |
| VI tiên hiệp glossary | https://gaming.vn/tien-hiep-wiki/ |

## Other locales

- **ja**: 練気 / 築基 / **結丹** / 元嬰 / 化神 / **錬虚** / 合体 / 大乗
- **ko**: 연기기 / 축기기 / **결단기** / 원영기 / 화신기 / 연허기 / 합체기 / 대승기
- **vi**: Luyện Khí / Trúc Cơ / **Kết Đan** / Nguyên Anh / Hóa Thần / Luyện Hư / Hợp Thể / Đại Thừa
- **es / pt / id / ar**: calques aligned to the EN RMJI ladder, capped for UI width

## Profile theming

Whole `/u/[user]` page uses `data-realm` + `.profile-realm-theme` ambient glow, tinted section borders,
heading accents, radar, roast accents, rank card, and link hover. Brand orange reserved for global
brand / primary CTAs (对线, 留言, logo, sponsor).
