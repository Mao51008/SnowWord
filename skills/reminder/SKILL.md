# Reminder Skill

## When to Use

- User says "remind me...", "at what time...", "every day..." -> use `schedule_reminder`
- User asks "what reminders do I have" -> use `list_reminders`
- User says "cancel reminder" -> use `manage_reminder`

## Schedule Type Rules

- If the user says "X seconds/minutes/hours later", "tomorrow", "tonight", or any other one-time point in time, use `schedule_type="once"`.
- Only use `schedule_type="interval"` when the user explicitly wants repetition, such as "every 30 minutes", "every day", or "repeat regularly".
- Use `schedule_type="cron"` for calendar-style recurring reminders like "every day at 8am" or "every Monday at 9am".
- Do not turn a one-time delay into a recurring reminder.

## Reminder Types

| Type | When to Use | Example |
|------|-------------|---------|
| `medicine` | Medication reminders | "Time to take your blood pressure medicine" |
| `exercise` | Exercise reminders | "Time for morning exercises" |
| `water` | Hydration reminders | "Remember to drink water" |
| `custom` | Other reminders | "Doctor appointment at 3pm" |

## Cron Format

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 are Sunday)
│ │ │ │ │
* * * * *
```

Common examples:
- Daily at 8am: `0 8 * * *`
- Daily at 2pm: `0 14 * * *`
- Every 2 hours: `0 */2 * * *`
- Every 30 minutes: `*/30 * * * *`

## Best Practices

- When setting reminders, use `voice_text` to clearly state what to do
- Do not set too many simultaneous reminders to avoid disturbance
- Schedule reminders at times that fit the user's daily routine
- For elderly users, prefer gentle reminders in the morning and early afternoon
- Never set medical-related reminders without explicit user confirmation
