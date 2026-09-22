import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { scanAndSend } from '../core/send';

export const menu = new Hono();

menu.post('/run-now', async (c) => {
  try {
    const { sent, via } = await scanAndSend();
    return c.json<UiResponse>(
      {
        showToast: sent
          ? `Sent ${sent} new post${sent === 1 ? '' : 's'} by ${via}.`
          : 'Nothing new since the last run.',
      },
      200
    );
  } catch (err) {
    console.error('run-now failed', err);
    return c.json<UiResponse>({ showToast: 'Reddit watch failed, see the app logs.' }, 200);
  }
});
