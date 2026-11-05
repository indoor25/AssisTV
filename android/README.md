# AssisTV: To TV (Android)

A tiny Android app (≈40 KB, no ads, no trackers, Android 8+) that sends a movie title or a link to the
**"Watch later"** list of AssisTV through a Home Assistant webhook. How to use it and how to set up the webhook:
[docs/en/usage.md](../docs/en/usage.md#watch-later) · по-русски: [docs/usage.md](../docs/usage.md#посмотреть-позже).

What it adds to the phone:

- **"To TV"** in the menu of selected text (any app; Circle to Search shows only its own Copy and Translate);
- **"To TV"** in the Share menu;
- a quick-settings tile **"To TV"** that sends the clipboard;
- one settings screen: the webhook address and "Send the clipboard".

The only thing it does is `POST <webhook address>` with `{"text": "…"}`. The answer (what was found) comes as a
Home Assistant notification from the automation.

## Ready package

[AssisTV-To-TV.apk](AssisTV-To-TV.apk) — copy it to the phone and open it (allow installing from this source).
It is rebuilt by `build.ps1` together with the sources.

## Build

No Android Studio or Gradle — only **JDK 17** and the Android SDK command-line tools with
`platforms;android-35` and `build-tools;35.0.0`:

```powershell
sdkmanager --sdk_root=C:\android\sdk "platforms;android-35" "build-tools;35.0.0"
.\android\build.ps1 -Sdk C:\android\sdk -Jdk C:\android\jdk17 -Keystore C:\android\assistv-send.jks
```

The package is `android\AssisTV-To-TV.apk`. The signing key is created on the first build — keep it: an update
must be signed with the same key. Key password: environment variable `ASSISTV_KEY_PASS` (default `android`).

Install: copy the APK to the phone and open it, or `adb install -r android\AssisTV-To-TV.apk`.
The address can also be set over adb:
`adb shell am start -n io.github.indoor25.assistv.send/.SettingsActivity --es url "https://…/api/webhook/…"`.
