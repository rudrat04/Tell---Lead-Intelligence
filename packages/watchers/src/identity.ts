/**
 * Who our crawler says it is (plan 5d: honest User-Agent). Set once at startup from the pack's operator section,
 * so each self-hosted copy identifies as itself, and robots.txt rules naming that bot are honoured.
 */
let bot = { name: "TellLeadIntelligence", contactUrl: "https://github.com/rudrat04/Tell---Lead-Intelligence" };

export function setBotIdentity(name: string, contactUrl: string): void {
  bot = { name, contactUrl };
}

export const botToken = (): string => bot.name;
export const userAgent = (): string => `${bot.name}/0.1 (+${bot.contactUrl}; respects robots.txt)`;
