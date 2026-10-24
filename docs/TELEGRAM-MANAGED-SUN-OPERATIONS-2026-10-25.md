# SUN — Telegram notification managed runtime (2026-10-25)

## Installation boundaries

- Target machine: SUN; application copy: %LOCALAPPDATA%\Development-Autopilot\app.
- Isolated SQLite: %LOCALAPPDATA%\Development-Autopilot\data\autopilot.sqlite3; initialized with GLOBAL STOP enabled. The original Autopilot/WatchTower/Chrome data remains untouched.
- Entrypoint: app\local\telegram-managed-runtime.mjs; dashboard http://127.0.0.1:48173/; user-logon Windows Scheduled Task DevelopmentAutopilot-Telegram-SUN (least privilege).
- Security guard: config\exposed-token.sha256 stores only a SHA-256 of the token previously disclosed in chat. Bot secret and private chat ID remain only in the logged-in Windows Credential Manager, DevelopmentAutopilot/TelegramNotifications/v1.
- While that exposed token is enrolled, Telegram is DISABLED even if dashboard is running. A newly rotated private token matching verified bot @Johnny0109bot allows the manager to restart with Telegram enabled. The manager never uses SMS or inbound message approvals.
- Runtime status: run\status.json stores only safe state, update time, port, global stop and Workstream count. A port conflict does not terminate unrelated processes.

## Verified versus pending

- Earlier one-shot authorized real Telegram canary: API accepted and the user confirmed receipt in their own phone Telegram private chat — PASS.
- The bot token recorded in chat matched the credential enrolled at the most recent explicit audit. NEVER start continuous sending using the exposed key.
- Owner must revoke/rotate the old bot token in @BotFather, privately register the replacement via the SUN desktop shortcut 'Autopilot Telegram 재등록', and send /start to the bot again if the private chat is not listed. Never paste the token into chat, Git, process arguments or log files.
- After registration, the manager retries identity checks at approximately 1-minute intervals, then starts Telegram-enabled mode automatically. RUNNING_TELEGRAM_ENABLED in status.json indicates active bot dispatch, not proof of a new received event or lock-screen push.
- New isolated SQLite initially has 0 Workstreams. Actual CI/blocker/approval alerts require correctly registering Workstreams and GitHub/Watchtower sources. Notification channel activation does not provide monitoring of unrelated repositories automatically.
- Draft PR stack remains unmerged. This installed copy is an isolated opt-in SUN acceptance environment, not an authorized PR merge.

## Safe local status commands

PowerShell:
  Get-Content "$env:LOCALAPPDATA\Development-Autopilot\run\status.json"
  Get-ScheduledTask -TaskName DevelopmentAutopilot-Telegram-SUN
  Start-Process 'http://127.0.0.1:48173/'

To stop future starts: Disable-ScheduledTask and Stop-ScheduledTask for DevelopmentAutopilot-Telegram-SUN; confirm no child server remains. Updating/deleting actual production DBs is out of scope.
