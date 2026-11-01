-- Vibe42 asked for their tagline in the sponsor title, the rest of the 0031
-- copy as the description, and their App Store icon as the logo.
UPDATE sponsorships
SET sponsor_name = 'Vibe42 - 无需配置、永远在线的 AI 工作台',
    description = '随时随地、支持任何设备，出门也可以开心 Vibe Coding',
    icon_url = '/vibe42.webp',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'sponsor-vibe42';

INSERT INTO sponsorship_translations (sponsorship_id, locale, sponsor_name, description) VALUES
  ('sponsor-vibe42', 'en', 'Vibe42 - The zero-setup, always-on AI workspace', 'Anywhere, on any device — happy vibe coding even on the go'),
  ('sponsor-vibe42', 'zh', 'Vibe42 - 无需配置、永远在线的 AI 工作台', '随时随地、支持任何设备，出门也可以开心 Vibe Coding'),
  ('sponsor-vibe42', 'ja', 'Vibe42 - 設定不要、常時オンラインの AI ワークスペース', 'いつでもどこでも、どのデバイスでも、外出先でも楽しく Vibe Coding'),
  ('sponsor-vibe42', 'ko', 'Vibe42 - 설정 없이 항상 켜져 있는 AI 워크스페이스', '언제 어디서나 어떤 기기로든, 밖에서도 즐겁게 Vibe Coding'),
  ('sponsor-vibe42', 'es', 'Vibe42 - El espacio de trabajo de IA siempre activo y sin configuración', 'Desde cualquier lugar y dispositivo: vibe coding también fuera de casa'),
  ('sponsor-vibe42', 'pt', 'Vibe42 - O espaço de trabalho de IA sempre ativo e sem configuração', 'Em qualquer lugar e dispositivo: vibe coding até fora de casa'),
  ('sponsor-vibe42', 'id', 'Vibe42 - Ruang kerja AI tanpa konfigurasi yang selalu aktif', 'Kapan saja, di perangkat apa pun — tetap asyik vibe coding di luar rumah'),
  ('sponsor-vibe42', 'vi', 'Vibe42 - Không gian làm việc AI luôn trực tuyến, không cần cấu hình', 'Mọi lúc mọi nơi, trên mọi thiết bị — ra ngoài vẫn vui vẻ vibe coding'),
  ('sponsor-vibe42', 'ar', 'Vibe42 - مساحة عمل ذكاء اصطناعي دائمة الاتصال دون أي إعداد', 'في أي وقت ومن أي جهاز — استمتع بالـ Vibe Coding حتى خارج المنزل')
ON CONFLICT (sponsorship_id, locale) DO UPDATE SET
  sponsor_name = excluded.sponsor_name,
  description = excluded.description;
