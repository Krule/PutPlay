ISSUES IN FOCUS

- [x] I encountered a problem where I was unable to switch audio track in MKV. → the webOS webview silently vetoes `enabled` writes for some MKV files; the engine now reads the switch back and only confirms when it landed — refusal says so and points at the HLS source (where switching works).
- [x] For some reason put.io is returning 429 on login... is there any chance that this program has a leak that's been hammering it? → yes: the OOB sign-in poll ran every 3s forever and swallowed 429s at the same cadence. Now bounded: 5-min code TTL, 429 stops the poll, errors back off (3s→15s cap), in-flight ticks can't resurrect a stopped poll.
