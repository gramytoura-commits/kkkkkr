'use strict';

// Local development launcher: `npm run dev`.
//
// Sets friendly defaults for running on your own machine, then starts the normal
// server. Each default is only applied if you have not set it yourself (in the
// shell or in .env), so it never overrides an explicit choice.
//
//   - ALLOW_LOCAL_ADMIN=true  open /admin/ from localhost without Telegram sign-in
//   - DISABLE_TELEGRAM=true    no bot token needed; skips Telegram polling
//
// Cross-platform (works the same on Windows, macOS and Linux) with no extra
// dependencies. For a production-style run (Telegram enabled, auth enforced),
// use `npm start` instead.

if (process.env.ALLOW_LOCAL_ADMIN === undefined) process.env.ALLOW_LOCAL_ADMIN = 'true';
if (process.env.DISABLE_TELEGRAM === undefined) process.env.DISABLE_TELEGRAM = 'true';

require('../server').start();

console.log('Local dev mode: dashboard open at http://127.0.0.1:' + (process.env.PORT || 8787) + '/admin/');
