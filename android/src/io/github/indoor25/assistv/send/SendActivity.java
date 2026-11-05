package io.github.indoor25.assistv.send;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * Прозрачное окно без интерфейса: берёт текст и отправляет.
 *  - PROCESS_TEXT — пункт «На TV» в меню выделенного текста;
 *  - SEND — «Поделиться» → «На TV»;
 *  - ACTION_CLIP — плитка в шторке и кнопка в настройках: буфер обмена. Android 10+ даёт читать буфер только
 *    окну в фокусе, поэтому читаем в onWindowFocusChanged, а не в onCreate.
 */
public class SendActivity extends Activity {
    static final String ACTION_CLIP = "io.github.indoor25.assistv.send.CLIP";
    private boolean started;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent in = getIntent();
        String action = in != null ? in.getAction() : null;
        if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
            CharSequence t = in.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
            start(t == null ? "" : t.toString());
        } else if (Intent.ACTION_SEND.equals(action)) {
            String t = in.getStringExtra(Intent.EXTRA_TEXT);
            String subject = in.getStringExtra(Intent.EXTRA_SUBJECT);
            // YouTube и браузеры шлют ссылку в тексте и название в теме — аддону пригодится и то, и другое
            if (subject != null && t != null && !t.contains(subject)) t = subject + " " + t;
            start(t == null ? subject : t);
        } else if (!ACTION_CLIP.equals(action)) {
            finish();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus || started || getIntent() == null || !ACTION_CLIP.equals(getIntent().getAction())) return;
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        String text = "";
        ClipData clip = cm != null ? cm.getPrimaryClip() : null;
        if (clip != null && clip.getItemCount() > 0) {
            CharSequence t = clip.getItemAt(0).coerceToText(this);
            if (t != null) text = t.toString();
        }
        start(text);
    }

    private void start(String text) {
        started = true;
        Sender.send(this, text, this::finish);
    }
}
