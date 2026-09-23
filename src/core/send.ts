import { context, reddit, settings } from '@devvit/web/server';
import type { WatchResult } from './match';
import { DIGEST_MAX, digest, digestHtml } from './match';
import { loadConfig, rememberSent, runWatch } from './watch';

const DEFAULT_FROM = 'Reddit watch <reddit@notification.yoonet.io>';

async function emailSettings() {
  return {
    apiKey: await settings.get<string>('resendApiKey'),
    from: (await settings.get<string>('emailFrom')) || DEFAULT_FROM,
    to: await settings.get<string>('emailTo'),
  };
}

/** Resend first. Throws with the reason if the key or address is missing, or if
 * the request fails, for example while Reddit has not yet approved the domain. */
async function sendEmail(result: WatchResult): Promise<void> {
  const { apiKey, from, to } = await emailSettings();
  if (!apiKey || !to) throw new Error('email not configured (resendApiKey or emailTo unset)');
  const { subject, body } = digest(result);
  const first = result.hits[0]?.id ?? 'none';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `reddit-watch-${new Date().toISOString().slice(0, 10)}-${first}-${result.hits.length}`,
    },
    body: JSON.stringify({
      from,
      to: to.split(',').map((a) => a.trim()).filter(Boolean),
      subject,
      html: digestHtml(result),
      text: body,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sendModmail(result: WatchResult): Promise<void> {
  const { subject, body } = digest(result);
  await reddit.modMail.createModNotification({
    subject,
    bodyMarkdown: body,
    subredditId: context.subredditId,
  });
}

/** The real run: search, send by email (modmail if email fails), then remember
 * what was sent. Returns how many posts went out and by which route. */
export async function scanAndSend(): Promise<{ sent: number; via: string }> {
  const config = await loadConfig();
  const result = await runWatch(config);
  console.log(
    `watch: ${result.hits.length} new, ${result.droppedLoose} loose dropped, ${result.alreadySeen} already sent`
  );
  if (!result.hits.length) return { sent: 0, via: 'none' };

  let via = 'email';
  try {
    await sendEmail(result);
  } catch (err) {
    console.error(`email failed, using modmail: ${String(err)}`);
    await sendModmail(result);
    via = 'modmail';
  }
  const shown = result.hits.slice(0, DIGEST_MAX);
  await rememberSent(shown);
  console.log(`sent ${shown.length} by ${via}`);
  return { sent: shown.length, via };
}

/** Log only, nothing sent or remembered. Runs on install and upgrade so a
 * playtest shows what the next real run would find. */
export async function dryRun(): Promise<void> {
  const config = await loadConfig();
  const result = await runWatch(config);
  const { apiKey, from, to } = await emailSettings();
  console.log(
    `dry run: terms ${JSON.stringify(config.terms)}, ${result.searched} searched, ${result.hits.length} would send, ${result.droppedLoose} loose dropped`
  );
  console.log(`email: key ${apiKey ? 'set' : 'MISSING'}, to ${to ? 'set' : 'MISSING'}, from ${from}`);
  for (const h of result.hits) {
    console.log(
      `  ${h.createdAt.toISOString().slice(0, 10)} r/${h.subreddit} [${h.matched.join(', ')}] ${h.title} ${h.url}`
    );
  }
}
