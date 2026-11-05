package io.github.indoor25.assistv.send;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.widget.Toast;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Отправка текста на webhook Home Assistant: POST {"text": "..."}; ответ (что нашлось) HA присылает уведомлением. */
final class Sender {
    static final String PREFS = "settings";
    static final String KEY_URL = "webhook_url";

    private Sender() {}

    static String url(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_URL, "").trim();
    }

    static void saveUrl(Context c, String url) {
        SharedPreferences.Editor e = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        e.putString(KEY_URL, url == null ? "" : url.trim());
        e.apply();
    }

    /** Шлёт в фоне, по итогу — тост; done вызывается в потоке интерфейса (закрыть окно). */
    static void send(final Activity a, String raw, final Runnable done) {
        final String text = raw == null ? "" : raw.trim();
        final String url = url(a);
        if (url.isEmpty()) { toast(a, a.getString(R.string.no_url)); done.run(); return; }
        if (text.isEmpty()) { toast(a, a.getString(R.string.empty)); done.run(); return; }
        toast(a, a.getString(R.string.sending));
        final Context app = a.getApplicationContext();
        new Thread(() -> {
            String error = null;
            try {
                HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
                con.setConnectTimeout(10000);
                con.setReadTimeout(15000);
                con.setRequestMethod("POST");
                con.setDoOutput(true);
                con.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = ("{\"text\":" + json(text) + "}").getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = con.getOutputStream()) { os.write(body); }
                int code = con.getResponseCode();
                if (code < 200 || code >= 300) error = "HTTP " + code;
                con.disconnect();
            } catch (Exception e) {
                error = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
            }
            final String msg = error == null ? app.getString(R.string.sent) : app.getString(R.string.failed, error);
            a.runOnUiThread(() -> { toast(app, msg); done.run(); });
        }).start();
    }

    static void toast(Context c, String s) {
        Toast.makeText(c.getApplicationContext(), s, Toast.LENGTH_SHORT).show();
    }

    static String json(String s) {
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
                    else b.append(ch);
            }
        }
        return b.append('"').toString();
    }
}
