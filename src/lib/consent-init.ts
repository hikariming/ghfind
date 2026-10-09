/**
 * Google Consent Mode v2 defaults. Inlined in <head> before gtag.js loads on
 * both stacks (Next root layout + Astro Base), like THEME_INIT_SCRIPT.
 *
 * The global default is granted; EEA/UK/CH visitors start denied and rely on
 * a Google-certified CMP (Funding Choices, wired via the FUNDING_CHOICES_URL
 * envs) to push `gtag('consent', 'update', ...)` once they choose. Until
 * then GA4 only sends cookieless pings in those regions, which keeps EU user
 * consent compliance independent of when the CMP actually ships.
 */
export const CONSENT_INIT_SCRIPT = `
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
  ad_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
  analytics_storage: 'granted'
});
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  wait_for_update: 500,
  region: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IS','IE','IT','LV','LI','LT','LU','MT','NL','NO','PL','PT','RO','SK','SI','ES','SE','GB','CH']
});
`;
