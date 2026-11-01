-- Vibe42 rebalanced their copy between title and description again, and sent
-- their own light iOS icon (public/vibe42-icon.webp) to replace the App Store
-- icon from 0032. New filename so cached copies of the old icon aren't served.
UPDATE sponsorships
SET sponsor_name = 'Vibe42 - 无需配置、永远在线',
    description = '随时随地、支持任何设备，出门也可以开心 Vibe Coding 的 AI 工作台',
    icon_url = '/vibe42-icon.webp',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'sponsor-vibe42';

INSERT INTO sponsorship_translations (sponsorship_id, locale, sponsor_name, description) VALUES
  ('sponsor-vibe42', 'en', 'Vibe42 - Zero setup, always on', 'The AI workspace for happy vibe coding anywhere, on any device — even on the go'),
  ('sponsor-vibe42', 'zh', 'Vibe42 - 无需配置、永远在线', '随时随地、支持任何设备，出门也可以开心 Vibe Coding 的 AI 工作台'),
  ('sponsor-vibe42', 'ja', 'Vibe42 - 設定不要、常時オンライン', 'いつでもどこでも、どのデバイスでも、外出先でも楽しく Vibe Coding できる AI ワークスペース'),
  ('sponsor-vibe42', 'ko', 'Vibe42 - 설정 없이, 항상 온라인', '언제 어디서나 어떤 기기로든, 밖에서도 즐겁게 Vibe Coding 하는 AI 워크스페이스'),
  ('sponsor-vibe42', 'es', 'Vibe42 - Sin configuración, siempre activo', 'El espacio de trabajo de IA para hacer vibe coding desde cualquier lugar y dispositivo, también fuera de casa'),
  ('sponsor-vibe42', 'pt', 'Vibe42 - Sem configuração, sempre ativo', 'O espaço de trabalho de IA para fazer vibe coding em qualquer lugar e dispositivo, até fora de casa'),
  ('sponsor-vibe42', 'id', 'Vibe42 - Tanpa konfigurasi, selalu aktif', 'Ruang kerja AI untuk asyik vibe coding kapan saja, di perangkat apa pun — bahkan di luar rumah'),
  ('sponsor-vibe42', 'vi', 'Vibe42 - Không cần cấu hình, luôn trực tuyến', 'Không gian làm việc AI để vui vẻ vibe coding mọi lúc mọi nơi, trên mọi thiết bị — kể cả khi ra ngoài'),
  ('sponsor-vibe42', 'ar', 'Vibe42 - بلا إعداد، متصل دائمًا', 'مساحة عمل الذكاء الاصطناعي للاستمتاع بالـ Vibe Coding في أي وقت ومن أي جهاز، حتى خارج المنزل')
ON CONFLICT (sponsorship_id, locale) DO UPDATE SET
  sponsor_name = excluded.sponsor_name,
  description = excluded.description;
