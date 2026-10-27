-- Vibe42 asked for new sponsor copy in place of the line seeded by 0029.
UPDATE sponsorships
SET description = '无需配置、永远在线的 AI 工作台。随时随地、支持任何设备，出门也可以开心 Vibe Coding',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'sponsor-vibe42';

INSERT INTO sponsorship_translations (sponsorship_id, locale, sponsor_name, description) VALUES
  ('sponsor-vibe42', 'en', NULL, 'The zero-setup, always-on AI workspace. Anywhere, on any device — happy vibe coding even on the go'),
  ('sponsor-vibe42', 'zh', NULL, '无需配置、永远在线的 AI 工作台。随时随地、支持任何设备，出门也可以开心 Vibe Coding'),
  ('sponsor-vibe42', 'ja', NULL, '設定不要、常時オンラインの AI ワークスペース。いつでもどこでも、どのデバイスでも、外出先でも楽しく Vibe Coding'),
  ('sponsor-vibe42', 'ko', NULL, '설정 없이 항상 켜져 있는 AI 워크스페이스. 언제 어디서나 어떤 기기로든, 밖에서도 즐겁게 Vibe Coding'),
  ('sponsor-vibe42', 'es', NULL, 'El espacio de trabajo de IA siempre activo y sin configuración. Desde cualquier lugar y dispositivo: vibe coding también fuera de casa'),
  ('sponsor-vibe42', 'pt', NULL, 'O espaço de trabalho de IA sempre ativo e sem configuração. Em qualquer lugar e dispositivo: vibe coding até fora de casa'),
  ('sponsor-vibe42', 'id', NULL, 'Ruang kerja AI tanpa konfigurasi yang selalu aktif. Kapan saja, di perangkat apa pun — tetap asyik vibe coding di luar rumah'),
  ('sponsor-vibe42', 'vi', NULL, 'Không gian làm việc AI luôn trực tuyến, không cần cấu hình. Mọi lúc mọi nơi, trên mọi thiết bị — ra ngoài vẫn vui vẻ vibe coding'),
  ('sponsor-vibe42', 'ar', NULL, 'مساحة عمل ذكاء اصطناعي دائمة الاتصال دون أي إعداد. في أي وقت ومن أي جهاز — استمتع بالـ Vibe Coding حتى خارج المنزل')
ON CONFLICT (sponsorship_id, locale) DO UPDATE SET description = excluded.description;
