# SUN — Telegram notification managed runtime (2026-10-25)

## Installation boundaries

- Target machine: SUN; application copy: %LOCALAPPDATA%\Development-Autopilot\app.
- Isolated SQLite: %LOCALAPPDATA%\Development-Autopilot\data\autopilot.sqlite3; initialized with GLOBAL STOP enabled. The original Autopilot/WatchTower/Chrome data remains untouched.
- Entrypoint: app\local\telegram-managed-runtime.mjs; dashboard http://127.0.0.1:48173/; user-logon Windows Scheduled Task DevelopmentAutopilot-Telegram-SUN (least privilege).
- Security guard: config\exposed-token.sha256 stores only a SHA-256 of the token previously disclosed in chat. Bot secret and private chat ID remain only in the logged-in Windows Credential Manager, DevelopmentAutopilot/TelegramNotifications/v1.
- Default behavior: the exposed token is DISABLED unless SUN has an exact, user-authorized local approval marker `config\allow-existing-token.flag`. This file contains only the literal `USER_APPROVED_EXISTING_TELEGRAM_BOT_TOKEN` (never a secret), and is NOT bundled with source control. A rotated token also remains eligible. Either path requires live Bot API `getMe` identity verification for `@Johnny0109bot`. The manager never uses paid SMS or inbound message approvals.
- Runtime status: run\status.json stores only safe state, update time, port, global stop and Workstream count. A port conflict does not terminate unrelated processes.

## Verified versus pending

- Earlier one-shot authorized real Telegram canary: API accepted and the user confirmed receipt in their own phone Telegram private chat — PASS.
- At the previous credential audit the bot token matched the one disclosed in chat. On 2026-10-25 the user explicitly ordered the SUN setup to **keep using that existing token** and remove the extra block. A local opt-in marker was created on SUN, the task restarted, and the real localhost API plus managed status both verified `RUNNING_TELEGRAM_ENABLED` / `READY_APPROVED_EXISTING_TOKEN`. This records user authorization, not a claim that the disclosed credential is secure.
- The previously disclosed bot token remains vulnerable to third-party misuse. Rotation via @BotFather remains an optional security improvement, NOT a prerequisite imposed by the runtime now. If the user later wants to revoke this exact override, delete `config\allow-existing-token.flag` and restart the managed Windows task; the default exposed-token guard will apply again. Never paste any token into chat, Git, process arguments or logs.
- After registration, the manager retries identity checks at approximately 1-minute intervals, then starts Telegram-enabled mode automatically. RUNNING_TELEGRAM_ENABLED in status.json indicates active bot dispatch, not proof of a new received event or lock-screen push.
- New isolated SQLite initially has 0 Workstreams. Actual CI/blocker/approval alerts require correctly registering Workstreams and GitHub/Watchtower sources. Notification channel activation does not provide monitoring of unrelated repositories automatically.
- Draft PR stack remains unmerged. This installed copy is an isolated opt-in SUN acceptance environment, not an authorized PR merge.

## Safe local status commands

PowerShell:
  Get-Content "$env:LOCALAPPDATA\Development-Autopilot\run\status.json"
  Get-ScheduledTask -TaskName DevelopmentAutopilot-Telegram-SUN
  Start-Process 'http://127.0.0.1:48173/'

To stop future starts: Disable-ScheduledTask and Stop-ScheduledTask for DevelopmentAutopilot-Telegram-SUN; confirm no child server remains. Updating/deleting actual production DBs is out of scope.
