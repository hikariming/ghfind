import { afterEach, describe, expect, it } from "vitest";
import { isBotRequest, isBotUserAgent, registerRequestProvider } from "../bot-user-agent";

const BROWSERS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
];

const BOTS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
  "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.122 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
  "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
  "Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
  "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
  "Twitterbot/1.0",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Discordbot/2.0; +https://discordapp.com",
  "github-camo (876de43e)",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse",
  "curl/8.10.1",
  "Wget/1.24.5",
  "python-requests/2.32.3",
  "Go-http-client/2.0",
  "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
  "axios/1.7.9",
  "okhttp/4.12.0",
  "Java/21.0.5",
  "Scrapy/2.11.2 (+https://scrapy.org)",
];

describe("isBotUserAgent", () => {
  it.each(BROWSERS)("treats a browser as human: %s", (ua) => {
    expect(isBotUserAgent(ua)).toBe(false);
  });

  it.each(BOTS)("treats a crawler or script as a bot: %s", (ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });

  it("treats a missing or blank User-Agent as a bot", () => {
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent("   ")).toBe(true);
  });
});

describe("isBotRequest", () => {
  afterEach(() => registerRequestProvider(() => null));

  const request = (ua?: string) =>
    new Request("https://ghfind.com/u/octocat", ua ? { headers: { "user-agent": ua } } : {});

  it("is false outside a request so scripts and cron keep normal caching", () => {
    registerRequestProvider(() => undefined);
    expect(isBotRequest()).toBe(false);
  });

  it("reads the User-Agent of the request being served", () => {
    let current = request(BROWSERS[0]);
    registerRequestProvider(() => current);
    expect(isBotRequest()).toBe(false);
    current = request(BOTS[0]);
    expect(isBotRequest()).toBe(true);
    current = request();
    expect(isBotRequest()).toBe(true);
  });

  it("is false when the provider throws", () => {
    registerRequestProvider(() => {
      throw new Error("outside a request");
    });
    expect(isBotRequest()).toBe(false);
  });
});
