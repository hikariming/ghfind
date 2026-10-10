-- Per-locale sponsor copy. NULL columns fall back to the sponsorships row,
-- so brand names that never change can be left NULL. Rows for sponsors that
-- don't exist in an environment are skipped by the INSERT ... SELECT guard.
CREATE TABLE IF NOT EXISTS sponsorship_translations (
  sponsorship_id TEXT NOT NULL REFERENCES sponsorships(id) ON DELETE CASCADE,
  locale         TEXT NOT NULL,
  sponsor_name   TEXT,
  description    TEXT,
  PRIMARY KEY (sponsorship_id, locale)
);

INSERT OR IGNORE INTO sponsorship_translations (sponsorship_id, locale, sponsor_name, description)
SELECT v.column1, v.column2, v.column3, v.column4
FROM (VALUES
  ('sponsor-modaleap-recruiting', 'en', 'ModaLeap is hiring', 'Let''s build China''s boldest real-world AI deployments!'),
  ('sponsor-modaleap-recruiting', 'zh', 'ModaLeap 大量岗位招聘', '一起搞中国最夯的 AI 产业落地！'),
  ('sponsor-modaleap-recruiting', 'ja', 'ModaLeap 積極採用中', '中国で最も熱い AI の産業実装を一緒に！'),
  ('sponsor-modaleap-recruiting', 'ko', 'ModaLeap 대규모 채용 중', '중국에서 가장 뜨거운 AI 산업 적용을 함께 만들어요!'),
  ('sponsor-modaleap-recruiting', 'es', 'ModaLeap está contratando', '¡Construyamos juntos la IA aplicada más potente de China!'),
  ('sponsor-modaleap-recruiting', 'pt', 'ModaLeap está contratando', 'Vamos construir juntos a IA aplicada mais forte da China!'),
  ('sponsor-modaleap-recruiting', 'id', 'ModaLeap sedang merekrut', 'Bersama wujudkan penerapan AI industri paling keren di Tiongkok!'),
  ('sponsor-modaleap-recruiting', 'vi', 'ModaLeap đang tuyển dụng', 'Cùng đưa AI vào ngành công nghiệp mạnh mẽ nhất Trung Quốc!'),
  ('sponsor-modaleap-recruiting', 'ar', 'ModaLeap توظّف الآن', 'لنبنِ معًا أقوى تطبيقات الذكاء الاصطناعي الصناعية في الصين!'),
  ('seed-sponsor-lobehub', 'en', NULL, 'Your Chief Agent Operator'),
  ('seed-sponsor-lobehub', 'zh', NULL, '你的首席 Agent 操作官'),
  ('seed-sponsor-lobehub', 'ja', NULL, 'あなたのチーフ Agent オペレーター'),
  ('seed-sponsor-lobehub', 'ko', NULL, '당신의 최고 Agent 운영자'),
  ('seed-sponsor-lobehub', 'es', NULL, 'Tu operador jefe de agentes'),
  ('seed-sponsor-lobehub', 'pt', NULL, 'Seu operador-chefe de agentes'),
  ('seed-sponsor-lobehub', 'id', NULL, 'Operator Agent utama Anda'),
  ('seed-sponsor-lobehub', 'vi', NULL, 'Người vận hành Agent chủ lực của bạn'),
  ('seed-sponsor-lobehub', 'ar', NULL, 'مشغّل الوكلاء الرئيسي لديك'),
  ('seed-sponsor-ds-harness-remote', 'en', NULL, 'Connect once, use Harness remotely anytime'),
  ('seed-sponsor-ds-harness-remote', 'zh', NULL, '一次连接，随时远程使用 Harness'),
  ('seed-sponsor-ds-harness-remote', 'ja', NULL, '一度つなげば、いつでもリモートで Harness を'),
  ('seed-sponsor-ds-harness-remote', 'ko', NULL, '한 번 연결로 언제든 원격으로 Harness 사용'),
  ('seed-sponsor-ds-harness-remote', 'es', NULL, 'Conéctate una vez y usa Harness en remoto cuando quieras'),
  ('seed-sponsor-ds-harness-remote', 'pt', NULL, 'Conecte uma vez e use o Harness remotamente quando quiser'),
  ('seed-sponsor-ds-harness-remote', 'id', NULL, 'Sekali terhubung, pakai Harness dari jauh kapan saja'),
  ('seed-sponsor-ds-harness-remote', 'vi', NULL, 'Kết nối một lần, dùng Harness từ xa mọi lúc'),
  ('seed-sponsor-ds-harness-remote', 'ar', NULL, 'اتصل مرة واحدة واستخدم Harness عن بُعد في أي وقت'),
  ('seed-sponsor-mosoo', 'en', NULL, 'Cloud runtime for coding agents'),
  ('seed-sponsor-mosoo', 'zh', NULL, 'Coding Agent 云上运行时'),
  ('seed-sponsor-mosoo', 'ja', NULL, 'コーディング Agent のクラウドランタイム'),
  ('seed-sponsor-mosoo', 'ko', NULL, '코딩 Agent를 위한 클라우드 런타임'),
  ('seed-sponsor-mosoo', 'es', NULL, 'Runtime en la nube para agentes de código'),
  ('seed-sponsor-mosoo', 'pt', NULL, 'Runtime em nuvem para agentes de código'),
  ('seed-sponsor-mosoo', 'id', NULL, 'Runtime cloud untuk coding agent'),
  ('seed-sponsor-mosoo', 'vi', NULL, 'Môi trường chạy đám mây cho coding agent'),
  ('seed-sponsor-mosoo', 'ar', NULL, 'بيئة تشغيل سحابية لوكلاء البرمجة'),
  ('seed-sponsor-phi-browser', 'en', NULL, 'The open-source AI browser that truly gets you'),
  ('seed-sponsor-phi-browser', 'zh', NULL, '真正懂你的开源 AI 浏览器'),
  ('seed-sponsor-phi-browser', 'ja', NULL, 'あなたを本当に理解するオープンソース AI ブラウザ'),
  ('seed-sponsor-phi-browser', 'ko', NULL, '당신을 진짜 이해하는 오픈소스 AI 브라우저'),
  ('seed-sponsor-phi-browser', 'es', NULL, 'El navegador de IA open source que de verdad te entiende'),
  ('seed-sponsor-phi-browser', 'pt', NULL, 'O navegador de IA open source que realmente te entende'),
  ('seed-sponsor-phi-browser', 'id', NULL, 'Browser AI open source yang benar-benar memahami Anda'),
  ('seed-sponsor-phi-browser', 'vi', NULL, 'Trình duyệt AI mã nguồn mở thật sự hiểu bạn'),
  ('seed-sponsor-phi-browser', 'ar', NULL, 'متصفح ذكاء اصطناعي مفتوح المصدر يفهمك حقًا')
) AS v
WHERE v.column1 IN (SELECT id FROM sponsorships);
