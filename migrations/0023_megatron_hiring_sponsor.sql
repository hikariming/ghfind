-- Paid hiring placement: Megatron 上海, listed right after ModaLeap.
-- Companies sort by is_sponsor DESC, display_order (ModaLeap = 0); jobs sort by
-- is_pinned DESC, display_order (ModaLeap's pinned roles = 0, 1). Applications
-- go by email; there is no public careers site.
INSERT INTO job_companies (id, name, website_url, logo_url, careers_url, is_sponsor, display_order, created_at, updated_at) VALUES
  ('megatron', 'Megatron 上海', NULL, '/megatron.png', NULL, 1, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT INTO jobs (id, company_id, apply_url, employment_types, status, is_pinned, display_order, expires_at, created_at, updated_at) VALUES
  ('megatron-product-manager', 'megatron', 'mailto:samael.han@megatron-sh.com?subject=%E5%BA%94%E8%81%98%EF%BC%9A%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86%EF%BC%88%E5%87%BA%E6%B5%B7%20AI%20API%20%E5%B9%B3%E5%8F%B0%EF%BC%89', 'full_time', 'open', 1, 2, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT INTO job_translations (job_id, locale, title, category, location, salary, summary) VALUES
  ('megatron-product-manager', 'zh', '产品经理（出海 AI API 平台）', '产品', '上海', '20–35K/月', '负责面向全球开发者的 AI API / Developer SaaS 产品，打通需求、研发交付、定价计费与增长闭环；英文读写熟练，3 年以上产品经验。'),
  ('megatron-product-manager', 'en', 'Product Manager, Global AI API Platform', 'Product', 'Shanghai', '¥20K–35K/mo', 'Own an AI API / developer SaaS product for global developers, from requirements and delivery to pricing, billing and growth. Fluent English, 3+ years in product.'),
  ('megatron-product-manager', 'ja', 'プロダクトマネージャー（グローバル AI API プラットフォーム）', 'プロダクト', '上海', '月 2万–3.5万元', '世界の開発者向け AI API / Developer SaaS を担当し、要件定義・開発・価格設計・課金・グロースまで一貫して推進します。英語の読み書きと 3 年以上の PM 経験。'),
  ('megatron-product-manager', 'ko', '프로덕트 매니저 (글로벌 AI API 플랫폼)', '프로덕트', '상하이', '월 2만–3.5만 위안', '글로벌 개발자를 위한 AI API / Developer SaaS를 맡아 요구사항, 개발 협업, 가격·과금, 성장까지 전 과정을 이끕니다. 영어 능숙, PM 경력 3년 이상.'),
  ('megatron-product-manager', 'es', 'Product Manager, plataforma global de API de IA', 'Producto', 'Shanghái', '¥20K–35K/mes', 'Lidera un producto de API de IA / SaaS para desarrolladores de todo el mundo: requisitos, entrega, precios, facturación y crecimiento. Inglés fluido, 3+ años en producto.'),
  ('megatron-product-manager', 'pt', 'Product Manager, plataforma global de API de IA', 'Produto', 'Xangai', '¥20K–35K/mês', 'Conduza um produto de API de IA / SaaS para desenvolvedores do mundo todo: requisitos, entrega, preços, cobrança e crescimento. Inglês fluente, 3+ anos em produto.'),
  ('megatron-product-manager', 'id', 'Product Manager, Platform API AI Global', 'Produk', 'Shanghai', '¥20K–35K/bulan', 'Pegang produk AI API / SaaS developer untuk developer global, dari kebutuhan dan pengembangan hingga harga, penagihan, dan pertumbuhan. Bahasa Inggris lancar, 3+ tahun di produk.'),
  ('megatron-product-manager', 'vi', 'Product Manager, nền tảng AI API toàn cầu', 'Sản phẩm', 'Thượng Hải', '¥20K–35K/tháng', 'Phụ trách sản phẩm AI API / Developer SaaS cho lập trình viên toàn cầu, từ yêu cầu, phát triển đến định giá, thanh toán và tăng trưởng. Tiếng Anh thành thạo, 3+ năm làm sản phẩm.'),
  ('megatron-product-manager', 'ar', 'مدير منتج، منصة واجهات برمجة الذكاء الاصطناعي العالمية', 'المنتج', 'شنغهاي', '20–35 ألف يوان شهريًا', 'قيادة منتج واجهات برمجة ذكاء اصطناعي / SaaS للمطورين حول العالم، من المتطلبات والتطوير إلى التسعير والفوترة والنمو. إنجليزية بطلاقة وخبرة 3+ سنوات في المنتج.');
